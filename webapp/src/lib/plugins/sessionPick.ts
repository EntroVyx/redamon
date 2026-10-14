import type { PluginInstall } from '@prisma/client'
import { BEHAVIOUR_EXTENSION_POINTS, POINT_PERMISSION, type BehaviourExtensionPoint } from './extensionPoints'
import type { JobPick } from './jobs'
import { hasPermission } from './registry'
import { sessionSkills, type SessionSkill } from './sessionSkills'

/**
 * The `session.skill` pick (platform 1.1.0, README.PLUGINS.md §7.6): the core lists the
 * skills a session used, of the points the plugin may work on, and the person picks one
 * before the action starts. The action start re-derives the list and refuses a pick not in
 * it (`invalid_pick`), so a forged pick (another user's skill, one the session never used,
 * a point the admin did not grant) never reaches plugin code.
 */
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function declaredPermissions(plugin: Pick<PluginInstall, 'manifest'>): string[] {
  const p = isObj(plugin.manifest) ? plugin.manifest.permissions : null
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : []
}

/** The behaviour points whose permission the admin granted AND the manifest declares. */
export function pickablePoints(plugin: Pick<PluginInstall, 'manifest' | 'grantedPermissions'>): BehaviourExtensionPoint[] {
  const declared = declaredPermissions(plugin)
  return BEHAVIOUR_EXTENSION_POINTS.filter((pt) => declared.includes(POINT_PERMISSION[pt]) && hasPermission(plugin, POINT_PERMISSION[pt]))
}

/** Whether one of the plugin's chat items asks for a session skill before running `actionId`. */
export function actionPicksSessionSkill(plugin: Pick<PluginInstall, 'manifest'>, actionId: string): boolean {
  const contributes = isObj(plugin.manifest) ? plugin.manifest.contributes : null
  const items = isObj(contributes) ? contributes['chat.session.actions'] : null
  return Array.isArray(items) && items.some((c) => isObj(c) && c.action === actionId && c.pick === 'session.skill')
}

/** The skills of the session, of the points the plugin may work on (the picker's list). */
export async function pickableSessionSkills(
  plugin: Pick<PluginInstall, 'manifest' | 'grantedPermissions'>,
  conversationId: string,
  ownerId: string,
): Promise<SessionSkill[]> {
  const points = new Set<string>(pickablePoints(plugin))
  return (await sessionSkills(conversationId, ownerId)).filter((s) => points.has(s.point))
}

export class InvalidPickError extends Error {
  readonly code = 'invalid_pick'
  constructor(message: string) {
    super(message)
    this.name = 'InvalidPickError'
  }
}

/**
 * The pick as the server sees it, from what the browser sent (`{kind, ref}`; any point or
 * target it sent is ignored and re-derived). Throws InvalidPickError.
 */
export async function resolvePick(
  plugin: Pick<PluginInstall, 'manifest' | 'grantedPermissions'>,
  actionId: string,
  raw: unknown,
  conversationId: string | null,
  ownerId: string,
): Promise<JobPick> {
  if (!actionPicksSessionSkill(plugin, actionId)) throw new InvalidPickError('This action takes no pick.')
  if (!isObj(raw) || raw.kind !== 'session.skill' || typeof raw.ref !== 'string') {
    throw new InvalidPickError('A pick is {kind: "session.skill", ref}.')
  }
  if (!conversationId) throw new InvalidPickError('A skill can only be picked inside a chat session.')
  const entry = (await pickableSessionSkills(plugin, conversationId, ownerId)).find((s) => s.ref === raw.ref)
  if (!entry || !entry.selectable) throw new InvalidPickError('This session did not use that skill, or it cannot be picked.')
  return { kind: 'session.skill', point: entry.point, target: entry.target, ref: entry.ref, name: entry.name }
}
