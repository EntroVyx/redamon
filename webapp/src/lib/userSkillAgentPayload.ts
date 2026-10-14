import type { Prisma } from '@prisma/client'
import { MAX_ENABLED_USER_SKILLS_PER_PROJECT } from './userSkills'

/**
 * The user skills the agent receives for a project (`userAttackSkills` of its settings
 * fetch, read into USER_ATTACK_SKILLS):
 * - only ids the project sets to `true`: a missing toggle is OFF, as the form shows it;
 * - owned by the project's owner and not quarantined;
 * - ordered by name, then id, and at most MAX_ENABLED_USER_SKILLS_PER_PROJECT, the bound
 *   every writer already enforces (the agent cuts the same way, defensively);
 * - each with `supersedes`: the ids of the owner's skills of its family (same
 *   `lineageRootId`) that are OFF in this project, each given only to the family's
 *   highest-version enabled member. A session whose label names one of those renders this
 *   member's text instead, so swapping a skill for its new version reaches a session that
 *   resumes without a new message (agentic resolve_user_skill). The field travels inside
 *   the entries: no new settings key.
 */
export interface AgentUserSkill {
  id: string
  name: string
  description: string | null
  content: string
  supersedes: string[]
}

type Db = { userAttackSkill: Pick<Prisma.TransactionClient['userAttackSkill'], 'findMany'> }

export function enabledUserSkillIds(config: unknown): string[] {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return []
  const user = (config as Record<string, unknown>).user
  if (!user || typeof user !== 'object' || Array.isArray(user)) return []
  return Object.entries(user as Record<string, unknown>).filter(([, v]) => v === true).map(([id]) => id)
}

export async function userSkillsForAgent(db: Db, ownerId: string, config: unknown): Promise<AgentUserSkill[]> {
  const ids = enabledUserSkillIds(config)
  if (ids.length === 0) return []
  const enabled = await db.userAttackSkill.findMany({
    where: { userId: ownerId, id: { in: ids }, quarantinedAt: null },
    select: { id: true, name: true, description: true, content: true, lineageRootId: true, version: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: MAX_ENABLED_USER_SKILLS_PER_PROJECT,
  })
  const families = [...new Set(enabled.map((s) => s.lineageRootId).filter((r): r is string => !!r))]
  const members = families.length
    ? await db.userAttackSkill.findMany({
        where: { userId: ownerId, lineageRootId: { in: families } },
        select: { id: true, lineageRootId: true },
      })
    : []
  const on = new Set(ids)
  const supersedes = new Map<string, string[]>()
  for (const family of families) {
    const head = enabled
      .filter((s) => s.lineageRootId === family)
      .sort((a, b) => (b.version ?? 0) - (a.version ?? 0) || b.id.localeCompare(a.id))[0]
    const off = members.filter((m) => m.lineageRootId === family && !on.has(m.id)).map((m) => m.id).sort()
    if (head && off.length) supersedes.set(head.id, off)
  }
  return enabled.map((s) => ({
    id: s.id, name: s.name, description: s.description, content: s.content,
    supersedes: supersedes.get(s.id) ?? [],
  }))
}
