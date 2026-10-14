import prisma from '@/lib/prisma'
import { KNOWN_ATTACK_PATH_CONFIG } from '@/app/graph/components/AIAssistantDrawer/phaseConfig'
import { auditPlugin } from './audit'
import { BEHAVIOUR_EXTENSION_POINTS, POINT_PERMISSION, type BehaviourExtensionPoint } from './extensionPoints'
import { assertPermission, GatewayError, type GatewayContext } from './gateway'
import * as ov from './overrides'
import type { PluginPermission } from './permissions'
import { overridesQualify } from './registry'
import { registrySkill, validateSkillParts, type RegistrySkill } from './skillPartsRegistry'
import { getUserSkillOverride, proposeUserSkillOverride } from './userSkillOverrideOps'

/**
 * The Gateway's override operations (`sdk.override.*`, README.PLUGINS.md §7.3/§7.6):
 * read a skill's factory parts and the version that applies, propose a version, withdraw a
 * pending one. The agent's registry is the only source of factory text and hashes; the
 * plugin supplies text, a note and its own meta, nothing else.
 *
 * A proposal is a complete snapshot (TD-19): every part whose text differs from the
 * factory text. Parts the plugin does not send are factory text in that version, so the
 * agent validates exactly the parts sent, over the factory text of the rest; a plugin
 * that builds on the active version reads its parts from `override.get` and sends them.
 *
 * The recorded base must be what the plugin really built on (phase 04 review):
 * - `get` shows a version as active only while its parts' factory hashes are the
 *   registry's, as the agent runs it only then; otherwise a plugin would carry wording
 *   from before a RedAmon update into a proposal stamped with the new hash;
 * - the hashes the plugin read (`readSha256`, filled in by the SDK) must still be the
 *   registry's when it proposes, or 409 `factory_changed`;
 * - `fromRevision` is the revision of the proposal's scope that `get` showed for the same
 *   call context. When `get` showed something else (another scope's version, or factory
 *   text over a version that does not run), the proposal built on no revision of its
 *   scope: `fromRevision` is the factory's, so the review warns that approving replaces
 *   the scope's active version, and `meta.basedOn` names what was shown.
 *
 * `user_skill.text` is dispatched on the body's point BEFORE any registry call: a user's
 * skill is not in the agent's registry (userSkillOverrideOps.ts).
 */
const GROUP_RE = /^[a-z][a-z0-9_]{0,63}$/
const MAX_PARTS = 50

/**
 * A built-in skill's name as the UI shows it. Taken from the chat drawer's per-skill config,
 * a layer every built-in skill already fills, rather than a list of its own that a new skill
 * could forget; the id for a skill it does not know.
 */
export function skillDisplayName(skillId: string): string {
  return Object.hasOwn(KNOWN_ATTACK_PATH_CONFIG, skillId) ? KNOWN_ATTACK_PATH_CONFIG[skillId].label : skillId
}

const isPoint = (p: unknown): p is BehaviourExtensionPoint => (BEHAVIOUR_EXTENSION_POINTS as readonly unknown[]).includes(p)

/** The permission an override call needs, from the point its body names (null: no such point). */
export function overridePermission(body: Record<string, unknown>): PluginPermission | null {
  return isPoint(body.point) ? POINT_PERMISSION[body.point] : null
}

async function target(ctx: GatewayContext): Promise<{ point: BehaviourExtensionPoint; group: string; skill: RegistrySkill }> {
  const point = ctx.body.point as BehaviourExtensionPoint
  const group = ctx.body.targetGroup
  if (typeof group !== 'string' || !GROUP_RE.test(group)) {
    throw new GatewayError(400, 'invalid_target', `invalid target group ${JSON.stringify(group ?? null)}`)
  }
  const skill = await registrySkill(group)
  if (!skill) throw new GatewayError(404, 'invalid_target', `unknown skill '${group}'`)
  return { point, group, skill }
}

const userScope = (ctx: GatewayContext): ov.OverrideScope => ({ type: 'user', id: ctx.userId })

/** Whether every part of `set` was built on the factory text the registry has now. */
function builtOnCurrentFactory(set: ov.ChangeSet, skill: RegistrySkill): boolean {
  const current = new Map(skill.parts.map((p) => [p.partId, p.sha256]))
  return set.parts.every((p) => current.get(p.partId) === p.baseSha256)
}

/** The version the agent runs for this call's project (or the user, outside one), or null for factory text. */
async function appliedSet(ctx: GatewayContext, point: string, group: string, skill: RegistrySkill): Promise<ov.ChangeSet | null> {
  let set: ov.ChangeSet | null
  if (ctx.projectId) {
    const effective = await ov.effectiveForProject(ctx.projectId, group)
    set = effective && effective.applies ? effective : null
  } else {
    set = await ov.activeChangeSet(userScope(ctx), point, group)
    const plugin = set ? await prisma.pluginInstall.findUnique({ where: { pluginId: set.pluginId } }) : null
    if (!plugin || !overridesQualify(plugin)) set = null
  }
  return set && builtOnCurrentFactory(set, skill) ? set : null
}

export async function getOverride(ctx: GatewayContext): Promise<Record<string, unknown>> {
  if (ctx.body.point === ov.USER_SKILL_POINT) return getUserSkillOverride(ctx)
  const { point, group, skill } = await target(ctx)
  const [set, pendingCount] = await Promise.all([
    appliedSet(ctx, point, group, skill),
    ov.pendingCount(userScope(ctx), point, group),
  ])
  return {
    point,
    targetGroup: group,
    displayName: skillDisplayName(group),
    // kind and placeholders say how a part may be edited (TD-26): a template keeps exactly its
    // placeholders and doubles any new literal brace; a plain part is used verbatim.
    parts: skill.parts.map((p) => ({
      partId: p.partId,
      text: p.text,
      sha256: p.sha256,
      chars: p.chars,
      maxChars: p.maxChars,
      kind: p.kind,
      placeholders: p.placeholders,
    })),
    active: set
      ? {
          changeSetId: set.changeSetId,
          scope: set.scope.type,
          revision: set.revision,
          decidedAt: set.decidedAt ? set.decidedAt.toISOString() : null,
          pluginId: set.pluginId,
          parts: Object.fromEntries(set.parts.map((p) => [p.partId, p.value])),
        }
      : null,
    pendingCount,
    limits: { skillMaxChars: skill.maxChars, parts: Object.fromEntries(skill.parts.map((p) => [p.partId, p.maxChars])) },
  }
}

const invalidProposal = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  new GatewayError(status, 'invalid_proposal', message, extra)

function proposalScope(ctx: GatewayContext): ov.OverrideScope {
  const scope = ctx.body.scope
  if (scope === 'user') return userScope(ctx)
  if (scope === 'project' && ctx.projectId) return { type: 'project', id: ctx.projectId }
  throw invalidProposal(400, 'scope is user, or project inside a project')
}

function proposedParts(ctx: GatewayContext, skill: RegistrySkill, group: string): Record<string, string> {
  const raw = ctx.body.parts
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidProposal(400, 'parts must be an object of part id to text')
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length === 0) throw invalidProposal(400, 'a proposal changes at least one part')
  if (entries.length > MAX_PARTS) throw invalidProposal(400, `a proposal changes at most ${MAX_PARTS} parts`)
  for (const [partId, text] of entries) {
    if (typeof text !== 'string') throw invalidProposal(400, `the text of ${group}/${partId} must be a string`)
  }
  const known = new Map(skill.parts.map((p) => [p.partId, p]))
  const unknown = entries.filter(([partId]) => !known.has(partId)).map(([partId]) => `unknown part ${group}/${partId}`)
  if (unknown.length) throw invalidProposal(422, unknown.join('; '))
  return Object.fromEntries(entries.filter(([partId, text]) => text !== known.get(partId)!.text)) as Record<string, string>
}

/** Refuses a proposal built on factory text that has changed since the plugin read it. */
function checkReadHashes(ctx: GatewayContext, skill: RegistrySkill, group: string): void {
  const raw = ctx.body.readSha256
  if (raw === undefined || raw === null) return
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalidProposal(400, 'readSha256 must be an object of part id to the sha256 read')
  const current = new Map(skill.parts.map((p) => [p.partId, p.sha256]))
  const changed: string[] = []
  for (const [partId, read] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof read !== 'string') throw invalidProposal(400, `readSha256 of ${group}/${partId} must be a string`)
    if (!current.has(partId)) throw invalidProposal(422, `unknown part ${group}/${partId}`)
    if (current.get(partId) !== read) changed.push(`${group}/${partId}`)
  }
  if (changed.length) {
    throw new GatewayError(
      409,
      'factory_changed',
      `The factory text of ${changed.join(', ')} changed since this plugin read it (a RedAmon update): read it again and redo the proposal.`,
    )
  }
}

export async function proposeOverride(ctx: GatewayContext): Promise<Record<string, unknown>> {
  if (ctx.body.point === ov.USER_SKILL_POINT) return proposeUserSkillOverride(ctx)
  const { point, group, skill } = await target(ctx)
  const scope = proposalScope(ctx)
  if (typeof ctx.body.note !== 'string') throw invalidProposal(400, 'a note is required')
  const meta = ctx.body.meta
  if (meta !== undefined && meta !== null && (typeof meta !== 'object' || Array.isArray(meta))) {
    throw invalidProposal(400, 'meta must be an object')
  }
  const parts = proposedParts(ctx, skill, group)
  checkReadHashes(ctx, skill, group)
  if (Object.keys(parts).length === 0) {
    throw invalidProposal(422, `This proposal changes no part of ${group}: every text equals the factory text.`)
  }

  const verdict = await validateSkillParts(group, parts)
  if (!verdict.ok) {
    const errors = [
      ...Object.entries(verdict.parts).flatMap(([partId, r]) => r.errors.map((e) => `${group}/${partId}: ${e}`)),
      ...verdict.skill.errors,
    ]
    throw invalidProposal(422, errors.join('; ') || 'The agent refused this proposal.', {
      errors: { parts: Object.fromEntries(Object.entries(verdict.parts).map(([k, r]) => [k, r.errors])), skill: verdict.skill.errors },
    })
  }

  const factory = new Map(skill.parts.map((p) => [p.partId, p]))
  const [active, shown] = await Promise.all([ov.activeChangeSet(scope, point, group), appliedSet(ctx, point, group, skill)])
  const builtOnActive = (active?.changeSetId ?? null) === (shown?.changeSetId ?? null)
  const fromRevision = builtOnActive ? (active?.revision ?? ov.FACTORY_REVISION) : ov.FACTORY_REVISION
  const { changeSetId } = await ov.propose({
    pluginId: ctx.pluginId,
    point,
    scope,
    targetGroup: group,
    parts: Object.entries(parts).map(([partId, value]) => ({
      targetKey: `${group}/${partId}`,
      value,
      baseSha256: factory.get(partId)!.sha256,
    })),
    note: ctx.body.note,
    meta: (meta ?? undefined) as Record<string, string> | undefined,
    platformMeta: {
      fromRevision,
      baseFactoryText: Object.fromEntries(Object.keys(parts).map((partId) => [partId, factory.get(partId)!.text])),
      ...(builtOnActive
        ? {}
        : { basedOn: shown ? { scope: shown.scope.type, changeSetId: shown.changeSetId, revision: shown.revision } : null }),
      pluginVersion: ctx.version,
      conversationId: ctx.conversation?.id ?? null,
      jobId: ctx.claims.jid ?? null,
    },
    createdBy: ctx.userId,
  })
  await auditPlugin('plugin.override.propose', {
    actorId: ctx.actorId ?? ctx.userId,
    pluginId: ctx.pluginId,
    targetType: 'plugin_change_set',
    targetId: changeSetId,
    after: {
      point,
      targetGroup: group,
      scope: scope.type,
      scopeId: scope.id,
      parts: Object.keys(parts).sort(),
      fromRevision,
      pluginVersion: ctx.version,
      ...(ctx.actorId ? { onBehalfOf: ctx.userId } : {}),
    },
  })
  const next = (await ov.lastRevision(scope, point, group)) + 1
  return { changeSetId, fromRevision, proposedRevisionLabel: `v${next}` }
}

/**
 * The route declares no static permission (`permission: 'in-handler'`): the one needed is
 * that of the set's own point, known only once the set is read. A set that is not this
 * plugin's is 404 before any permission is looked at, so the answer says nothing about it.
 */
export async function withdrawOverride(ctx: GatewayContext): Promise<Record<string, unknown>> {
  const id = ctx.body.changeSetId
  const notFound = new GatewayError(404, 'not_found', `No proposal ${typeof id === 'string' ? id : JSON.stringify(id)} of this plugin.`)
  if (typeof id !== 'string') throw notFound
  const set = await ov.getChangeSet(id)
  const ownScope =
    !!set &&
    ((set.scope.type === 'user' && set.scope.id === ctx.userId) ||
      (set.scope.type === 'project' && set.scope.id === ctx.projectId))
  if (!set || set.pluginId !== ctx.pluginId || !ownScope || !isPoint(set.point)) throw notFound
  assertPermission(ctx, POINT_PERMISSION[set.point])
  try {
    await ov.withdraw(id, ctx.pluginId)
  } catch (e) {
    if (e instanceof ov.PluginOverrideError && e.code === 'not_found') throw notFound
    throw e
  }
  await auditPlugin('plugin.override.withdraw', {
    actorId: ctx.actorId ?? ctx.userId,
    pluginId: ctx.pluginId,
    targetType: 'plugin_change_set',
    targetId: id,
    after: { point: set.point, targetGroup: set.targetGroup, scope: set.scope.type, scopeId: set.scope.id, ...(ctx.actorId ? { onBehalfOf: ctx.userId } : {}) },
  })
  return { withdrawn: true }
}
