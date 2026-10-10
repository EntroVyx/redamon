import { createHash } from 'crypto'
import { isValidRange, satisfies } from '@/lib/semver'
import { ArchiveError, readArchive, type ReadArchive } from './archive'
import { CORE_SCREENS, PLUGIN_ICON_NAMES, UI_EXTENSION_POINTS } from './extensionPoints'
import { PLUGIN_PERMISSIONS } from './permissions'
import { PLUGIN_PLATFORM_VERSION } from './platformVersion'
import type { CatalogRelease } from './schemas/catalog'
import { parseManifest, type PluginManifest } from './schemas/manifest'
import { parseScreen, screenReferences, type ScreenNode } from './schemas/screen'
import { archiveMaxBytes } from './fetchRemote'
import { discardStaging, stageArchive } from './staging'

/**
 * The install checks of README.PLUGINS.md §9.3, in order; all must pass before anything
 * leaves staging. They run on the archive in memory, and the files are staged only after
 * the last one, so a refused archive writes nothing.
 *
 * A strict schema also refuses what a newer platform would accept (an extension point,
 * a UI primitive, a permission, a core screen or an icon this platform does not know).
 * Those references are collected from the raw JSON first, so such a plugin is refused
 * as `unknown_contribution` ("needs a newer RedAmon"), after the platform range check,
 * rather than as a broken file.
 */
export const INSTALL_CHECK_CODES = [
  'sha256_mismatch',
  'unsafe_archive',
  'manifest_mismatch',
  'schema_invalid',
  'platform_incompatible',
  'unknown_contribution',
] as const
export type InstallCheckCode = (typeof INSTALL_CHECK_CODES)[number]

const SCREEN_PRIMITIVES = new Set([
  'page', 'list', 'table', 'form', 'select', 'button', 'markdown', 'textDiff', 'badge', 'emptyState',
])

export interface InstallCheckInput {
  pluginId: string
  archiveBytes: Buffer
  /** The catalog release the archive must match (signed, so trusted). */
  release: CatalogRelease
  platformVersion?: string
  maxBytes?: number
}

export type InstallCheckResult =
  | { ok: true; manifest: PluginManifest; archive: ReadArchive; screens: Record<string, ScreenNode> }
  | { ok: false; code: InstallCheckCode; message: string; details?: string[] }

const fail = (code: InstallCheckCode, message: string, details?: string[]): InstallCheckResult => ({
  ok: false,
  code,
  message,
  ...(details?.length ? { details } : {}),
})

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function sameSet(a: unknown, b: unknown[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false
  const s = new Set(b)
  return a.every((x) => s.has(x)) && new Set(a).size === a.length
}

/** What the manifest and screens name that this platform does not have. */
function unknownReferences(raw: Record<string, unknown>, rawScreens: Record<string, unknown>): string[] {
  const out: string[] = []
  if (Array.isArray(raw.permissions)) {
    for (const p of raw.permissions) {
      if (typeof p === 'string' && !(PLUGIN_PERMISSIONS as readonly string[]).includes(p)) out.push(`permission ${p}`)
    }
  }
  if (isObj(raw.contributes)) {
    for (const [point, value] of Object.entries(raw.contributes)) {
      if (!(UI_EXTENSION_POINTS as readonly string[]).includes(point)) out.push(`extension point ${point}`)
      const items = Array.isArray(value) ? value : [value]
      for (const item of items) {
        if (!isObj(item)) continue
        if (typeof item.icon === 'string' && !(PLUGIN_ICON_NAMES as readonly string[]).includes(item.icon)) {
          out.push(`icon ${item.icon}`)
        }
        if (typeof item.coreScreen === 'string' && !(CORE_SCREENS as readonly string[]).includes(item.coreScreen)) {
          out.push(`core screen ${item.coreScreen}`)
        }
      }
    }
  }
  for (const [file, screen] of Object.entries(rawScreens)) {
    const stack: unknown[] = [screen]
    while (stack.length) {
      const node = stack.pop()
      if (!isObj(node)) continue
      if (typeof node.type === 'string' && !SCREEN_PRIMITIVES.has(node.type)) out.push(`UI primitive ${node.type} (${file})`)
      if (Array.isArray(node.children)) stack.push(...node.children)
    }
  }
  return [...new Set(out)]
}

function referencedScreens(raw: Record<string, unknown>): string[] {
  const out = new Set<string>()
  if (Array.isArray(raw.screens)) for (const s of raw.screens) if (typeof s === 'string') out.add(s)
  const nav = isObj(raw.contributes) ? raw.contributes.nav : undefined
  if (isObj(nav) && typeof nav.screen === 'string') out.add(nav.screen)
  if (Array.isArray(raw.actions)) {
    for (const a of raw.actions) if (isObj(a) && typeof a.resultScreen === 'string') out.add(a.resultScreen)
  }
  return [...out]
}

/** Cross-references the schemas cannot see: files exist, screens and actions are declared. */
function crossCheck(m: PluginManifest, files: Map<string, Buffer>, screens: Record<string, ScreenNode>): string[] {
  const errors: string[] = []
  const declared = new Set(m.actions.map((a) => a.id))
  const listed = new Set(m.screens ?? [])
  for (const a of m.actions) {
    const file = a.entry.split(':')[0]
    if (!files.has(file)) errors.push(`actions.${a.id}: ${file} is not in the archive`)
  }
  const mustList = [m.contributes?.nav?.screen, ...m.actions.map((a) => a.resultScreen)].filter(Boolean) as string[]
  for (const s of mustList) if (!listed.has(s)) errors.push(`${s} is used but not listed in screens`)
  for (const [file, node] of Object.entries(screens)) {
    const refs = screenReferences(node)
    for (const a of refs.actions) if (!declared.has(a)) errors.push(`${file}: no action "${a}" is declared`)
    for (const s of refs.screens) if (!listed.has(s)) errors.push(`${file}: opens ${s}, which is not listed in screens`)
  }
  return errors
}

export function runInstallChecks(input: InstallCheckInput): InstallCheckResult {
  const { pluginId, release } = input
  const platformVersion = input.platformVersion ?? PLUGIN_PLATFORM_VERSION

  // 1. The archive is the one the signed catalog pins.
  const sha = createHash('sha256').update(input.archiveBytes).digest('hex')
  if (sha !== release.sha256) {
    return fail('sha256_mismatch', `The archive's SHA-256 (${sha}) is not the one in the signed catalog.`)
  }

  // 2. Safe to unpack.
  let archive: ReadArchive
  try {
    archive = readArchive(input.archiveBytes, { pluginId, maxBytes: input.maxBytes ?? archiveMaxBytes() })
  } catch (e) {
    if (e instanceof ArchiveError) return fail('unsafe_archive', `The archive is not safe to unpack: ${e.message}.`)
    throw e
  }
  const files = new Map(archive.files.map((f) => [f.path, f.bytes]))

  // 3. plugin.json says what the catalog says.
  const manifestBytes = files.get('plugin.json')
  if (!manifestBytes) return fail('manifest_mismatch', 'The archive has no plugin.json at its top.')
  let raw: unknown
  try {
    raw = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    return fail('schema_invalid', 'plugin.json is not valid JSON.')
  }
  if (!isObj(raw)) return fail('schema_invalid', 'plugin.json is not a JSON object.')
  const mismatches: string[] = []
  if (raw.id !== pluginId) mismatches.push(`id ${JSON.stringify(raw.id)}, expected "${pluginId}"`)
  if (raw.version !== release.version) mismatches.push(`version ${JSON.stringify(raw.version)}, the catalog says ${release.version}`)
  if (raw.platform !== release.platform) mismatches.push(`platform ${JSON.stringify(raw.platform)}, the catalog says ${release.platform}`)
  if (raw.dataVersion !== release.dataVersion) {
    mismatches.push(`dataVersion ${JSON.stringify(raw.dataVersion)}, the catalog says ${release.dataVersion}`)
  }
  if (!sameSet(raw.permissions, release.permissions)) mismatches.push('permissions differ from the catalog')
  if (mismatches.length) {
    return fail('manifest_mismatch', 'plugin.json does not match the signed catalog entry.', mismatches)
  }

  // 4. Schemas (with the platform-newer references set aside for check 6).
  const rawScreens: Record<string, unknown> = {}
  const schemaErrors: string[] = []
  for (const s of referencedScreens(raw)) {
    const bytes = files.get(s)
    if (!bytes) {
      schemaErrors.push(`${s} is listed but not in the archive`)
      continue
    }
    try {
      rawScreens[s] = JSON.parse(bytes.toString('utf8'))
    } catch {
      schemaErrors.push(`${s}: not valid JSON`)
    }
  }
  const unknown = unknownReferences(raw, rawScreens)
  const parsed = parseManifest(raw)
  if (!parsed.ok) schemaErrors.push(...parsed.errors.map((e) => `plugin.json ${e}`))
  const screens: Record<string, ScreenNode> = {}
  for (const [file, value] of Object.entries(rawScreens)) {
    const r = parseScreen(value)
    if (r.ok) screens[file] = r.value
    else schemaErrors.push(...r.errors.map((e) => `${file} ${e}`))
  }
  if (parsed.ok && !unknown.length) schemaErrors.push(...crossCheck(parsed.value, files, screens))
  if (schemaErrors.length && !unknown.length) {
    return fail('schema_invalid', 'The plugin does not match the platform schemas.', schemaErrors)
  }

  // 5. The range includes this platform.
  const range = typeof raw.platform === 'string' ? raw.platform : ''
  if (!isValidRange(range)) return fail('schema_invalid', 'plugin.json platform is not a valid version range.')
  if (!satisfies(platformVersion, range)) {
    return fail(
      'platform_incompatible',
      `This plugin needs platform ${range}; this RedAmon runs platform ${platformVersion}.`,
    )
  }

  // 6. Everything it contributes exists here.
  if (unknown.length) {
    return fail(
      'unknown_contribution',
      `This plugin uses what this RedAmon does not have: ${unknown.join(', ')}. It needs a newer RedAmon.`,
      unknown,
    )
  }
  if (!parsed.ok) return fail('schema_invalid', 'The plugin does not match the platform schemas.', schemaErrors)
  return { ok: true, manifest: parsed.value, archive, screens }
}

/** The checks, then the files into `.staging/<operationId>/`; a refusal writes nothing. */
export async function checkAndStage(operationId: string, input: InstallCheckInput): Promise<InstallCheckResult> {
  const out = runInstallChecks(input)
  if (!out.ok) return out
  try {
    await stageArchive(operationId, out.archive)
  } catch (e) {
    await discardStaging(operationId).catch(() => {})
    throw e
  }
  return out
}
