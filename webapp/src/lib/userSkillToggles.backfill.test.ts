/**
 * The one-time backfill that made a missing user-skill toggle mean OFF without stopping
 * anything that ran (scripts/backfill-user-skill-toggles.mjs, plan 0.A.1, D9): every owner
 * skill with no key gets `true`, at most 20 enabled per project, only `user` touched, and
 * an AuditLog marker written in the same transaction so a second boot does nothing.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createFakePrisma, type FakePrisma } from '@/lib/plugins/__testing__/fakePrisma'
import { MAX_ENABLED_USER_SKILLS_PER_PROJECT } from './userSkills'
import { setNowForTests } from '@/lib/plugins/clock'
import { CUTOFF_ACTION, MARKER_ACTION, MAX_ENABLED, backfillUserSkillToggles } from '../../scripts/backfill-user-skill-toggles.mjs'

let db: FakePrisma

const BUILT_IN = { xss: true, rce: false }

function skills(owner: string, count: number) {
  // Seeded in reverse so "by name, then id" cannot come from insertion order.
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `${owner}_${String(count - 1 - i).padStart(2, '0')}`, userId: owner, name: `Skill ${String(count - 1 - i).padStart(2, '0')}`, content: 'x',
  }))
  db.seed('userAttackSkill', rows)
  return rows.map((r) => r.id).sort()
}

const config = (id: string) => db.rows('project').find((p) => p.id === id)!.attackSkillConfig as Record<string, unknown>
const userMap = (id: string) => config(id).user as Record<string, boolean>
const enabledCount = (m: Record<string, boolean>) => Object.values(m).filter((v) => v === true).length
const markers = () => db.rows('auditLog').filter((r) => r.action === MARKER_ACTION)
const cutoffs = () => db.rows('auditLog').filter((r) => r.action === CUTOFF_ACTION)

/** Records each project write; `fail` makes the first one throw. */
function instrument(fail = false) {
  const writes: string[] = []
  const tx = db.$transaction.bind(db)
  ;(db as unknown as Record<string, unknown>).$transaction = (fn: (t: FakePrisma) => Promise<unknown>) =>
    tx(async (t) => {
      const p = t.project as unknown as Record<string, (a: unknown) => Promise<unknown>>
      const update = p.update
      p.update = async (a) => {
        writes.push('update')
        if (fail) throw new Error('connection reset')
        return update(a)
      }
      p.updateMany = async () => { throw new Error('updateMany would leave updatedAt unmoved') }
      return fn(t)
    })
  return writes
}

beforeEach(() => {
  db = createFakePrisma()
})

describe('backfillUserSkillToggles', () => {
  test('exports the marker action and the same bound as the webapp', () => {
    expect(MARKER_ACTION).toBe('system.user_skill_toggles_backfill')
    expect(MAX_ENABLED).toBe(MAX_ENABLED_USER_SKILLS_PER_PROJECT)
  })

  test('writes true for every owner skill with no key, leaving explicit values and builtIn alone', async () => {
    const [s0, s1, s2] = skills('alice', 3)
    db.seed('project', [{ id: 'p1', userId: 'alice', attackSkillConfig: { builtIn: BUILT_IN, user: { [s0]: false } } }])
    const out = await backfillUserSkillToggles(db)
    expect(out).toEqual({ done: true, projects: 1, presets: 0, keysWritten: 2 })
    expect(config('p1')).toEqual({ builtIn: BUILT_IN, user: { [s0]: false, [s1]: true, [s2]: true } })
  })

  test('creates user when absent', async () => {
    const ids = skills('alice', 2)
    db.seed('project', [{ id: 'p1', userId: 'alice', attackSkillConfig: { builtIn: BUILT_IN } }])
    await backfillUserSkillToggles(db)
    expect(config('p1')).toEqual({ builtIn: BUILT_IN, user: Object.fromEntries(ids.map((k) => [k, true])) })
  })

  test('a project whose owner skills all have a key is not written', async () => {
    const [s0, s1] = skills('alice', 2)
    db.seed('project', [{ id: 'p1', userId: 'alice', attackSkillConfig: { builtIn: {}, user: { [s0]: true, [s1]: false } } }])
    const writes = instrument()
    expect(await backfillUserSkillToggles(db)).toEqual({ done: true, projects: 0, presets: 0, keysWritten: 0 })
    expect(writes).toEqual([])
    expect(userMap('p1')).toEqual({ [s0]: true, [s1]: false })
  })

  test('never more than 20 enabled, filled by name then id', async () => {
    const ids = skills('alice', 25)
    db.seed('project', [
      { id: 'empty', userId: 'alice', attackSkillConfig: { builtIn: {}, user: {} } },
      { id: 'three_on', userId: 'alice', attackSkillConfig: { builtIn: {}, user: { [ids[24]]: true, [ids[23]]: true, [ids[22]]: true } } },
    ])
    const out = await backfillUserSkillToggles(db)
    expect(Object.keys(userMap('empty')).sort()).toEqual(ids.slice(0, 20))
    expect(enabledCount(userMap('empty'))).toBe(20)
    expect(enabledCount(userMap('three_on'))).toBe(20)
    expect(Object.keys(userMap('three_on')).sort()).toEqual([...ids.slice(0, 17), ...ids.slice(22)].sort())
    expect(out).toEqual({ done: true, projects: 2, presets: 0, keysWritten: 37 })
  })

  test("a project's stale ids for skills the owner no longer has do not use up the 20", async () => {
    // Before this change a deleted skill's toggle stayed in its projects, and the agent
    // ignored it: the owner's 3 un-keyed skills ran. The bound counts only owned skills
    // (D10), so they must still run after the backfill.
    const ids = skills('alice', 3)
    const stale = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`deleted_${i}`, true]))
    db.seed('project', [{ id: 'p1', userId: 'alice', attackSkillConfig: { builtIn: {}, user: stale } }])
    await backfillUserSkillToggles(db)
    for (const k of ids) expect(userMap('p1')[k]).toBe(true)
  })

  test('writes with update (so updatedAt moves), never updateMany', async () => {
    skills('alice', 1)
    db.seed('project', [{ id: 'p1', userId: 'alice', attackSkillConfig: { builtIn: {} } }])
    const writes = instrument()
    await backfillUserSkillToggles(db)
    expect(writes).toEqual(['update'])
  })

  test('writes the AuditLog marker with {projects, keysWritten}, under the advisory lock', async () => {
    skills('alice', 2)
    db.seed('project', [
      { id: 'p1', userId: 'alice', attackSkillConfig: { builtIn: {} } },
      { id: 'p2', userId: 'alice', attackSkillConfig: { builtIn: {}, user: {} } },
    ])
    await backfillUserSkillToggles(db)
    expect(markers()).toEqual([expect.objectContaining({
      action: MARKER_ACTION, targetType: 'system', source: 'system', after: { projects: 2, presets: 0, keysWritten: 4 },
    })])
    expect(db.rawCalls.some((c) => c.sql.includes('pg_advisory_xact_lock') && c.values[0] === MARKER_ACTION)).toBe(true)
  })

  test('the marker is written even when there was nothing to fill', async () => {
    expect(await backfillUserSkillToggles(db)).toEqual({ done: true, projects: 0, presets: 0, keysWritten: 0 })
    expect(markers()).toHaveLength(1)
  })

  test('a second run is a no-op: {done: false}, nothing written, one marker', async () => {
    skills('alice', 1)
    db.seed('project', [{ id: 'p1', userId: 'alice', attackSkillConfig: { builtIn: {} } }])
    await backfillUserSkillToggles(db)
    // A skill added after the first run must start OFF: the second run must not key it.
    db.seed('userAttackSkill', [{ id: 'alice_new', userId: 'alice', name: 'Added later', content: 'x' }])
    const before = db.rows('project')
    expect(await backfillUserSkillToggles(db)).toEqual({ done: false })
    expect(db.rows('project')).toEqual(before)
    expect(userMap('p1')).not.toHaveProperty('alice_new')
    expect(markers()).toHaveLength(1)
    expect(cutoffs()).toHaveLength(1)
  })

  test('two copies booting together: one does the work, the other finds the marker', async () => {
    skills('alice', 2)
    db.seed('project', [{ id: 'p1', userId: 'alice', attackSkillConfig: { builtIn: {} } }])
    const results = await Promise.all([backfillUserSkillToggles(db), backfillUserSkillToggles(db)])
    expect(results.filter((r) => r.done)).toHaveLength(1)
    expect(results.filter((r) => !r.done)).toEqual([{ done: false }])
    expect(markers()).toHaveLength(1)
    expect(cutoffs()).toHaveLength(1)
    expect(enabledCount(userMap('p1'))).toBe(2)
  })

  test("projects get only their own owner's skills; ownerless projects and owners without skills are untouched", async () => {
    const alice = skills('alice', 2)
    const bob = skills('bob', 1)
    db.seed('project', [
      { id: 'pa', userId: 'alice', attackSkillConfig: { builtIn: {} } },
      { id: 'pb', userId: 'bob', attackSkillConfig: { builtIn: {}, user: {} } },
      { id: 'pc', userId: 'carol', attackSkillConfig: { builtIn: {} } },
      { id: 'pn', userId: null, attackSkillConfig: { builtIn: {} } },
    ])
    await backfillUserSkillToggles(db)
    expect(Object.keys(userMap('pa')).sort()).toEqual(alice)
    expect(Object.keys(userMap('pb'))).toEqual(bob)
    expect(config('pc')).toEqual({ builtIn: {} })
    expect(config('pn')).toEqual({ builtIn: {} })
  })

  test('a project whose config is not an object is skipped', async () => {
    skills('alice', 1)
    db.seed('project', [
      { id: 'arr', userId: 'alice', attackSkillConfig: [] },
      { id: 'str', userId: 'alice', attackSkillConfig: 'broken' },
      { id: 'nul', userId: 'alice', attackSkillConfig: null },
    ])
    expect(await backfillUserSkillToggles(db)).toEqual({ done: true, projects: 0, presets: 0, keysWritten: 0 })
    expect(db.rows('project').map((p) => p.attackSkillConfig)).toEqual([[], 'broken', null])
  })

  test('a failure rolls back every toggle and writes no marker, so the next boot retries', async () => {
    skills('alice', 1)
    db.seed('project', [{ id: 'p1', userId: 'alice', attackSkillConfig: { builtIn: {} } }])
    instrument(true)
    await expect(backfillUserSkillToggles(db)).rejects.toThrow('connection reset')
    expect(config('p1')).toEqual({ builtIn: {} })
    expect(markers()).toHaveLength(0)
    // The moment the new code first started is kept for the retry.
    expect(cutoffs()).toHaveLength(1)
  })
})

describe('the cutoff: only what existed when the new code first started', () => {
  const T0 = Date.parse('2026-10-13T08:00:00.000Z')
  let t = T0
  beforeEach(() => {
    t = T0
    setNowForTests(() => new Date(t))
  })
  afterEach(() => setNowForTests(null))

  test('a retry after a failed first run leaves alone the skills and projects created after it', async () => {
    db.seed('userAttackSkill', [{ id: 'old', userId: 'alice', name: 'Old', content: 'x' }])
    db.seed('project', [{ id: 'p-old', userId: 'alice', attackSkillConfig: { builtIn: {} } }])
    t += 60_000
    const original = db.$transaction
    instrument(true)
    await expect(backfillUserSkillToggles(db)).rejects.toThrow('connection reset')
    ;(db as unknown as Record<string, unknown>).$transaction = original

    // Served for a while without the backfill: a skill uploaded (off), a project created.
    t += 60_000
    db.seed('userAttackSkill', [{ id: 'new', userId: 'alice', name: 'New', content: 'x' }])
    db.seed('project', [{ id: 'p-new', userId: 'alice', attackSkillConfig: { builtIn: {}, user: {} }, createdAt: new Date(t) }])

    t += 60_000
    expect(await backfillUserSkillToggles(db)).toEqual({ done: true, projects: 1, presets: 0, keysWritten: 1 })
    expect(userMap('p-old')).toEqual({ old: true })
    expect(userMap('p-new')).toEqual({})
  })

  test('a skill turned on after the cutoff counts toward the 20, so a retry never makes it the 21st', async () => {
    const old = Array.from({ length: 20 }, (_, i) => ({ id: `old${String(i).padStart(2, '0')}`, userId: 'alice', name: `Old ${String(i).padStart(2, '0')}`, content: 'x' }))
    db.seed('userAttackSkill', old)
    db.seed('project', [{ id: 'p1', userId: 'alice', attackSkillConfig: { builtIn: {} } }])
    t += 60_000
    const original = db.$transaction
    instrument(true)
    await expect(backfillUserSkillToggles(db)).rejects.toThrow('connection reset')
    ;(db as unknown as Record<string, unknown>).$transaction = original
    t += 60_000
    // Uploaded and turned on while the backfill had not run yet.
    db.seed('userAttackSkill', [{ id: 'mine', userId: 'alice', name: 'Mine', content: 'x' }])
    await db.project.update({ where: { id: 'p1' }, data: { attackSkillConfig: { builtIn: {}, user: { mine: true } } } })
    t += 60_000
    await backfillUserSkillToggles(db)
    expect(userMap('p1').mine).toBe(true)
    expect(enabledCount(userMap('p1'))).toBe(MAX_ENABLED)
  })

  test("a saved preset carrying a user map gets the owner's keys; one without a map, or saved after the cutoff, is left alone", async () => {
    db.seed('userAttackSkill', [
      { id: 'a1', userId: 'alice', name: 'A1', content: 'x' },
      { id: 'a2', userId: 'alice', name: 'A2', content: 'x' },
    ])
    db.seed('userProjectPreset', [
      { id: 'with-map', userId: 'alice', name: 'With map', settings: { attackSkillConfig: { builtIn: { xss: true }, user: { a1: false } }, naabuTopPorts: '100' }, createdAt: new Date(t) },
      { id: 'no-map', userId: 'alice', name: 'No map', settings: { attackSkillConfig: { builtIn: { xss: true } } }, createdAt: new Date(t) },
      { id: 'later', userId: 'alice', name: 'Later', settings: { attackSkillConfig: { builtIn: {}, user: {} } }, createdAt: new Date(t + 3_600_000) },
    ])
    const out = await backfillUserSkillToggles(db)
    expect(out).toMatchObject({ done: true, presets: 1 })
    const preset = (id: string) => db.rows('userProjectPreset').find((p) => p.id === id)!.settings as Record<string, Record<string, unknown>>
    expect(preset('with-map').attackSkillConfig).toEqual({ builtIn: { xss: true }, user: { a1: false, a2: true } })
    expect(preset('with-map').naabuTopPorts).toBe('100')
    expect(preset('no-map').attackSkillConfig).toEqual({ builtIn: { xss: true } })
    expect(preset('later').attackSkillConfig).toEqual({ builtIn: {}, user: {} })
  })

  test('the first call records the cutoff and every later call reads the same one', async () => {
    await backfillUserSkillToggles(db)
    t += 60_000
    await backfillUserSkillToggles(db)
    expect(cutoffs()).toHaveLength(1)
    expect(new Date(cutoffs()[0].createdAt as Date).getTime()).toBe(T0)
  })
})
