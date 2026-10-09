/**
 * One platform version (TD-23): the webapp's constant, the runner image's and the SDK's
 * must agree, or the runner reports itself out of date and runs no plugin.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_PLATFORM_VERSION } from './platformVersion'

const RUNNER = join(__dirname, '../../../../services/plugin_runner')

function declared(file: string, name: string): string | undefined {
  const m = new RegExp(`^${name} = "([^"]+)"$`, 'm').exec(readFileSync(join(RUNNER, file), 'utf8'))
  return m?.[1]
}

describe('platform version parity', () => {
  test('the runner image declares the webapp version', () => {
    expect(declared('platform_version.py', 'PLATFORM_VERSION')).toBe(PLUGIN_PLATFORM_VERSION)
  })

  test('the SDK declares the webapp version', () => {
    expect(declared('sdk/redamon_plugin_sdk/__init__.py', 'PLATFORM_VERSION')).toBe(PLUGIN_PLATFORM_VERSION)
  })

  test('the SDK contract cases are for the same version', () => {
    const cases = JSON.parse(readFileSync(join(RUNNER, 'sdk/contract_cases.json'), 'utf8'))
    expect(cases.platformVersion).toBe(PLUGIN_PLATFORM_VERSION)
  })
})
