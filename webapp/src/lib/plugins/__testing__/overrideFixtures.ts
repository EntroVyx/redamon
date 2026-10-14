/**
 * Shared setup for the override store tests: two qualifying plugins, two projects
 * owned by two users, fake factory hashes and a one-call proposal helper.
 */
import type { FakePrisma } from './fakePrisma'
import { propose, type OverrideScope } from '../overrides'

/** A fake SHA-256: 64 hex characters derived from a small number. */
export const sha = (n: number) => n.toString(16).padStart(64, '0')

export const alice: OverrideScope = { type: 'user', id: 'alice' }
export const bob: OverrideScope = { type: 'user', id: 'bob' }
export const p1: OverrideScope = { type: 'project', id: 'p1' } // owned by alice
export const p2: OverrideScope = { type: 'project', id: 'p2' } // owned by bob

export const QUALIFYING = { status: 'ready', enabled: true, grantedPermissions: ['override:skill.text'] }

export function seedPlatform(db: FakePrisma) {
  db.seed('pluginInstall', [
    { pluginId: 'skiller', ...QUALIFYING },
    { pluginId: 'echo', ...QUALIFYING },
  ])
  db.seed('project', [
    { id: 'p1', userId: 'alice' },
    { id: 'p2', userId: 'bob' },
  ])
}

/** Factory hashes "now" for the given parts of a skill (all `sha(n)`). */
export const hashes = (group: string, partIds: string[], n = 1) =>
  Object.fromEntries(partIds.map((p) => [`${group}/${p}`, sha(n)]))

/** Proposes `{partId: text}` for one skill; every part built on `sha(base)`. */
export async function proposeParts(
  scope: OverrideScope,
  group: string,
  parts: Record<string, string>,
  opts: { pluginId?: string; base?: number; note?: string; meta?: Record<string, unknown> } = {},
): Promise<string> {
  const { changeSetId } = await propose({
    pluginId: opts.pluginId ?? 'skiller',
    point: 'skill.text',
    scope,
    targetGroup: group,
    parts: Object.entries(parts).map(([partId, value]) => ({
      targetKey: `${group}/${partId}`,
      value,
      baseSha256: sha(opts.base ?? 1),
    })),
    note: opts.note,
    meta: opts.meta as never,
    createdBy: scope.type === 'user' ? scope.id : 'alice',
  })
  return changeSetId
}

/** Status of every row, as `targetKey:status` per change set, sorted. */
export function statuses(db: FakePrisma, changeSetId: string): string[] {
  return db
    .rows('pluginOverride')
    .filter((r) => r.changeSetId === changeSetId)
    .map((r) => `${r.targetKey}:${r.status}`)
    .sort()
}

/** At most one active row per point, scope and target: the database index, held by code. */
export function activeKeys(db: FakePrisma): string[] {
  return db
    .rows('pluginOverride')
    .filter((r) => r.status === 'active')
    .map((r) => `${r.extensionPoint}|${r.scopeType}|${r.scopeId}|${r.targetKey}`)
}
