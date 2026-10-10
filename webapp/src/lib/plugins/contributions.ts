import prisma from '@/lib/prisma'
import { contributionsUpdating, showsContributions } from './registry'
import { pluginsEnabled } from './switch'
import type { CoreScreen } from './extensionPoints'

/**
 * The UI a plugin contributes, as the host reads it on a page load (design §6, F-10/F-11).
 * Read from the stored manifest only, never the volume, and only for plugins that
 * `showsContributions` (enabled, ready or updating, not revoked). `llm` and `async` come from
 * the matching entry in the manifest's `actions`, so the gear menu knows to open the model
 * gate first and to expect a job; a `coreScreen` item has no action and is neither.
 */
export interface NavContribution {
  label: string
  icon: string
  screen: string
}

export interface ChatSessionActionContribution {
  /** Stable within a plugin: the action id, or the core screen name for a screen item. */
  key: string
  label: string
  icon?: string
  action?: string
  coreScreen?: CoreScreen
  llm: boolean
  async: boolean
}

export interface ProjectSkillsRowContribution {
  key: string
  label: string
  action: string
}

export interface PluginContributions {
  pluginId: string
  displayName: string
  /** True while the plugin is being updated: its buttons stay, flagged, until it is ready. */
  updating: boolean
  nav?: NavContribution
  chatSessionActions: ChatSessionActionContribution[]
  projectSkillsRow: ProjectSkillsRowContribution[]
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

type Db = Pick<typeof prisma, 'pluginInstall'>

function actionFlags(manifest: Record<string, unknown>): Map<string, { llm: boolean; async: boolean }> {
  const out = new Map<string, { llm: boolean; async: boolean }>()
  const actions = Array.isArray(manifest.actions) ? manifest.actions : []
  for (const a of actions) {
    if (isObj(a) && typeof a.id === 'string') out.set(a.id, { llm: a.llm === true, async: a.async === true })
  }
  return out
}

function navOf(contributes: Record<string, unknown>): NavContribution | undefined {
  const nav = contributes.nav
  if (!isObj(nav)) return undefined
  const label = str(nav.label)
  const icon = str(nav.icon)
  const screen = str(nav.screen)
  return label && icon && screen ? { label, icon, screen } : undefined
}

function chatActionsOf(
  contributes: Record<string, unknown>,
  flags: Map<string, { llm: boolean; async: boolean }>,
): ChatSessionActionContribution[] {
  const raw = contributes['chat.session.actions']
  if (!Array.isArray(raw)) return []
  const out: ChatSessionActionContribution[] = []
  for (const c of raw) {
    if (!isObj(c)) continue
    const label = str(c.label)
    if (!label) continue
    const action = str(c.action)
    const coreScreen = str(c.coreScreen) as CoreScreen | undefined
    const key = action ?? coreScreen
    if (!key) continue
    const f = action ? flags.get(action) : undefined
    out.push({
      key,
      label,
      ...(str(c.icon) ? { icon: str(c.icon) } : {}),
      ...(action ? { action } : {}),
      ...(coreScreen ? { coreScreen } : {}),
      llm: f?.llm ?? false,
      async: f?.async ?? false,
    })
  }
  return out
}

function skillRowsOf(contributes: Record<string, unknown>): ProjectSkillsRowContribution[] {
  const raw = contributes['project.skills.row']
  if (!Array.isArray(raw)) return []
  const out: ProjectSkillsRowContribution[] = []
  for (const c of raw) {
    if (!isObj(c)) continue
    const label = str(c.label)
    const action = str(c.action)
    if (label && action) out.push({ key: action, label, action })
  }
  return out
}

/** Every enabled plugin's contributions, by plugin id; empty while the switch is off. */
export async function listContributions(db: Db = prisma): Promise<PluginContributions[]> {
  if (!pluginsEnabled()) return []
  const rows = await db.pluginInstall.findMany({ orderBy: { pluginId: 'asc' } })
  const out: PluginContributions[] = []
  for (const row of rows) {
    if (!showsContributions(row)) continue
    const manifest = row.manifest
    if (!isObj(manifest)) continue
    const contributes = isObj(manifest.contributes) ? manifest.contributes : {}
    const flags = actionFlags(manifest)
    const nav = navOf(contributes)
    const chatSessionActions = chatActionsOf(contributes, flags)
    const projectSkillsRow = skillRowsOf(contributes)
    // A plugin that qualifies but contributes no UI (only skill.text, say) would render an
    // empty gear-menu group and no Plugins-page entry: leave it out.
    if (!nav && chatSessionActions.length === 0 && projectSkillsRow.length === 0) continue
    out.push({
      pluginId: row.pluginId,
      displayName: str(manifest.displayName) ?? row.pluginId,
      updating: contributionsUpdating(row),
      ...(nav ? { nav } : {}),
      chatSessionActions,
      projectSkillsRow,
    })
  }
  return out
}
