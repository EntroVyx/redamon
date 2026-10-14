/**
 * Every write of a user's own agent skills goes through here: upload, edit, community
 * import, delete, quarantine and release, and saving a plugin's proposal as a new skill.
 *
 * Each runs in one transaction holding the per-user advisory lock, so the name check and
 * the cap count are exact (two uploads cannot both take the last slot or the same name), and
 * a delete cannot interleave with another write to the same user's projects. Audit rows are
 * written after the commit and hold names and content hashes, never the text.
 *
 * Lock order: the per-user lock FIRST, then any override scope lock. A transaction that took
 * them the other way round could deadlock against a delete.
 */
import { createHash } from 'crypto'
import { NextResponse } from 'next/server'
import type { Prisma, UserAttackSkill } from '@prisma/client'
import prisma from '@/lib/prisma'
import { writeAudit } from '@/lib/audit'
import {
  DESCRIPTION_MAX_CHARS, MAX_CONTENT_SIZE, MAX_SKILLS_PER_USER, UserSkillError,
} from './userSkills'
import { isNameTaken, nameProblem, normalizeName, suggestVersionName } from './userSkillNames'
import { deleteUserSkillProposalsTx } from './plugins/overrides'
import { now } from './plugins/clock'

type Tx = Prisma.TransactionClient

export const USER_SKILL_AUDIT_TARGET = 'user_attack_skill'

export const contentSha256 = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex')
/** The prefix the agent records for the user skill a session ran (skill_workflow.contentSha256). */
export const contentSha16 = (content: string) => contentSha256(content).slice(0, 16)

export async function lockUserSkills(tx: Tx, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`user_attack_skills:${userId}`}))`
}

/**
 * Who wrote it: the real session user, and the owner when that is someone else (an admin
 * passes requireUserAccess for any user without acting as them).
 */
export interface AuditActor {
  actorId: string | null
  onBehalfOf?: string
  source: 'ui' | 'api' | 'system'
}

export function auditActorFor(sessionUserId: string | null | undefined, ownerId: string, source: AuditActor['source'] = 'ui'): AuditActor {
  return {
    actorId: sessionUserId ?? null,
    ...(sessionUserId && sessionUserId !== ownerId ? { onBehalfOf: ownerId } : {}),
    source: sessionUserId ? source : 'system',
  }
}

/** What a list or a write answers with; the text is fetched on its own (download, review). */
export const USER_SKILL_SELECT = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
  updatedAt: true,
  version: true,
  lineageRootId: true,
  derivedFromId: true,
  originPluginId: true,
  quarantinedAt: true,
  quarantineReason: true,
} as const satisfies Prisma.UserAttackSkillSelect

function readDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new UserSkillError(400, 'description_invalid', 'description must be a string')
  const trimmed = value.trim()
  if (trimmed.length > DESCRIPTION_MAX_CHARS) {
    throw new UserSkillError(400, 'description_too_long', `description must be ${DESCRIPTION_MAX_CHARS} characters or less`)
  }
  return trimmed || null
}

function readContent(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new UserSkillError(400, 'content_required', 'content is required')
  if (value.length > MAX_CONTENT_SIZE) {
    throw new UserSkillError(400, 'content_too_large', `content exceeds maximum size of ${MAX_CONTENT_SIZE / 1024}KB`)
  }
  return value
}

async function readName(tx: Tx, userId: string, value: unknown, exceptId?: string): Promise<string> {
  if (typeof value !== 'string') throw new UserSkillError(400, 'name_invalid', 'name is required')
  const name = normalizeName(value)
  const problem = nameProblem(name)
  if (problem) throw problem
  if (await isNameTaken(tx, userId, name, exceptId)) {
    const { name: suggestion } = await suggestVersionName(tx, userId, { id: exceptId ?? '', name, lineageRootId: null })
    throw new UserSkillError(409, 'name_taken', `You already have a skill named "${name}".`, { suggestion })
  }
  return name
}

/** Lineage and provenance of a version saved from a plugin's proposal. */
export interface SkillLineage {
  derivedFromId: string | null
  lineageRootId: string
  version: number
  originChangeSetId: string
  originPluginId: string
  originPluginVersion: string
  /** Its own origin and its source's chain (originPair). */
  originChain: string[]
  /** The source's releases that still apply: text its owner accepted stays accepted. */
  releasedFor: string[]
}

/** How a plugin version is named in originChain, releasedFor and quarantinedFor. */
export const originPair = (pluginId: string, version: string) => `${pluginId}@${version}`

export interface CreateUserSkillInput {
  userId: string
  name: unknown
  description?: unknown
  content: unknown
  lineage?: SkillLineage
}

/** Create one skill; the caller holds lockUserSkills(tx, input.userId). */
export async function createUserSkillTx(tx: Tx, input: CreateUserSkillInput): Promise<UserAttackSkill> {
  const content = readContent(input.content)
  const description = readDescription(input.description)
  const name = await readName(tx, input.userId, input.name)
  const count = await tx.userAttackSkill.count({ where: { userId: input.userId } })
  if (count >= MAX_SKILLS_PER_USER) {
    throw new UserSkillError(409, 'skill_limit',
      `You have ${MAX_SKILLS_PER_USER} skills, the maximum. Delete one in Global Settings first.`,
      { limit: MAX_SKILLS_PER_USER })
  }
  return tx.userAttackSkill.create({
    data: { userId: input.userId, name, description, content, ...(input.lineage ?? {}) },
  })
}

function auditFields(skill: Pick<UserAttackSkill, 'name' | 'content'>) {
  return { name: skill.name, contentSha256: contentSha256(skill.content) }
}

function withOwner(actor: AuditActor, after: Record<string, unknown>) {
  return actor.onBehalfOf ? { ...after, onBehalfOf: actor.onBehalfOf } : after
}

export async function createUserSkill(input: CreateUserSkillInput, actor: AuditActor) {
  const skill = await prisma.$transaction(async (tx) => {
    await lockUserSkills(tx, input.userId)
    return createUserSkillTx(tx, input)
  })
  await writeAudit({
    actorId: actor.actorId,
    action: 'user_attack_skill.create',
    targetType: USER_SKILL_AUDIT_TARGET,
    targetId: skill.id,
    after: withOwner(actor, { ...auditFields(skill), userId: input.userId }),
    source: actor.source,
  })
  return pick(skill)
}

function pick(skill: UserAttackSkill) {
  return Object.fromEntries(Object.keys(USER_SKILL_SELECT).map((k) => [k, skill[k as keyof UserAttackSkill]]))
}

export interface UpdateUserSkillInput {
  userId: string
  skillId: string
  name?: unknown
  description?: unknown
  content?: unknown
}

export async function updateUserSkill(input: UpdateUserSkillInput, actor: AuditActor) {
  const { before, after } = await prisma.$transaction(async (tx) => {
    await lockUserSkills(tx, input.userId)
    const existing = await tx.userAttackSkill.findFirst({ where: { id: input.skillId, userId: input.userId } })
    if (!existing) throw new UserSkillError(404, 'not_found', 'Skill not found')
    const data: Prisma.UserAttackSkillUpdateInput = {}
    // The edit window sends the name with every save; an unchanged one is not checked again, so a
    // name stored before the rules (a duplicate, a long one) never blocks editing the rest.
    const unchangedName = typeof input.name === 'string' && normalizeName(input.name) === existing.name
    if (input.name !== undefined && !unchangedName) data.name = await readName(tx, input.userId, input.name, existing.id)
    if (input.description !== undefined) {
      data.description = input.description === '' ? null : readDescription(input.description)
    }
    if (input.content !== undefined) data.content = readContent(input.content)
    const updated = Object.keys(data).length
      ? await tx.userAttackSkill.update({ where: { id: existing.id }, data })
      : existing
    return { before: existing, after: updated }
  })
  await writeAudit({
    actorId: actor.actorId,
    action: 'user_attack_skill.update',
    targetType: USER_SKILL_AUDIT_TARGET,
    targetId: after.id,
    before: auditFields(before),
    after: withOwner(actor, {
      ...auditFields(after),
      changed: (['name', 'description', 'content'] as const).filter((k) => before[k] !== after[k]),
    }),
    source: actor.source,
  })
  return pick(after)
}

/** Remove `skillId` from every project of `userId` that names it; returns how many changed. */
async function stripFromProjects(tx: Tx, userId: string, skillId: string): Promise<string[]> {
  const projects = await tx.project.findMany({ where: { userId }, select: { id: true, attackSkillConfig: true } })
  const changed: string[] = []
  for (const project of projects) {
    const config = project.attackSkillConfig
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue
    const user = (config as Prisma.JsonObject).user
    if (!user || typeof user !== 'object' || Array.isArray(user) || !(skillId in user)) continue
    const { [skillId]: _removed, ...rest } = user as Prisma.JsonObject
    // Through Prisma, never raw SQL: updatedAt moves, so a form holding the old map gets a
    // stale-save refusal instead of writing the deleted id back.
    await tx.project.update({
      where: { id: project.id },
      data: { attackSkillConfig: { ...(config as Prisma.JsonObject), user: rest } },
    })
    changed.push(project.id)
  }
  return changed
}

/** How many of the skill's proposals a delete would remove (for the confirmation). */
export async function pendingProposalCount(userId: string, skillId: string): Promise<number> {
  const rows = await prisma.pluginOverride.findMany({
    where: { extensionPoint: 'user_skill.text', scopeType: 'user', scopeId: userId, targetGroup: skillId, status: 'proposed' },
    select: { changeSetId: true },
  })
  return new Set(rows.map((r) => r.changeSetId)).size
}

export async function deleteUserSkill(input: { userId: string; skillId: string }, actor: AuditActor) {
  const result = await prisma.$transaction(async (tx) => {
    await lockUserSkills(tx, input.userId)
    const existing = await tx.userAttackSkill.findFirst({ where: { id: input.skillId, userId: input.userId } })
    if (!existing) throw new UserSkillError(404, 'not_found', 'Skill not found')
    const proposals = await deleteUserSkillProposalsTx(tx, input.userId, existing.id)
    await tx.userAttackSkill.delete({ where: { id: existing.id } })
    const projects = await stripFromProjects(tx, input.userId, existing.id)
    return { existing, proposals, projects }
  }, { timeout: 20_000 })
  for (const set of result.proposals) {
    await writeAudit({
      actorId: actor.actorId,
      action: 'plugin.override.delete',
      targetType: 'plugin_change_set',
      targetId: set.changeSetId,
      after: withOwner(actor, {
        pluginId: set.pluginId, point: 'user_skill.text', targetGroup: input.skillId,
        scope: 'user', scopeId: input.userId, reason: 'source_deleted',
      }),
      source: actor.source,
    })
  }
  await writeAudit({
    actorId: actor.actorId,
    action: 'user_attack_skill.delete',
    targetType: USER_SKILL_AUDIT_TARGET,
    targetId: input.skillId,
    before: auditFields(result.existing),
    after: withOwner(actor, { deletedProposals: result.proposals.length, projectsUpdated: result.projects.length }),
    source: actor.source,
  })
  return { deletedProposals: result.proposals.length, projectsUpdated: result.projects.length }
}

/**
 * Quarantine a skill whose originChain holds the revoked `pair`, under the owner's lock the
 * caller holds. False when it is already quarantined, or its owner released it from that
 * revocation after reading it.
 */
export async function quarantineUserSkillTx(tx: Tx, skillId: string, pair: string, reason: string): Promise<boolean> {
  const skill = await tx.userAttackSkill.findFirst({ where: { id: skillId }, select: { quarantinedAt: true, releasedFor: true } })
  if (!skill || skill.quarantinedAt || skill.releasedFor.includes(pair)) return false
  await tx.userAttackSkill.update({
    where: { id: skillId },
    data: { quarantinedAt: now(), quarantineReason: reason, quarantinedFor: pair },
  })
  return true
}

/** Make a never-versioned skill the first of its family, when a version is saved from it. */
export async function startLineageTx(tx: Tx, skill: { id: string; lineageRootId: string | null; version: number | null }) {
  if (skill.lineageRootId) return
  await tx.userAttackSkill.update({ where: { id: skill.id }, data: { lineageRootId: skill.id, version: skill.version ?? 1 } })
}

/**
 * Clear a quarantine. The caller has checked that the actor IS the owner. The release is
 * recorded for the revocation that caused it (releasedFor), so the reconciliation that still
 * sees that revocation does not quarantine it again, while a later one still can.
 */
export async function releaseUserSkill(input: { userId: string; skillId: string }, actor: AuditActor) {
  const skill = await prisma.$transaction(async (tx) => {
    await lockUserSkills(tx, input.userId)
    const existing = await tx.userAttackSkill.findFirst({ where: { id: input.skillId, userId: input.userId } })
    if (!existing) throw new UserSkillError(404, 'not_found', 'Skill not found')
    if (!existing.quarantinedAt) throw new UserSkillError(409, 'not_quarantined', 'This skill is not quarantined.')
    return {
      existing,
      updated: await tx.userAttackSkill.update({
        where: { id: existing.id },
        data: {
          quarantinedAt: null,
          quarantineReason: null,
          quarantinedFor: null,
          releasedFor: existing.quarantinedFor && !existing.releasedFor.includes(existing.quarantinedFor)
            ? [...existing.releasedFor, existing.quarantinedFor]
            : existing.releasedFor,
        },
      }),
    }
  })
  await writeAudit({
    actorId: actor.actorId,
    action: 'user_attack_skill.release',
    targetType: USER_SKILL_AUDIT_TARGET,
    targetId: input.skillId,
    before: { ...auditFields(skill.existing), quarantineReason: skill.existing.quarantineReason, quarantinedFor: skill.existing.quarantinedFor },
    after: withOwner(actor, auditFields(skill.updated)),
    source: actor.source,
  })
  return pick(skill.updated)
}

/** The route answer for a UserSkillError (`{error, code, ...}`), or null for anything else. */
export function userSkillErrorResponse(e: unknown): NextResponse | null {
  if (!(e instanceof UserSkillError)) return null
  return NextResponse.json({ error: e.message, code: e.code, ...e.extra }, { status: e.status })
}
