import prisma from '@/lib/prisma'
import * as ov from './overrides'
import { findInstall } from './registry'

/**
 * The versions window for one of the person's own skills (`point=user_skill.text`): the
 * proposals made from it or its family (open, delete, or what they became), the family of
 * versions saved from one another, and which of them "Delete older versions" would remove:
 * all but the newest, the one the window shows, and any version on in one of the owner's
 * projects.
 */
export interface UserSkillFamilyMember {
  id: string
  name: string
  version: number | null
  createdAt: string
  /** On in the project the window was opened from (null without one). */
  enabledInProject: boolean | null
  /** How many of the owner's projects have it on. */
  enabledProjects: number
  quarantined: boolean
}

export interface UserSkillProposalRow {
  changeSetId: string
  status: ov.OverrideStatus
  sourceId: string
  sourceName: string
  pluginId: string
  pluginDisplayName: string
  note: string | null
  createdAt: string
  decidedAt: string | null
  adopted: { skillId: string; name: string } | null
}

export interface UserSkillVersionsModel {
  kind: 'user_skill'
  skill: { id: string; name: string }
  family: UserSkillFamilyMember[]
  proposals: UserSkillProposalRow[]
  /** The ids "Delete older versions" deletes. */
  deletable: string[]
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Null when the skill is not the owner's (or does not exist): the route answers 404. */
export async function buildUserSkillVersionsModel(
  ownerId: string,
  skillId: string,
  projectId: string | null,
): Promise<UserSkillVersionsModel | null> {
  const skill = await prisma.userAttackSkill.findFirst({
    where: { id: skillId, userId: ownerId },
    select: { id: true, name: true, lineageRootId: true },
  })
  if (!skill) return null
  const root = skill.lineageRootId ?? skill.id
  const members = await prisma.userAttackSkill.findMany({
    where: { userId: ownerId, OR: [{ lineageRootId: root }, { id: root }, { id: skill.id }] },
    select: { id: true, name: true, version: true, createdAt: true, quarantinedAt: true },
  })
  const projects = await prisma.project.findMany({ where: { userId: ownerId }, select: { id: true, attackSkillConfig: true } })
  const onIn = (id: string) => projects.filter((p) => {
    const user = isObj(p.attackSkillConfig) && isObj(p.attackSkillConfig.user) ? p.attackSkillConfig.user : {}
    return user[id] === true
  })
  const family = members
    .map((m) => {
      const on = onIn(m.id)
      return {
        id: m.id,
        name: m.name,
        version: m.version,
        createdAt: m.createdAt.toISOString(),
        enabledInProject: projectId ? on.some((p) => p.id === projectId) : null,
        enabledProjects: on.length,
        quarantined: !!m.quarantinedAt,
      }
    })
    .sort((a, b) => (b.version ?? 0) - (a.version ?? 0) || b.createdAt.localeCompare(a.createdAt))
  const newest = family[0]?.id
  const deletable = family.filter((m) => m.id !== newest && m.id !== skill.id && m.enabledProjects === 0).map((m) => m.id)

  const familyIds = family.map((m) => m.id)
  const rows = await prisma.pluginOverride.findMany({
    where: { extensionPoint: ov.USER_SKILL_POINT, scopeType: 'user', scopeId: ownerId, targetGroup: { in: familyIds } },
  })
  const bySet = new Map<string, typeof rows>()
  for (const r of rows) bySet.set(r.changeSetId, [...(bySet.get(r.changeSetId) ?? []), r])
  const names = new Map(family.map((m) => [m.id, m.name]))
  const pluginNames = new Map<string, string>()
  const proposals: UserSkillProposalRow[] = []
  for (const [changeSetId, set] of bySet) {
    const first = set[0]
    if (!pluginNames.has(first.pluginId)) {
      const m = (await findInstall(first.pluginId))?.manifest
      pluginNames.set(first.pluginId, isObj(m) && typeof m.displayName === 'string' ? m.displayName : first.pluginId)
    }
    const meta = isObj(first.meta) ? first.meta : {}
    proposals.push({
      changeSetId,
      status: first.status as ov.OverrideStatus,
      sourceId: first.targetGroup,
      sourceName: names.get(first.targetGroup) ?? (typeof meta.sourceName === 'string' ? meta.sourceName : first.targetGroup),
      pluginId: first.pluginId,
      pluginDisplayName: pluginNames.get(first.pluginId)!,
      note: first.note,
      createdAt: first.createdAt.toISOString(),
      decidedAt: first.decidedAt ? first.decidedAt.toISOString() : null,
      adopted: typeof meta.adoptedSkillId === 'string'
        ? { skillId: meta.adoptedSkillId, name: typeof meta.adoptedName === 'string' ? meta.adoptedName : '' }
        : null,
    })
  }
  proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { kind: 'user_skill', skill: { id: skill.id, name: skill.name }, family, proposals, deletable }
}
