import type { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { writeAudit } from '@/lib/audit'
import { USER_SKILL_AUDIT_TARGET, lockUserSkills, originPair, quarantineUserSkillTx } from '@/lib/userSkillWrites'
import { auditPlugin } from './audit'
import * as ov from './overrides'

/**
 * The catalog's kill switch, reaching what a revoked plugin version left behind at
 * `user_skill.text` (README.PLUGINS.md §7.6). For one revoked (plugin, version), installed or
 * not:
 * - its proposals still waiting are withdrawn (`meta.withdrawReason: 'revoked'`), so they can
 *   never be saved;
 * - every skill whose originChain holds it is quarantined: the ones saved from its proposals,
 *   and the versions saved from those since by any plugin version, which carry the text on
 *   (also when a version in between was deleted). Turned off in every project of their owner
 *   and kept out of the agent's payload until the owner reads and releases them. Never
 *   deleted: they are the person's. A release is from this revocation only: a later one of
 *   another version in the chain quarantines the skill again.
 *
 * Turning a skill off never needs normalizeUserSkillToggles: it can only lower the count.
 * Idempotent, so every reconciliation can run it; a catalog that cannot load revokes nothing.
 */
export const QUARANTINE_REASON = 'plugin_version_revoked'
export const DERIVED_QUARANTINE_REASON = 'derived_from_revoked'
const SYSTEM = { actorId: null, source: 'system' as const }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export async function revokeUserSkillProvenance(
  pluginId: string,
  version: string,
): Promise<{ withdrawn: string[]; quarantined: string[] }> {
  const withdrawn: string[] = []
  const quarantined: string[] = []

  const waiting = await prisma.pluginOverride.findMany({
    where: { pluginId, extensionPoint: ov.USER_SKILL_POINT, status: 'proposed', meta: { path: ['pluginVersion'], equals: version } },
    select: { changeSetId: true, targetGroup: true, scopeId: true },
  })
  for (const changeSetId of new Set(waiting.map((w) => w.changeSetId))) {
    if (await prisma.$transaction((tx) => ov.withdrawRevokedIn(tx, changeSetId))) {
      withdrawn.push(changeSetId)
      const w = waiting.find((x) => x.changeSetId === changeSetId)!
      await auditPlugin('plugin.override.withdraw', {
        ...SYSTEM,
        pluginId,
        targetType: 'plugin_change_set',
        targetId: changeSetId,
        after: { point: ov.USER_SKILL_POINT, targetGroup: w.targetGroup, scope: 'user', scopeId: w.scopeId, reason: 'revoked', version },
      })
    }
  }

  const pair = originPair(pluginId, version)
  const saved = (await prisma.userAttackSkill.findMany({
    where: { originChain: { has: pair }, quarantinedAt: null },
    select: { id: true, userId: true, releasedFor: true },
  })).filter((s) => !s.releasedFor.includes(pair))
  const byOwner = new Map<string, string[]>()
  for (const s of saved) byOwner.set(s.userId, [...(byOwner.get(s.userId) ?? []), s.id])

  for (const [userId, skillIds] of byOwner) {
    const done = await prisma.$transaction(async (tx) => {
      await lockUserSkills(tx, userId)
      const newly: { id: string; reason: string }[] = []
      for (const id of skillIds) {
        const own = await tx.userAttackSkill.findFirst({ where: { id }, select: { originPluginId: true, originPluginVersion: true } })
        const reason = own && own.originPluginId === pluginId && own.originPluginVersion === version
          ? QUARANTINE_REASON
          : DERIVED_QUARANTINE_REASON
        if (await quarantineUserSkillTx(tx, id, pair, reason)) newly.push({ id, reason })
      }
      const off = new Set(newly.map((q) => q.id))
      const changed: string[] = []
      if (off.size === 0) return { newly, changed }
      for (const p of await tx.project.findMany({ where: { userId }, select: { id: true, attackSkillConfig: true } })) {
        const config = isObj(p.attackSkillConfig) ? p.attackSkillConfig : null
        const user = config && isObj(config.user) ? config.user : null
        if (!config || !user || ![...off].some((id) => user[id] === true)) continue
        const next = { ...user }
        for (const id of off) if (next[id] === true) next[id] = false
        // Through Prisma, never raw SQL: updatedAt moves, so no open form writes the toggle back on.
        await tx.project.update({
          where: { id: p.id },
          data: { attackSkillConfig: { ...config, user: next } as Prisma.InputJsonValue },
        })
        changed.push(p.id)
      }
      return { newly, changed }
    })
    for (const q of done.newly) {
      quarantined.push(q.id)
      await writeAudit({
        ...SYSTEM,
        action: 'user_attack_skill.quarantine',
        targetType: USER_SKILL_AUDIT_TARGET,
        targetId: q.id,
        after: { reason: q.reason, pluginId, pluginVersion: version, userId, projectsTurnedOff: done.changed },
      })
    }
  }
  return { withdrawn, quarantined }
}

/**
 * Of the catalog's revoked (plugin, version) pairs, those that still left something at
 * user_skill.text: two queries for the whole list, so a reconciliation with nothing to do
 * costs no more than that.
 */
export async function pairsWithUserSkillProvenance(
  revoked: { id: string; version: string }[],
): Promise<{ id: string; version: string }[]> {
  const ids = [...new Set(revoked.map((r) => r.id))]
  if (ids.length === 0) return []
  const [waiting, saved] = await Promise.all([
    prisma.pluginOverride.findMany({
      where: { extensionPoint: ov.USER_SKILL_POINT, status: 'proposed', pluginId: { in: ids } },
      select: { pluginId: true, meta: true },
    }),
    prisma.userAttackSkill.findMany({
      where: { quarantinedAt: null, originChain: { hasSome: revoked.map((r) => originPair(r.id, r.version)) } },
      select: { originChain: true, releasedFor: true },
    }),
  ])
  const live = new Set([
    ...waiting.map((w) => originPair(w.pluginId, isObj(w.meta) ? String(w.meta.pluginVersion) : '')),
    ...saved.flatMap((s) => s.originChain.filter((p) => !s.releasedFor.includes(p))),
  ])
  return revoked.filter((r) => live.has(originPair(r.id, r.version)))
}
