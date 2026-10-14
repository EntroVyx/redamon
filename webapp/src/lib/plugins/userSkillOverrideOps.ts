import { createHash } from 'crypto'
import prisma from '@/lib/prisma'
import { MAX_CONTENT_SIZE } from '@/lib/userSkills'
import { splitVersion } from '@/lib/userSkillNames'
import { auditPlugin } from './audit'
import { GatewayError, type GatewayContext } from './gateway'
import * as ov from './overrides'
import { sessionSkills, skillHoldsCredentials } from './sessionSkills'
import { SkillPartsRegistryError, validatePlainText } from './skillPartsRegistry'

/**
 * The Gateway's override operations at `user_skill.text` (README.PLUGINS.md §7.6): read a
 * user's own skill that this call's session used, and propose a new version of it. The
 * proposal changes nothing: a person saves it as a NEW user skill (userSkillAdoption.ts).
 *
 * Access is bound to the session, and refuses without telling why. The skill must belong
 * to the token's user, be one the session's turns used (sessionSkills.ts), and not be
 * quarantined; every other case is the same 404 `invalid_target`, so a plugin cannot learn
 * whether an id it guessed exists. A skill whose text holds a key or token in a recognised
 * format is never handed to a plugin (422 `skill_contains_credentials`): the text would reach
 * the plugin's code and the model provider chosen for it.
 *
 * The skill is one plain Markdown part, `body`, reaching the agent's prompt as a format
 * argument that is never re-parsed, so it has no placeholders.
 */
export const PART_ID = 'body'
const GROUP_RE = /^[a-z][a-z0-9_]{0,63}$/

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

interface TargetSkill {
  id: string
  name: string
  description: string | null
  content: string
  version: number | null
}

const invalidTarget = () => new GatewayError(404, 'invalid_target', 'No such skill in this session.')

async function target(ctx: GatewayContext): Promise<TargetSkill> {
  const group = ctx.body.targetGroup
  if (typeof group !== 'string' || !GROUP_RE.test(group)) throw invalidTarget()
  if (!ctx.conversation) throw new GatewayError(400, 'no_session', 'This action was not started from a session.')
  let skill: TargetSkill & { quarantinedAt: Date | null } | null
  let used: boolean
  try {
    skill = await prisma.userAttackSkill.findFirst({
      where: { id: group, userId: ctx.userId },
      select: { id: true, name: true, description: true, content: true, version: true, quarantinedAt: true },
    })
    used = !!skill && (await sessionSkills(ctx.conversation.id, ctx.userId))
      .some((s) => s.kind === 'user' && s.target === group && s.exists)
  } catch (e) {
    // Fail closed: a check that cannot run is a refusal, never a pass.
    console.warn('[plugins] user skill target check failed:', e)
    throw invalidTarget()
  }
  if (!skill || !used || skill.quarantinedAt) throw invalidTarget()
  if (skillHoldsCredentials(skill)) {
    throw new GatewayError(422, 'skill_contains_credentials',
      'This skill holds a key or token (a private key, a JWT or an API token), so it is never given to a plugin. Remove it from the skill first.')
  }
  return skill
}

const userScope = (ctx: GatewayContext): ov.OverrideScope => ({ type: 'user', id: ctx.userId })

export async function getUserSkillOverride(ctx: GatewayContext): Promise<Record<string, unknown>> {
  const skill = await target(ctx)
  const pendingCount = await ov.pendingCount(userScope(ctx), ov.USER_SKILL_POINT, skill.id)
  const split = splitVersion(skill.name)
  return {
    point: ov.USER_SKILL_POINT,
    targetGroup: skill.id,
    displayName: skill.name,
    description: skill.description,
    parts: [{
      partId: PART_ID,
      text: skill.content,
      sha256: sha256(skill.content),
      chars: skill.content.length,
      maxChars: MAX_CONTENT_SIZE,
      kind: 'plain',
      placeholders: [],
    }],
    // A user skill has no active override: a saved version is a skill of its own.
    active: null,
    pendingCount,
    limits: { skillMaxChars: MAX_CONTENT_SIZE, parts: { [PART_ID]: MAX_CONTENT_SIZE } },
    lineage: { rootName: split.root, version: skill.version ?? split.n ?? 1 },
  }
}

const invalidProposal = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  new GatewayError(status, 'invalid_proposal', message, extra)

export async function proposeUserSkillOverride(ctx: GatewayContext): Promise<Record<string, unknown>> {
  if (ctx.body.scope !== 'user') throw invalidProposal(400, 'A version of your own skill is proposed in the user scope only.')
  const skill = await target(ctx)
  if (typeof ctx.body.note !== 'string') throw invalidProposal(400, 'a note is required')
  const meta = ctx.body.meta
  if (meta !== undefined && meta !== null && (typeof meta !== 'object' || Array.isArray(meta))) {
    throw invalidProposal(400, 'meta must be an object')
  }
  const parts = ctx.body.parts
  if (!parts || typeof parts !== 'object' || Array.isArray(parts)) throw invalidProposal(400, 'parts must be an object of part id to text')
  const keys = Object.keys(parts)
  if (keys.length !== 1 || keys[0] !== PART_ID) {
    throw invalidProposal(422, `A user skill has exactly one part, ${PART_ID}; this proposal names ${keys.join(', ') || 'none'}.`)
  }
  const text = (parts as Record<string, unknown>)[PART_ID]
  if (typeof text !== 'string') throw invalidProposal(400, `the text of ${skill.id}/${PART_ID} must be a string`)

  // Required here, unlike skill.text: a user can edit the skill at any time, so a proposal
  // must name the text it was built on.
  const read = ctx.body.readSha256
  if (!read || typeof read !== 'object' || Array.isArray(read) || typeof (read as Record<string, unknown>)[PART_ID] !== 'string') {
    throw invalidProposal(400, `readSha256.${PART_ID} is required: the sha256 of the text this proposal was built on`)
  }
  if ((read as Record<string, string>)[PART_ID] !== sha256(skill.content)) {
    throw new GatewayError(409, 'factory_changed',
      `The text of "${skill.name}" changed since this plugin read it: read it again and redo the proposal.`)
  }
  if (text === skill.content) throw invalidProposal(422, `This proposal does not change "${skill.name}".`)

  let verdict
  try {
    verdict = await validatePlainText(text, skill.content, MAX_CONTENT_SIZE)
  } catch (e) {
    if (e instanceof SkillPartsRegistryError) throw new GatewayError(503, e.code, e.message)
    throw e
  }
  if (!verdict.ok) {
    throw invalidProposal(422, verdict.errors.map((e) => `${skill.id}/${PART_ID}: ${e}`).join('; ') || 'The agent refused this proposal.', {
      errors: { parts: { [PART_ID]: verdict.errors }, skill: [] },
    })
  }

  const scope = userScope(ctx)
  const { changeSetId } = await ov.propose({
    pluginId: ctx.pluginId,
    point: ov.USER_SKILL_POINT,
    scope,
    targetGroup: skill.id,
    parts: [{ targetKey: `${skill.id}/${PART_ID}`, value: text, baseSha256: sha256(skill.content) }],
    note: ctx.body.note,
    meta: (meta ?? undefined) as Record<string, string> | undefined,
    platformMeta: {
      baseText: skill.content,
      sourceName: skill.name,
      pluginVersion: ctx.version,
      conversationId: ctx.conversation?.id ?? null,
      jobId: ctx.claims.jid ?? null,
    },
    createdBy: ctx.userId,
    guard: async (tx) => {
      const now = await tx.userAttackSkill.findFirst({ where: { id: skill.id, userId: ctx.userId }, select: { content: true } })
      if (!now) throw invalidTarget()
      if (now.content !== skill.content) {
        throw new GatewayError(409, 'factory_changed',
          `The text of "${skill.name}" changed since this plugin read it: read it again and redo the proposal.`)
      }
    },
  })
  await auditPlugin('plugin.override.propose', {
    actorId: ctx.actorId ?? ctx.userId,
    pluginId: ctx.pluginId,
    targetType: 'plugin_change_set',
    targetId: changeSetId,
    after: {
      point: ov.USER_SKILL_POINT,
      targetGroup: skill.id,
      scope: scope.type,
      scopeId: scope.id,
      parts: [PART_ID],
      pluginVersion: ctx.version,
      ...(ctx.actorId ? { onBehalfOf: ctx.userId } : {}),
    },
  })
  return { changeSetId, fromRevision: null, proposedRevisionLabel: null }
}
