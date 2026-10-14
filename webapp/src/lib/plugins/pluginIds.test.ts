/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { existsSync, readdirSync } from 'fs'
import path from 'path'
import { PLUGIN_ID_RE, RESERVED_PLUGIN_IDS, isValidPluginId } from './ids'

describe('plugin id format', () => {
  test.each([
    ['ab', true],
    ['skiller', true],
    ['a' + 'b'.repeat(39), true],
    ['echo-2', true],
    ['trailing-', true],
    ['a--b', true],
    ['a', false],
    ['a' + 'b'.repeat(40), false],
    ['Skiller', false],
    ['1plugin', false],
    ['-plugin', false],
    ['my_plugin', false],
    ['my.plugin', false],
    ['my plugin', false],
    ['../etc', false],
    ['', false],
    ['plugin\n', false],
  ])('%j -> %s', (id, valid) => {
    expect(isValidPluginId(id)).toBe(valid)
  })

  test('non-strings are refused', () => {
    expect(isValidPluginId(undefined)).toBe(false)
    expect(isValidPluginId(42)).toBe(false)
    expect(isValidPluginId({ toString: () => 'skiller' })).toBe(false)
  })

  test('every reserved name would otherwise be a valid id, and is refused', () => {
    for (const name of RESERVED_PLUGIN_IDS) {
      expect(PLUGIN_ID_RE.test(name), name).toBe(true)
      expect(isValidPluginId(name), name).toBe(false)
    }
  })

  test.each([
    'staging', 'platform', 'core', 'redamon', 'plugins', 'admin', 'api', 'system', 'internal',
    'status', 'llm-features', 'jobs', 'offline-install', 'contributions', 'overrides',
    'external-link',
  ])('%s is reserved', (name) => {
    expect(RESERVED_PLUGIN_IDS.has(name)).toBe(true)
  })
})

// Next.js resolves a static folder before a dynamic one, so a static folder at a
// level where a plugin id is also a segment would shadow the plugin of that name.
describe('route folders at the plugin id level', () => {
  const APP = path.resolve(__dirname, '../../app')
  const LEVELS = ['api/plugins', 'plugins']

  const entries = (level: string) => {
    const dir = path.join(APP, level)
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  }

  test.each(LEVELS)('every static folder under app/%s is a reserved plugin id', (level) => {
    const staticFolders = entries(level).filter((n) => !n.startsWith('[') && !n.startsWith('('))
    for (const name of staticFolders) {
      expect(RESERVED_PLUGIN_IDS.has(name), `app/${level}/${name}`).toBe(true)
    }
  })

  test.each(LEVELS)('the only dynamic segment under app/%s is [pluginId]', (level) => {
    const dynamic = entries(level).filter((n) => n.startsWith('['))
    for (const name of dynamic) expect(name, `app/${level}/${name}`).toBe('[pluginId]')
  })
})
