/**
 * One-time backfill for the change that made a missing user-skill toggle mean OFF.
 *
 * Before it, the agent ran every user skill a project did not set to false, while the
 * project form showed a skill with no key as off. So every existing (project, owner
 * skill) pair with no key gets an explicit `true`, which is exactly what the agent ran:
 * nothing that runs today stops, and from then on the form and the agent agree and a new
 * skill starts off. Only `attackSkillConfig.user` is touched (created when absent); a
 * project already holding 20 enabled skills (the old per-user cap) gets none, and the rest
 * are filled by name, then id, up to 20. Saved presets that carry a `user` map get the same.
 *
 * Run once: the marker is an AuditLog row (`system.user_skill_toggles_backfill`), written
 * in the same transaction as the toggles, under an advisory lock so two webapp copies
 * booting together do it once. Rows are written through Prisma so `updatedAt` moves: a
 * form opened before the upgrade gets a stale-save refusal instead of writing the old map
 * back, which would now turn those skills off.
 *
 * Only skills and projects that existed when the new code FIRST started are filled. That
 * moment is its own AuditLog row (`system.user_skill_toggles_cutoff`), written before the
 * backfill and kept when the backfill fails, so a run on a later boot (after a failure, or
 * after a stretch in dev mode) never turns on a skill uploaded meanwhile and left off.
 *
 * Runs from the webapp entrypoint AFTER `db push`, and from the dev container's command.
 * Never fatal: a failure is logged and the next boot tries again (no marker was written).
 */
import { PrismaClient } from '@prisma/client'
import { pathToFileURL } from 'node:url'

export const MARKER_ACTION = 'system.user_skill_toggles_backfill'
export const CUTOFF_ACTION = 'system.user_skill_toggles_cutoff'
// MAX_ENABLED_USER_SKILLS_PER_PROJECT in src/lib/userSkills.ts.
export const MAX_ENABLED = 20

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * When the code that reads a missing toggle as OFF first started: the database time of the
 * cutoff row, written by the first call and read by every later one.
 */
export async function recordCutoff(prisma) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${CUTOFF_ACTION}))`
    const existing = await tx.auditLog.findFirst({ where: { action: CUTOFF_ACTION }, orderBy: { createdAt: 'asc' } })
    if (existing) return existing.createdAt
    const row = await tx.auditLog.create({ data: { action: CUTOFF_ACTION, targetType: 'system', source: 'system' } })
    return row.createdAt
  })
}

/** Returns {done: false} when the marker existed, else what it wrote. */
export async function backfillUserSkillToggles(prisma) {
  const cutoff = await recordCutoff(prisma)
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${MARKER_ACTION}))`
    const marker = await tx.auditLog.findFirst({ where: { action: MARKER_ACTION }, select: { id: true } })
    if (marker) return { done: false }

    const skills = await tx.userAttackSkill.findMany({
      select: { id: true, userId: true, name: true, quarantinedAt: true, createdAt: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    })
    // Every skill of the owner counts toward the 20, one turned on after the cutoff included;
    // only the ones that existed before it, and are not quarantined (turned on only by their
    // owner, after a release), are filled in.
    const ownedIds = new Map()
    const fillable = new Map()
    for (const s of skills) {
      ownedIds.set(s.userId, (ownedIds.get(s.userId) ?? new Set()).add(s.id))
      if (!s.quarantinedAt && !(s.createdAt > cutoff)) fillable.set(s.userId, [...(fillable.get(s.userId) ?? []), s])
    }
    const owners = [...fillable.keys()]

    /** The `user` map with the owner's skills that have no key turned on, and how many. */
    function filled(map, ownerId) {
      const user = isPlainObject(map) ? { ...map } : {}
      // A stale id of a skill the owner does not have (an imported project) never ran, and
      // must not crowd out one that did.
      const ids = ownedIds.get(ownerId) ?? new Set()
      let enabled = Object.keys(user).filter((id) => ids.has(id) && user[id] === true).length
      let wrote = 0
      for (const skill of fillable.get(ownerId) ?? []) {
        if (Object.hasOwn(user, skill.id) || enabled >= MAX_ENABLED) continue
        user[skill.id] = true
        enabled++
        wrote++
      }
      return { user, wrote }
    }

    // A project or preset created after the cutoff started with every user skill off.
    const projects = (await tx.project.findMany({
      where: { userId: { in: owners } },
      select: { id: true, userId: true, attackSkillConfig: true, createdAt: true },
    })).filter((p) => !(p.createdAt > cutoff))
    let projectsChanged = 0
    let keysWritten = 0
    for (const project of projects) {
      const config = project.attackSkillConfig
      if (!isPlainObject(config)) continue
      const { user, wrote } = filled(config.user, project.userId)
      if (wrote === 0 && isPlainObject(config.user)) continue
      await tx.project.update({ where: { id: project.id }, data: { attackSkillConfig: { ...config, user } } })
      projectsChanged++
      keysWritten += wrote
    }

    // A saved preset that carries a `user` map applies it as stored, so it gets the same keys:
    // under the old rule its missing ones meant on. One without a map keeps the project's.
    const presets = (await tx.userProjectPreset.findMany({
      where: { userId: { in: owners } },
      select: { id: true, userId: true, settings: true, createdAt: true },
    })).filter((p) => !(p.createdAt > cutoff))
    let presetsChanged = 0
    for (const preset of presets) {
      const settings = preset.settings
      const config = isPlainObject(settings) ? settings.attackSkillConfig : null
      if (!isPlainObject(config) || !isPlainObject(config.user)) continue
      const { user, wrote } = filled(config.user, preset.userId)
      if (wrote === 0) continue
      await tx.userProjectPreset.update({
        where: { id: preset.id },
        data: { settings: { ...settings, attackSkillConfig: { ...config, user } } },
      })
      presetsChanged++
      keysWritten += wrote
    }

    await tx.auditLog.create({
      data: {
        action: MARKER_ACTION,
        targetType: 'system',
        source: 'system',
        after: { projects: projectsChanged, presets: presetsChanged, keysWritten },
      },
    })
    return { done: true, projects: projectsChanged, presets: presetsChanged, keysWritten }
  }, { timeout: 300_000, maxWait: 30_000 })
}

async function main() {
  const prisma = new PrismaClient()
  try {
    const result = await backfillUserSkillToggles(prisma)
    if (result.done) {
      console.log(`[skills] user-skill toggles made explicit: ${result.keysWritten} key(s) in ${result.projects} project(s) and ${result.presets} preset(s).`)
    }
  } catch (err) {
    console.error('[skills] could not backfill user-skill toggles (retried next boot):', err?.message || err)
  } finally {
    await prisma.$disconnect().catch(() => {})
  }
}

// Imported by the tests without running; executed by the entrypoint.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
