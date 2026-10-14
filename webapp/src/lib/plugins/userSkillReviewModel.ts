import prisma from '@/lib/prisma'
import { MAX_ENABLED_USER_SKILLS_PER_PROJECT, MAX_SKILLS_PER_USER } from '@/lib/userSkills'
import { suggestVersionName } from '@/lib/userSkillNames'
import { contentSha16 } from '@/lib/userSkillWrites'
import * as ov from './overrides'
import { findInstall } from './registry'
import { addedRiskLines, type RiskLine } from './riskFlags'
import { sessionSkills } from './sessionSkills'
import { proposerMessage, proposerState, type ProposerState } from './userSkillAdoption'

/**
 * What the review window shows for a proposal at `user_skill.text`: the text the proposal
 * was built on and the proposed one (from the platform's own record, so the review needs
 * neither the session nor the source skill to still exist), what changed since, the name
 * a save would use, the person's limits, and whether the proposing plugin can still have
 * its proposal saved.
 */
export interface UserSkillReviewModel {
  kind: 'user_skill'
  changeSetId: string
  status: ov.OverrideStatus
  plugin: { pluginId: string; displayName: string }
  scope: { type: 'user'; ownerId: string }
  source: {
    id: string
    /** Its name now; null when it was deleted. */
    name: string | null
    nameAtProposal: string
    exists: boolean
    /** Its text is no longer the one the proposal was built on. */
    changedSinceProposal: boolean
    description: string | null
  }
  parts: { partId: 'body'; kind: 'plain'; placeholders: []; before: string; after: string; riskFlags: RiskLine[] }[]
  suggestedName: string
  suggestedVersion: number
  skillCount: number
  skillLimit: number
  project: {
    id: string
    name: string
    sourceEnabled: boolean
    enabledCount: number
    enabledLimit: number
  } | null
  /** The session last ran a text other than the one the proposal was built on. */
  sessionPredatesActive: boolean
  sessionDeleted: boolean
  proposer: ProposerState & { message: string | null }
  /** When saved: the skill it became. */
  adopted: { skillId: string; name: string } | null
  note: string | null
  meta: Record<string, unknown>
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function pluginName(install: Awaited<ReturnType<typeof findInstall>>, pluginId: string): string {
  const m = install?.manifest
  return isObj(m) && typeof m.displayName === 'string' && m.displayName ? m.displayName : pluginId
}

/** Keys of the platform's meta the review shows on their own, not as the plugin's meta. */
const PLATFORM_ONLY = new Set(ov.PLATFORM_META_KEYS)

export async function buildUserSkillReviewModel(
  set: ov.ChangeSet,
  opts: { projectId?: string | null } = {},
): Promise<UserSkillReviewModel> {
  const ownerId = set.scope.id
  const meta = isObj(set.meta) ? set.meta : {}
  const part = set.parts[0]
  const baseText = typeof meta.baseText === 'string' ? meta.baseText : ''
  const nameAtProposal = typeof meta.sourceName === 'string' ? meta.sourceName : 'Skill'

  const [install, source, skillCount] = await Promise.all([
    findInstall(set.pluginId),
    prisma.userAttackSkill.findFirst({
      where: { id: set.targetGroup, userId: ownerId },
      select: { id: true, name: true, content: true, description: true, lineageRootId: true },
    }),
    prisma.userAttackSkill.count({ where: { userId: ownerId } }),
  ])
  const suggestion = await suggestVersionName(prisma, ownerId, {
    id: set.targetGroup,
    name: source?.name ?? nameAtProposal,
    lineageRootId: source?.lineageRootId ?? null,
  })

  let project: UserSkillReviewModel['project'] = null
  if (opts.projectId) {
    const row = await prisma.project.findFirst({
      where: { id: opts.projectId, userId: ownerId },
      select: { id: true, name: true, attackSkillConfig: true },
    })
    if (row) {
      const user = isObj(row.attackSkillConfig) && isObj(row.attackSkillConfig.user) ? row.attackSkillConfig.user : {}
      const onIds = Object.entries(user).filter(([, v]) => v === true).map(([k]) => k)
      const enabledCount = onIds.length
        ? await prisma.userAttackSkill.count({ where: { userId: ownerId, id: { in: onIds } } })
        : 0
      project = {
        id: row.id,
        name: row.name,
        sourceEnabled: user[set.targetGroup] === true,
        enabledCount,
        enabledLimit: MAX_ENABLED_USER_SKILLS_PER_PROJECT,
      }
    }
  }

  let sessionDeleted = true
  let sessionPredatesActive = false
  const conversationId = typeof meta.conversationId === 'string' ? meta.conversationId : null
  if (conversationId) {
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true } })
    if (conv) {
      sessionDeleted = false
      const used = (await sessionSkills(conv.id, ownerId)).find((s) => s.ref === `user_skill:${set.targetGroup}`)
      sessionPredatesActive = !!used?.lastContentSha256 && used.lastContentSha256 !== contentSha16(baseText)
    }
  }

  const proposer = proposerState(install, meta.pluginVersion)
  const displayName = pluginName(install, set.pluginId)
  return {
    kind: 'user_skill',
    changeSetId: set.changeSetId,
    status: set.status,
    plugin: { pluginId: set.pluginId, displayName },
    scope: { type: 'user', ownerId },
    source: {
      id: set.targetGroup,
      name: source?.name ?? null,
      nameAtProposal,
      exists: !!source,
      changedSinceProposal: !!source && source.content !== baseText,
      description: source?.description ?? null,
    },
    parts: [{
      partId: 'body', kind: 'plain', placeholders: [], before: baseText, after: part?.value ?? '',
      riskFlags: addedRiskLines(baseText, part?.value ?? ''),
    }],
    suggestedName: suggestion.name,
    suggestedVersion: suggestion.version,
    skillCount,
    skillLimit: MAX_SKILLS_PER_USER,
    project,
    sessionPredatesActive,
    sessionDeleted,
    proposer: { ...proposer, message: proposer.available ? null : proposerMessage(displayName, proposer) },
    adopted: typeof meta.adoptedSkillId === 'string'
      ? { skillId: meta.adoptedSkillId, name: typeof meta.adoptedName === 'string' ? meta.adoptedName : '' }
      : null,
    note: set.note,
    meta: Object.fromEntries(Object.entries(meta).filter(([k]) => !PLATFORM_ONLY.has(k))),
  }
}
