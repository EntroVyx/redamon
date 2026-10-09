/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { manifestSchema, parseManifest } from './schemas/manifest'
import { PLUGIN_ICON_NAMES } from './extensionPoints'
import skiller from './__fixtures__/manifests/skiller.valid.json'

const FIXTURES = path.join(__dirname, '__fixtures__/manifests')
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

// A fixture document the test mutates freely; the schema under test is what types it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>

/** Parses a mutated Skiller manifest and returns its error lines (fails if it parses). */
function refusal(mutate: (m: Doc) => void): string {
  const m = clone(skiller) as Doc
  mutate(m)
  const r = parseManifest(m)
  if (r.ok) throw new Error('expected the manifest to be refused')
  return r.errors.join('\n')
}

describe('fixtures', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))

  test.each(files.filter((f) => f.endsWith('.valid.json')))('%s is accepted', (f) => {
    const r = parseManifest(JSON.parse(readFileSync(path.join(FIXTURES, f), 'utf8')))
    expect(r.ok ? [] : r.errors).toEqual([])
  })

  test.each(files.filter((f) => f.endsWith('.invalid.json')))('%s is refused', (f) => {
    expect(parseManifest(JSON.parse(readFileSync(path.join(FIXTURES, f), 'utf8'))).ok).toBe(false)
  })
})

describe('a Skiller-shaped manifest', () => {
  test('parses into the same object', () => {
    expect(manifestSchema.parse(clone(skiller))).toEqual(skiller)
  })
})

describe('refusals, each with a readable message', () => {
  test('an unknown top-level key', () => {
    expect(refusal((m) => (m.hooks = {}))).toMatch(/^\(root\): Unrecognized key: "hooks"/m)
  })

  test('an unknown key inside an action', () => {
    expect(refusal((m) => (m.actions[0].shell = true))).toMatch(/actions\.0: Unrecognized key: "shell"/)
  })

  test('an unknown permission', () => {
    expect(refusal((m) => m.permissions.push('network:any'))).toMatch(
      /permissions\.3: Invalid option: expected one of "session:read"\|"llm:invoke"\|"override:skill\.text"/,
    )
  })

  test('a permission listed twice', () => {
    expect(refusal((m) => m.permissions.push('session:read'))).toMatch(/permissions: lists a permission twice/)
  })

  test('an unknown extension point', () => {
    expect(refusal((m) => (m.contributes['graph.toolbar'] = []))).toMatch(
      /contributes: unknown extension point: graph\.toolbar/,
    )
  })

  test('the behaviour point is not a contribution', () => {
    expect(refusal((m) => (m.contributes['skill.text'] = []))).toMatch(/unknown extension point: skill\.text/)
  })

  test.each([
    '../engine/main.py:run',
    'main.py:run',
    '/engine/main.py:run',
    'engine/main.py',
    'engine/main.js:run',
    'engine//main.py:run',
    'engine/../main.py:run',
    'engine/Main.py:run',
    'engine/main.py:Run',
  ])('an action entry %j', (entry) => {
    expect(refusal((m) => (m.actions[0].entry = entry))).toMatch(/actions\.0\.entry: must name a function in a \.py file under engine\//)
  })

  test('timeoutSeconds 3601', () => {
    expect(refusal((m) => (m.actions[0].timeoutSeconds = 3601))).toMatch(/actions\.0\.timeoutSeconds: Too big/)
  })

  test('timeoutSeconds 0 and a fraction', () => {
    expect(refusal((m) => (m.actions[0].timeoutSeconds = 0))).toMatch(/actions\.0\.timeoutSeconds/)
    expect(refusal((m) => (m.actions[0].timeoutSeconds = 1.5))).toMatch(/actions\.0\.timeoutSeconds/)
  })

  test('llm: true without llm:invoke', () => {
    const msg = refusal((m) => {
      m.permissions = ['session:read', 'override:skill.text']
      delete m.llmFeature
    })
    expect(msg).toMatch(/actions\.0\.llm: an action that calls a model needs the llm:invoke permission/)
  })

  test('llm:invoke without llmFeature', () => {
    expect(refusal((m) => delete m.llmFeature)).toMatch(/llmFeature: is required with the llm:invoke permission/)
  })

  test('llmFeature without llm:invoke', () => {
    const msg = refusal((m) => {
      m.permissions = ['session:read', 'override:skill.text']
      m.actions[0].llm = false
    })
    expect(msg).toMatch(/llmFeature: needs the llm:invoke permission/)
  })

  test('a coreScreen outside the allowlist', () => {
    expect(refusal((m) => (m.contributes['chat.session.actions'][1].coreScreen = 'project.settings'))).toMatch(
      /contributes\.chat\.session\.actions\.1\.coreScreen: Invalid .*expected .*"skill\.text\.versions"/,
    )
  })

  test("a coreScreen whose point's permission is not declared", () => {
    expect(refusal((m) => (m.permissions = ['session:read', 'llm:invoke']))).toMatch(
      /coreScreen: skill\.text\.versions needs the override:skill\.text permission/,
    )
  })

  test('a contribution with both an action and a coreScreen, or neither', () => {
    expect(refusal((m) => (m.contributes['chat.session.actions'][1].action = 'analyze_session'))).toMatch(
      /chat\.session\.actions\.1: give either action or coreScreen/,
    )
    expect(refusal((m) => delete m.contributes['chat.session.actions'][0].action)).toMatch(
      /give either action or coreScreen/,
    )
  })

  test('an icon outside the allowlist', () => {
    expect(refusal((m) => (m.contributes['chat.session.actions'][0].icon = 'skull'))).toMatch(
      /chat\.session\.actions\.0\.icon: Invalid option/,
    )
  })

  test('a contribution pointing at a missing action', () => {
    expect(refusal((m) => (m.contributes['chat.session.actions'][0].action = 'analyse_session'))).toMatch(
      /contributes\.chat\.session\.actions\.0\.action: no action "analyse_session" is declared/,
    )
    expect(refusal((m) => (m.contributes['project.skills.row'] = [{ label: 'x', action: 'nope' }]))).toMatch(
      /contributes\.project\.skills\.row\.0\.action: no action "nope" is declared/,
    )
  })

  test('two actions with one id', () => {
    expect(refusal((m) => m.actions.push(clone(m.actions[0])))).toMatch(/actions: two actions share an id/)
  })

  test('more contributions than a point allows', () => {
    expect(
      refusal((m) => {
        m.contributes['chat.session.actions'] = Array.from({ length: 6 }, () => ({
          label: 'x',
          action: 'analyze_session',
        }))
      }),
    ).toMatch(/chat\.session\.actions: Too big/)
  })

  test.each([
    ['id', 'Skiller', /id: must match/],
    ['id', 'plugins', /id: is a reserved name/],
    ['version', '1.0', /version: must be a version x\.y\.z/],
    ['platform', '^1.0.0', /platform: must be a range of comparators/],
    ['dataVersion', 0, /dataVersion: Too small/],
    ['dataVersion', 2_147_483_648, /dataVersion: Too big/],
    ['displayName', 'x'.repeat(61), /displayName: Too big/],
    ['description', 'x'.repeat(501), /description: Too big/],
  ])('%s = %j', (key, value, expected) => {
    expect(refusal((m) => (m[key] = value))).toMatch(expected)
  })

  test('a nav screen outside ui/', () => {
    expect(
      refusal((m) => (m.contributes.nav = { label: 'S', icon: 'puzzle', screen: '../ui/home.json' })),
    ).toMatch(/contributes\.nav\.screen: must be a \.json file under ui\//)
  })
})

describe('the icon allowlist', () => {
  test('holds the names Skiller and the design use', () => {
    for (const n of ['puzzle', 'sparkles', 'history', 'list', 'file-text', 'settings', 'play', 'search', 'shield']) {
      expect(PLUGIN_ICON_NAMES).toContain(n)
    }
  })
})
