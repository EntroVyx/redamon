/**
 * The registry's `attack_skill_config` validator (D10, §9 row 11).
 *
 * `attackSkillConfig` used to be a `json_object`, which accepts anything that is an
 * object, arrays included, so a malformed config reached the agent and made the form throw
 * on a missing `user`. The named validator checks the SHAPE only: registry validators are
 * synchronous and see no owner, so which skills exist and the owner's 20-enabled bound are
 * checked by every writer against the database (crossField.ts). Both MCP doors and the
 * preset store reach it through validateValue / filterReconSettings.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { describe, test, expect } from 'vitest'
import { field } from './registry'
import { validateValue } from './validators'
import { filterReconSettings } from './filter'

const repoFile = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../../${rel}`, import.meta.url)), 'utf8')

const spec = field('attackSkillConfig')!
const check = (value: unknown) => validateValue('attackSkillConfig', spec, value)
const BUILT_IN = { sql_injection: true, xss: false }

describe('the registry entry', () => {
  test('attackSkillConfig is a settable json field with the attack_skill_config validator', () => {
    expect(spec).toBeDefined()
    expect(spec.type).toBe('json')
    expect(spec.validator).toBe('attack_skill_config')
    expect(spec.mcp).toBe('settable')
  })

  test('the YAML source names the validator (registry.json is its build artifact)', () => {
    const yaml = repoFile('recon_settings/registry.yaml')
    const start = yaml.indexOf('\n  attackSkillConfig:\n')
    expect(start).toBeGreaterThan(-1)
    const rest = yaml.slice(start + 1)
    const next = rest.slice(1).search(/\n {2}[A-Za-z]/)
    const block = next === -1 ? rest : rest.slice(0, next + 1)
    expect(block).toMatch(/\n {4}validator: attack_skill_config\n/)
    expect(block).toMatch(/missing is off/)
  })

  test('the registry schema lists the validator, so the build accepts it', () => {
    expect(repoFile('recon_settings/registry.schema.json')).toContain('"attack_skill_config"')
  })

  test('the shipped default (what a preset resets to) passes its own validator', () => {
    expect(typeof spec.default).toBe('string')
    const value = JSON.parse(String(spec.default))
    expect(check(value)).toBeNull()
    expect(value.user).toEqual({})
  })
})

describe('validateValue: the shape', () => {
  test.each([
    ['builtIn and user maps', { builtIn: BUILT_IN, user: { a: true, b: false } }],
    ['empty maps', { builtIn: {}, user: {} }],
    ['no user map (it is created empty on write)', { builtIn: BUILT_IN }],
  ])('accepts %s', (_label, value) => {
    expect(check(value)).toBeNull()
  })

  test.each([
    ['an array', [], 'must be an object with builtIn and user maps'],
    ['an array of configs', [{ builtIn: BUILT_IN, user: {} }], 'must be an object with builtIn and user maps'],
    ['null', null, 'must be an object with builtIn and user maps'],
    ['a JSON string', JSON.stringify({ builtIn: BUILT_IN, user: {} }), 'must be an object with builtIn and user maps'],
    ['a missing builtIn', { user: {} }, 'must carry builtIn, the map of built-in skill toggles'],
    ['builtIn as an array', { builtIn: ['xss'], user: {} }, 'builtIn must be an object'],
    ['builtIn null', { builtIn: null, user: {} }, 'builtIn must be an object'],
    ['a non-boolean built-in toggle', { builtIn: { xss: 'true' }, user: {} }, 'builtIn.xss must be true or false'],
    ['user as an array', { builtIn: BUILT_IN, user: ['a'] }, 'user must be an object'],
    ['user null', { builtIn: BUILT_IN, user: null }, 'user must be an object'],
    ['a non-boolean user toggle', { builtIn: BUILT_IN, user: { a: 1 } }, 'user.a must be true or false'],
    ['an extra top-level key', { builtIn: BUILT_IN, user: {}, extra: true }, "has an unknown key 'extra' (only builtIn and user)"],
  ])('refuses %s', (_label, value, message) => {
    expect(check(value)).toBe(message)
  })

  test('it checks the shape only: more than 20 on and ids of anyone are a writer\'s decision', () => {
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`any-user-skill-${i}`, true]))
    expect(check({ builtIn: BUILT_IN, user: many })).toBeNull()
  })
})

describe('filterReconSettings: both MCP modes refuse a malformed config by name', () => {
  test.each(['update', 'create'] as const)('%s mode accepts a valid config and passes it through', (mode) => {
    const value = { builtIn: BUILT_IN, user: { a: true } }
    const r = filterReconSettings({ attackSkillConfig: value }, { mode })
    expect(r).toEqual({ ok: true, data: { attackSkillConfig: value } })
  })

  test.each([
    ['update', []],
    ['update', { user: {} }],
    ['update', { builtIn: BUILT_IN, user: { a: 'yes' } }],
    ['update', { builtIn: BUILT_IN, user: {}, x: 1 }],
    ['create', []],
    ['create', { user: {} }],
  ] as const)('%s mode refuses %j, naming attackSkillConfig', (mode, value) => {
    const r = filterReconSettings({ attackSkillConfig: value, katanaDepth: 3 }, { mode })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.key).toBe('attackSkillConfig')
    expect(r.error).toContain('attackSkillConfig')
  })
})
