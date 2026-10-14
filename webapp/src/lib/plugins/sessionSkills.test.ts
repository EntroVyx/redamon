/**
 * The skills a session used (sessionSkills.ts), read from its `phase_update` rows only: a
 * turn is a distinct iteration_count decided by its LAST row; a row is attributed by its
 * `skill_workflow` record, else by its label under the pre-D6 and built-in rules; user
 * skills are looked up for the conversation's owner only, and say why they cannot be picked.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'crypto'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))

import { createFakePrisma, type FakePrisma, type Row } from './__testing__/fakePrisma'
import { setNowForTests } from './clock'
import { holdsCredentials, sessionSkills, suggestedSkill, type SessionSkill } from './sessionSkills'

const CONV = 'conv-1'
const OWNER = 'user-alice'
const OTHER = 'user-bob'
const T0 = Date.parse('2026-10-09T10:00:00.000Z')
const sha16 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16)

let db: FakePrisma
let seq = 0
beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  seq = 0
  setNowForTests(() => new Date(T0))
  db.seed('user', [
    { id: OWNER, email: 'alice@example.com' },
    { id: OTHER, email: 'bob@example.com' },
  ])
  db.seed('conversation', [{ id: CONV, sessionId: 'session-1', userId: OWNER, projectId: 'project-1' }])
})
afterEach(() => setNowForTests(null))

interface PhaseRow {
  iteration: unknown
  label?: string
  phase?: string
  /** undefined: the key is absent; null: present and null. */
  workflow?: Record<string, unknown> | null
  seqNum?: number
  at?: number
  id?: string
  conversationId?: string
  type?: string
}

function phase(rows: PhaseRow[]) {
  db.seed('chatMessage', rows.map((r) => {
    const data: Row = { current_phase: r.phase ?? 'informational', iteration_count: r.iteration }
    if (r.label !== undefined) data.attack_path_type = r.label
    if (r.workflow !== undefined) data.skill_workflow = r.workflow
    const row: Row = {
      conversationId: r.conversationId ?? CONV,
      sequenceNum: r.seqNum ?? ++seq,
      type: r.type ?? 'phase_update',
      createdAt: new Date(r.at ?? T0 + (r.seqNum ?? seq) * 1000),
      data,
    }
    if (r.id) row.id = r.id
    return row
  }))
}

const userRec = (id: string, content = 'text') => ({ skillId: `user_skill:${id}`, kind: 'user', contentSha256: sha16(content) })
const by = (skills: SessionSkill[], ref: string) => skills.find((s) => s.ref === ref)

describe('turns', () => {
  test('a turn is a distinct iteration_count, decided by its last phase_update row', async () => {
    phase([
      { iteration: 1, label: 'sql_injection' },
      { iteration: 1, label: 'xss' },
      { iteration: 2, label: 'sql_injection' },
      { iteration: 2, label: 'sql_injection' },
      { iteration: 3, label: 'sql_injection' },
    ])
    const skills = await sessionSkills(CONV, OWNER)
    expect(skills.map((s) => [s.ref, s.turns])).toEqual([['sql_injection', 2], ['xss', 1]])
    expect(by(skills, 'xss')).toMatchObject({ kind: 'builtin', point: 'skill.text', target: 'xss', name: 'Cross-Site Scripting', lastSeq: 2 })
    expect(by(skills, 'sql_injection')).toMatchObject({ lastSeq: 5, exists: true, selectable: true, byLabel: true })
  })

  test('rows without an integer iteration_count, other message types and other conversations are ignored', async () => {
    phase([
      { iteration: 1, label: 'xss' },
      { iteration: '2', label: 'sql_injection' },
      { iteration: 2.5, label: 'sql_injection' },
      { iteration: null, label: 'sql_injection' },
      { iteration: 3, label: 'sql_injection', type: 'thinking' },
      { iteration: 4, label: 'sql_injection', conversationId: 'conv-other' },
    ])
    expect((await sessionSkills(CONV, OWNER)).map((s) => s.ref)).toEqual(['xss'])
  })

  test('a repeated sequenceNum is ordered by createdAt, then id: the later row decides the turn', async () => {
    // Seeded in reverse, so only the ORDER BY can put them right.
    phase([
      { iteration: 1, label: 'xss', seqNum: 5, at: T0 + 2000 },
      { iteration: 1, label: 'sql_injection', seqNum: 5, at: T0 + 1000 },
    ])
    expect((await sessionSkills(CONV, OWNER)).map((s) => s.ref)).toEqual(['xss'])

    db = createFakePrisma()
    h.db = db as unknown as Record<string, unknown>
    phase([
      { iteration: 1, label: 'ssrf', seqNum: 7, at: T0, id: 'b-row' },
      { iteration: 1, label: 'xss', seqNum: 7, at: T0, id: 'a-row' },
    ])
    expect((await sessionSkills(CONV, OWNER)).map((s) => s.ref)).toEqual(['ssrf'])
  })

  test('the order is (sequenceNum, createdAt, id), not insertion: a lower sequenceNum seeded last does not decide', async () => {
    phase([
      { iteration: 1, label: 'xss', seqNum: 9 },
      { iteration: 1, label: 'sql_injection', seqNum: 3 },
    ])
    expect((await sessionSkills(CONV, OWNER)).map((s) => s.ref)).toEqual(['xss'])
  })
})

describe('attribution', () => {
  test('a skill_workflow record wins over the label: a built-in id', async () => {
    phase([{ iteration: 1, label: 'sql_injection', workflow: { skillId: 'ssrf', revision: 2 } }])
    expect((await sessionSkills(CONV, OWNER)).map((s) => [s.ref, s.byLabel])).toEqual([['ssrf', false]])
  })

  test('a user record: kind user, user_skill:<id>, with its contentSha256', async () => {
    db.seed('userAttackSkill', [{ id: 'skone', userId: OWNER, name: 'My SQLi flow', content: 'Step one.' }])
    phase([{ iteration: 1, label: 'sql_injection', workflow: userRec('skone', 'Step one.') }])
    expect(await sessionSkills(CONV, OWNER)).toEqual([{
      ref: 'user_skill:skone', kind: 'user', point: 'user_skill.text', target: 'skone', name: 'My SQLi flow',
      turns: 1, lastSeq: 1, exists: true, selectable: true, lastContentSha256: sha16('Step one.'), byLabel: false,
    }])
  })

  test('an object record that names nothing known counts for nothing, and never falls back to the label', async () => {
    phase([
      { iteration: 1, label: 'xss', workflow: { skillId: 'not_a_skill' } },
      { iteration: 2, label: 'xss', workflow: { skillId: 'user_skill:skone' } },
      { iteration: 3, label: 'xss', workflow: { skillId: 'user_skill:Bad-Id', kind: 'user' } },
      { iteration: 4, label: 'xss', workflow: [] as unknown as Record<string, unknown> },
    ])
    // An array is not an object record: row 4 falls back to the label rules, and has the
    // skill_workflow key, so its built-in label does not count either.
    expect(await sessionSkills(CONV, OWNER)).toEqual([])
  })

  test('a pre-D6 session (no user record anywhere): a user label counts in every phase, byLabel', async () => {
    db.seed('userAttackSkill', [{ id: 'skone', userId: OWNER, name: 'Flow', content: 'Do things.' }])
    phase([
      { iteration: 1, label: 'user_skill:skone', phase: 'informational' },
      { iteration: 2, label: 'user_skill:skone', phase: 'exploitation' },
      { iteration: 3, label: 'user_skill:skone', phase: 'post_exploitation' },
      { iteration: 4, label: 'user_skill:skone', phase: 'exploitation', workflow: null },
    ])
    const [s] = await sessionSkills(CONV, OWNER)
    expect(s).toMatchObject({ ref: 'user_skill:skone', turns: 4, byLabel: true, lastContentSha256: null, exists: true })
  })

  test('a session that holds a user record: a user label on a row with no record is not counted', async () => {
    db.seed('userAttackSkill', [
      { id: 'skone', userId: OWNER, name: 'Flow', content: 'Do things.' },
      { id: 'sktwo', userId: OWNER, name: 'Other', content: 'Other things.' },
    ])
    phase([
      { iteration: 1, label: 'user_skill:skone', workflow: userRec('skone', 'Do things.') },
      // The skill was off: the label stayed, nothing rendered.
      { iteration: 2, label: 'user_skill:skone', workflow: null },
      { iteration: 3, label: 'user_skill:sktwo' },
    ])
    const skills = await sessionSkills(CONV, OWNER)
    expect(skills.map((s) => [s.ref, s.turns, s.byLabel])).toEqual([['user_skill:skone', 1, false]])
  })

  test('the user record may sit on a turn that is not counted (not its last row): the session still has one', async () => {
    db.seed('userAttackSkill', [{ id: 'skone', userId: OWNER, name: 'Flow', content: 'Do things.' }])
    phase([
      { iteration: 1, label: 'user_skill:skone', workflow: userRec('skone', 'Do things.') },
      { iteration: 1, label: 'user_skill:skone' },
    ])
    expect(await sessionSkills(CONV, OWNER)).toEqual([])
  })

  test('a built-in label counts only on a row with NO skill_workflow key, and outside post_exploitation', async () => {
    phase([
      { iteration: 1, label: 'sql_injection' },
      { iteration: 2, label: 'sql_injection', workflow: null },
      { iteration: 3, label: 'sql_injection', phase: 'post_exploitation' },
      { iteration: 4, label: 'sql_injection', phase: 'exploitation' },
      { iteration: 5, label: 'not_a_builtin_label' },
    ])
    const [s, ...rest] = await sessionSkills(CONV, OWNER)
    expect(rest).toEqual([])
    expect(s).toMatchObject({ ref: 'sql_injection', turns: 2, lastSeq: 4, byLabel: true })
    expect('lastContentSha256' in s).toBe(false)
  })

  test('a built-in record counts in post_exploitation too (the record says the playbook was in the prompt)', async () => {
    phase([{ iteration: 1, label: 'sql_injection', phase: 'post_exploitation', workflow: { skillId: 'sql_injection', revision: 1 } }])
    expect((await sessionSkills(CONV, OWNER)).map((s) => [s.ref, s.byLabel])).toEqual([['sql_injection', false]])
  })

  test('byLabel is true when any of its turns was counted by label alone', async () => {
    phase([
      { iteration: 1, label: 'xss', workflow: { skillId: 'xss' } },
      { iteration: 2, label: 'xss' },
    ])
    expect((await sessionSkills(CONV, OWNER))[0]).toMatchObject({ ref: 'xss', turns: 2, byLabel: true })
  })

  test('lastContentSha256 is the hash of the last turn that recorded one', async () => {
    db.seed('userAttackSkill', [{ id: 'skone', userId: OWNER, name: 'Flow', content: 'v2 text' }])
    phase([
      { iteration: 1, workflow: userRec('skone', 'v1 text') },
      { iteration: 2, workflow: userRec('skone', 'v2 text') },
      { iteration: 3, workflow: { skillId: 'user_skill:skone', kind: 'user' } },
    ])
    const [s] = await sessionSkills(CONV, OWNER)
    expect(s.turns).toBe(3)
    // The third record carries no hash: the last one known is reported as null, not v2's.
    expect(s.lastContentSha256).toBeNull()

    db = createFakePrisma()
    h.db = db as unknown as Record<string, unknown>
    db.seed('userAttackSkill', [{ id: 'skone', userId: OWNER, name: 'Flow', content: 'v2 text' }])
    phase([
      { iteration: 1, workflow: userRec('skone', 'v1 text') },
      { iteration: 2, workflow: userRec('skone', 'v2 text') },
    ])
    expect((await sessionSkills(CONV, OWNER))[0].lastContentSha256).toBe(sha16('v2 text'))
  })
})

describe('the user skills, for the owner only', () => {
  test("another user's skill id: exists false, reason deleted, name null, not selectable", async () => {
    db.seed('userAttackSkill', [{ id: 'skbob', userId: OTHER, name: "Bob's flow", content: 'Bob text.' }])
    phase([{ iteration: 1, workflow: userRec('skbob', 'Bob text.') }])
    expect(await sessionSkills(CONV, OWNER)).toEqual([{
      ref: 'user_skill:skbob', kind: 'user', point: 'user_skill.text', target: 'skbob', name: null,
      turns: 1, lastSeq: 1, exists: false, selectable: false, reason: 'deleted', lastContentSha256: sha16('Bob text.'), byLabel: false,
    }])
  })

  test('a deleted skill: the same answer', async () => {
    phase([{ iteration: 1, workflow: userRec('skgone') }])
    expect((await sessionSkills(CONV, OWNER))[0]).toMatchObject({ exists: false, selectable: false, reason: 'deleted', name: null })
  })

  test('quarantined: exists, not selectable, reason quarantined (before the credential check)', async () => {
    db.seed('userAttackSkill', [{
      id: 'skq', userId: OWNER, name: 'Quarantined', content: 'Sign with AKIAIOSFODNN7EXAMPLE.', quarantinedAt: new Date(T0), quarantineReason: 'plugin_version_revoked',
    }])
    phase([{ iteration: 1, workflow: userRec('skq') }])
    expect((await sessionSkills(CONV, OWNER))[0]).toMatchObject({ exists: true, name: 'Quarantined', selectable: false, reason: 'quarantined' })
  })

  test('credential-shaped text: not selectable, reason credentials', async () => {
    db.seed('userAttackSkill', [{ id: 'skc', userId: OWNER, name: 'Creds', content: 'Sign requests with AKIAIOSFODNN7EXAMPLE then enumerate.' }])
    phase([{ iteration: 1, workflow: userRec('skc') }])
    expect((await sessionSkills(CONV, OWNER))[0]).toMatchObject({ exists: true, selectable: false, reason: 'credentials' })
  })

  test('a key in the name or the description counts too: a plugin is given both', async () => {
    db.seed('userAttackSkill', [
      { id: 'skdesc', userId: OWNER, name: 'Flow', description: 'Signs with AKIAIOSFODNN7EXAMPLE.', content: 'Enumerate.' },
    ])
    phase([{ iteration: 1, workflow: userRec('skdesc') }])
    expect((await sessionSkills(CONV, OWNER))[0]).toMatchObject({ selectable: false, reason: 'credentials' })
  })

  test('a selectable skill carries no reason key', async () => {
    db.seed('userAttackSkill', [{ id: 'skok', userId: OWNER, name: 'Fine', content: 'Enumerate example.com subdomains.' }])
    phase([{ iteration: 1, workflow: userRec('skok') }])
    const [s] = await sessionSkills(CONV, OWNER)
    expect(s.selectable).toBe(true)
    expect('reason' in s).toBe(false)
  })

  test('no user skill in the session: the skill table is never read', async () => {
    phase([{ iteration: 1, label: 'xss' }])
    const spy = vi.spyOn(db.userAttackSkill, 'findMany')
    await sessionSkills(CONV, OWNER)
    expect(spy).not.toHaveBeenCalled()
  })

  test('holdsCredentials: a key or token in a recognised format', () => {
    expect(holdsCredentials('Sign with AKIAIOSFODNN7EXAMPLE.')).toBe(true)
    expect(holdsCredentials('-----BEGIN RSA PRIVATE' + ' KEY-----\nMIIB\n')).toBe(true)
    expect(holdsCredentials('Check the password policy of example.com.')).toBe(false)
  })

  // The transcript masker also takes these for values; as a refusal they blocked about half of
  // the community skills.
  test.each([
    '1. Test Basic authentication on the login form.',
    '2. Check token expiration and refresh handling.',
    '### 6.5 API Key/Token Extraction Patterns',
    '-H "Authorization: Bearer BASIC_ACTOR_TOKEN"',
    'Try default credentials such as password: admin123.',
  ])('holdsCredentials: prose and placeholders are not credentials (%s)', (text) => {
    expect(holdsCredentials(text)).toBe(false)
  })
})

describe('order and suggestion', () => {
  test('most turns first; ties to the latest (highest lastSeq)', async () => {
    db.seed('userAttackSkill', [{ id: 'skone', userId: OWNER, name: 'Flow', content: 'Do things.' }])
    phase([
      { iteration: 1, label: 'xss' },
      { iteration: 2, workflow: userRec('skone') },
      { iteration: 3, label: 'sql_injection' },
      { iteration: 4, label: 'sql_injection' },
      { iteration: 5, label: 'xss' },
    ])
    const skills = await sessionSkills(CONV, OWNER)
    // sql_injection 2 turns (last 4), xss 2 turns (last 5), the user skill 1.
    expect(skills.map((s) => s.ref)).toEqual(['xss', 'sql_injection', 'user_skill:skone'])
    expect(suggestedSkill(skills)?.ref).toBe('xss')
  })

  test('the suggestion skips what cannot be picked', async () => {
    db.seed('userAttackSkill', [{ id: 'skc', userId: OWNER, name: 'Creds', content: 'Sign with AKIAIOSFODNN7EXAMPLE.' }])
    phase([
      { iteration: 1, workflow: userRec('skc') },
      { iteration: 2, workflow: userRec('skc') },
      { iteration: 3, workflow: userRec('skc') },
      { iteration: 4, label: 'xss' },
    ])
    const skills = await sessionSkills(CONV, OWNER)
    expect(skills[0]).toMatchObject({ ref: 'user_skill:skc', selectable: false })
    expect(suggestedSkill(skills)?.ref).toBe('xss')
  })

  test('nothing selectable: no suggestion', async () => {
    phase([{ iteration: 1, workflow: userRec('skgone') }])
    expect(suggestedSkill(await sessionSkills(CONV, OWNER))).toBeNull()
    expect(suggestedSkill([])).toBeNull()
  })
})
