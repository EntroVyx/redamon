/**
 * Names of a user's own agent skills (plan §6, D7): the JS normalization names are stored
 * with, the problems a name is refused for, the version suffix, and the next-version
 * suggestion. The comparison key is SQL's; the fake approximates it for ASCII whitespace
 * (fakeNameKey), and userSkillNames.pg.integration.test.ts runs the real one.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach } from 'vitest'
import type { Prisma } from '@prisma/client'
import { createFakePrisma, type FakePrisma } from '@/lib/plugins/__testing__/fakePrisma'
import {
  isNameTaken, nameKeys, nameProblem, normalizeName, splitVersion, suggestVersionName,
} from './userSkillNames'
import { UserSkillError } from './userSkills'

let db: FakePrisma
// The fake as the client type the module takes (it implements the subset used).
let pg: Prisma.TransactionClient

function seed(rows: { id: string; userId?: string; name: string; lineageRootId?: string | null; version?: number | null }[]) {
  db.seed('userAttackSkill', rows.map((r) => ({ userId: 'alice', content: 'x', ...r })))
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

beforeEach(() => {
  db = createFakePrisma()
  pg = db as unknown as Prisma.TransactionClient
})

describe('normalizeName', () => {
  test('trims, collapses tabs, newlines and runs to one space', () => {
    expect(normalizeName('  My\tSQLi \n\n flow  ')).toBe('My SQLi flow')
  })

  test('treats Unicode spaces as whitespace (NBSP, ideographic space, line separator)', () => {
    expect(normalizeName(' My  flow　v2 ')).toBe('My flow v2')
  })

  test('composes to NFC: a decomposed "Café" equals the precomposed one', () => {
    const decomposed = 'Café'
    expect(normalizeName(decomposed)).toBe('Café')
    expect(normalizeName(decomposed)).toHaveLength(4)
  })

  test('an all-whitespace name is empty', () => {
    expect(normalizeName(' \t  ')).toBe('')
  })
})

describe('nameProblem', () => {
  test('an empty name is name_invalid (400)', () => {
    const p = nameProblem('')
    expect(p).toBeInstanceOf(UserSkillError)
    expect(p!.status).toBe(400)
    expect(p!.code).toBe('name_invalid')
  })

  test('100 characters pass, 101 are name_too_long', () => {
    expect(nameProblem('a'.repeat(100))).toBeNull()
    const p = nameProblem('a'.repeat(101))
    expect(p!.code).toBe('name_too_long')
    expect(p!.status).toBe(400)
  })

  test('an ordinary name with accents, emoji and punctuation passes', () => {
    expect(nameProblem('Café SQLi — v2 🔒 (draft)')).toBeNull()
  })

  test.each([
    ['NUL', '\u0000'], ['BEL', '\u0007'], ['ESC', '\u001B'], ['DEL', '\u007F'], ['C1 NEL', '\u0085'], ['C1 CSI', '\u009B'],
  ])('a control character (%s) is name_invalid', (_label, ch) => {
    expect(nameProblem(`My${ch}flow`)?.code).toBe('name_invalid')
  })

  test.each([
    ['ZERO WIDTH SPACE', '\u200B'], ['ZERO WIDTH NON-JOINER', '\u200C'], ['ZERO WIDTH JOINER', '\u200D'],
    ['WORD JOINER', '\u2060'], ['ZERO WIDTH NO-BREAK SPACE', '\uFEFF'],
  ])('a zero-width character (%s) is name_invalid', (_label, ch) => {
    expect(nameProblem(`My${ch}flow`)?.code).toBe('name_invalid')
  })

  // The whole Unicode Bidi_Control set: each reorders what is shown without being shown.
  test.each([
    ['ARABIC LETTER MARK', '\u061C'], ['LRM', '\u200E'], ['RLM', '\u200F'],
    ['LRE', '\u202A'], ['RLE', '\u202B'], ['PDF', '\u202C'], ['LRO', '\u202D'], ['RLO', '\u202E'],
    ['LRI', '\u2066'], ['RLI', '\u2067'], ['FSI', '\u2068'], ['PDI', '\u2069'],
  ])('a bidi control (%s) is name_invalid', (_label, ch) => {
    expect(nameProblem(`My${ch}flow`)?.code).toBe('name_invalid')
  })

  // Invisible format characters that make two names look the same with different keys,
  // the case the module's FORBIDDEN_IN_NAME comment says it closes.
  test.each([
    ['SOFT HYPHEN', '\u00AD'], ['FUNCTION APPLICATION', '\u2061'], ['INVISIBLE TIMES', '\u2062'],
    ['INVISIBLE SEPARATOR', '\u2063'], ['INVISIBLE PLUS', '\u2064'], ['MONGOLIAN VOWEL SEPARATOR', '\u180E'],
    ['TAG LATIN CAPITAL A', '\u{E0041}'],
  ])('an invisible format character (%s) is name_invalid', (_label, ch) => {
    expect(nameProblem(`My${ch}flow`)?.code).toBe('name_invalid')
  })
})

describe('splitVersion', () => {
  test.each([
    ['My flow v3', { root: 'My flow', n: 3 }],
    ['My flow V12', { root: 'My flow', n: 12 }],
    ['My flow  v3', { root: 'My flow', n: 3 }],
    ['My flow v03', { root: 'My flow', n: 3 }],
    ['x v123456', { root: 'x', n: 123456 }],
    ['v2', { root: 'v2', n: null }],
    ['My flowv2', { root: 'My flowv2', n: null }],
    ['My flow v1234567', { root: 'My flow v1234567', n: null }],
    ['My flow v', { root: 'My flow v', n: null }],
    ['My flow', { root: 'My flow', n: null }],
  ])('%j', (input, expected) => {
    expect(splitVersion(input)).toEqual(expected)
  })
})

describe('isNameTaken', () => {
  beforeEach(() => {
    seed([
      { id: 'a_flow', name: 'My SQLi Flow' },
      { id: 'b_secret', userId: 'bob', name: 'Bob only' },
    ])
  })

  test('ignores case and spacing', async () => {
    expect(await isNameTaken(pg, 'alice', 'my sqli flow')).toBe(true)
    expect(await isNameTaken(pg, 'alice', 'MY  SQLI\tFLOW')).toBe(true)
    expect(await isNameTaken(pg, 'alice', 'My SQLi Flow v2')).toBe(false)
  })

  test('the excepted id does not count (a rename to its own name)', async () => {
    expect(await isNameTaken(pg, 'alice', 'my sqli flow', 'a_flow')).toBe(false)
    expect(await isNameTaken(pg, 'alice', 'my sqli flow', 'some_other')).toBe(true)
  })

  test("another user's names do not count", async () => {
    expect(await isNameTaken(pg, 'alice', 'Bob only')).toBe(false)
    expect(await isNameTaken(pg, 'bob', 'Bob only')).toBe(true)
  })

  test('the key is computed in SQL on both sides, with the regex as a parameter', async () => {
    await isNameTaken(pg, 'alice', 'x')
    const call = db.rawCalls.at(-1)!
    expect(call.sql).toMatch(/FROM user_attack_skills/)
    expect(call.sql.match(/lower\(regexp_replace\(regexp_replace\(normalize\(/g)).toHaveLength(2)
    expect(call.sql.match(/, NFC\)/g)).toHaveLength(2)
    // In the text a layer of escaping could turn `\s` into `s`; as a value it cannot.
    expect(call.sql).not.toContain('\\s')
    const [user, ws, name, ws2, except] = call.values as string[]
    expect([user, name, except]).toEqual(['alice', 'x', ''])
    expect(ws2).toBe(ws)
    // Postgres's \s plus the Unicode spaces it leaves out and JavaScript's \s holds.
    expect(ws.startsWith('[\\s')).toBe(true)
    for (const ch of ['\u00a0', '\u2000', '\u200a', '\u3000', '\ufeff']) expect(ws).toContain(ch)
  })
})

describe('nameKeys', () => {
  test('no names, no query', async () => {
    expect(await nameKeys(pg, [])).toEqual([])
    expect(db.rawCalls).toHaveLength(0)
  })

  test('the key of each string, in order', async () => {
    expect(await nameKeys(pg, ['My  Flow', ' b ', 'C\td'])).toEqual(['my flow', 'b', 'c d'])
    expect(db.rawCalls.at(-1)!.values[1]).toEqual(['My  Flow', ' b ', 'C\td'])
  })
})

describe('suggestVersionName', () => {
  test('a source with no versions gets v2', async () => {
    seed([{ id: 's1', name: 'My SQLi flow' }])
    expect(await suggestVersionName(pg, 'alice', { id: 's1', name: 'My SQLi flow', lineageRootId: null }))
      .toEqual({ name: 'My SQLi flow v2', version: 2 })
  })

  test('the next number after the family\'s highest, matching the root by key', async () => {
    seed([
      { id: 's1', name: 'My SQLi flow' },
      { id: 's2', name: 'My SQLi flow v2' },
      { id: 's3', name: 'my  SQLI flow V7' },
    ])
    expect(await suggestVersionName(pg, 'alice', { id: 's1', name: 'My SQLi flow', lineageRootId: null }))
      .toEqual({ name: 'My SQLi flow v8', version: 8 })
  })

  test('a source that is itself a version keeps the root', async () => {
    seed([{ id: 's1', name: 'My SQLi flow' }, { id: 's2', name: 'My SQLi flow v2' }])
    expect((await suggestVersionName(pg, 'alice', { id: 's2', name: 'My SQLi flow v2', lineageRootId: 's1' })).name)
      .toBe('My SQLi flow v3')
  })

  test('the lineage keeps the numbering after a rename', async () => {
    seed([
      { id: 'root1', name: 'My SQLi flow', lineageRootId: 'root1', version: 1 },
      { id: 'v4', name: 'Totally renamed', lineageRootId: 'root1', version: 4 },
    ])
    expect(await suggestVersionName(pg, 'alice', { id: 'root1', name: 'My SQLi flow', lineageRootId: 'root1' }))
      .toEqual({ name: 'My SQLi flow v5', version: 5 })
  })

  test('with no lineage on the source, its own id is the family root', async () => {
    seed([
      { id: 'src', name: 'Recon basics' },
      { id: 'later', name: 'Something else', lineageRootId: 'src', version: 3 },
    ])
    expect(await suggestVersionName(pg, 'alice', { id: 'src', name: 'Recon basics', lineageRootId: null }))
      .toEqual({ name: 'Recon basics v4', version: 4 })
  })

  test("another user's versions do not count", async () => {
    seed([
      { id: 's1', name: 'My SQLi flow' },
      { id: 'b9', userId: 'bob', name: 'My SQLi flow v9', lineageRootId: 's1', version: 9 },
    ])
    expect((await suggestVersionName(pg, 'alice', { id: 's1', name: 'My SQLi flow', lineageRootId: null })).name)
      .toBe('My SQLi flow v2')
  })

  test('a taken candidate is skipped', async () => {
    // The 99-character root does not fit with " v2", so the candidate is cut to 97: a skill
    // already holding that cut name is outside the family (its root differs) but taken.
    const root = 'a'.repeat(99)
    seed([{ id: 's1', name: root }, { id: 'cut', name: `${'a'.repeat(97)} v2` }])
    expect(await suggestVersionName(pg, 'alice', { id: 's1', name: root, lineageRootId: null }))
      .toEqual({ name: `${'a'.repeat(97)} v3`, version: 3 })
  })

  test('the source name is normalized before its root is taken', async () => {
    seed([{ id: 's1', name: 'My SQLi flow' }])
    expect((await suggestVersionName(pg, 'alice', { id: 's1', name: '  My\tSQLi  flow ', lineageRootId: null })).name)
      .toBe('My SQLi flow v2')
  })

  test('truncation keeps 100 characters at most and never splits a surrogate pair', async () => {
    // 96 + the emoji's two code units = 98 > the 97 left beside " v2": the emoji is dropped whole.
    const root = `${'a'.repeat(96)}😀b`
    expect(root).toHaveLength(99)
    seed([{ id: 's1', name: root }])
    const { name } = await suggestVersionName(pg, 'alice', { id: 's1', name: root, lineageRootId: null })
    expect(name.length).toBeLessThanOrEqual(100)
    expect(name).not.toMatch(LONE_SURROGATE)
    expect(name).toBe(`${'a'.repeat(96)} v2`)
  })

  test('an emoji that fits exactly is kept, for a 100-character result', async () => {
    const root = `${'a'.repeat(95)}😀bb`
    seed([{ id: 's1', name: root }])
    const { name } = await suggestVersionName(pg, 'alice', { id: 's1', name: root, lineageRootId: null })
    expect(name).toBe(`${'a'.repeat(95)}😀 v2`)
    expect(name).toHaveLength(100)
  })

  test('a two-digit suffix leaves less room for the root', async () => {
    const root = 'b'.repeat(100)
    seed([{ id: 's1', name: root, lineageRootId: 's1', version: 9 }])
    const out = await suggestVersionName(pg, 'alice', { id: 's1', name: root, lineageRootId: 's1' })
    expect(out).toEqual({ name: `${'b'.repeat(96)} v10`, version: 10 })
  })

  test('a cut that ends on a space does not leave a double space', async () => {
    const root = `${'a'.repeat(96)} bcd`
    seed([{ id: 's1', name: root }])
    const { name } = await suggestVersionName(pg, 'alice', { id: 's1', name: root, lineageRootId: null })
    expect(name).toBe(`${'a'.repeat(96)} v2`)
  })

  test('the result is always free and always a valid name', async () => {
    seed([{ id: 's1', name: 'Flow' }, { id: 's2', name: 'Flow v2' }, { id: 's3', name: 'Flow v3' }])
    const { name } = await suggestVersionName(pg, 'alice', { id: 's1', name: 'Flow', lineageRootId: null })
    expect(await isNameTaken(pg, 'alice', name)).toBe(false)
    expect(nameProblem(name)).toBeNull()
  })
})
