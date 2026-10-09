/**
 * The plugin platform's master switch.
 *
 * Plugin code is third-party code, so the platform must never come on by
 * upgrading: unset, empty and every value that is not an explicit yes keep it
 * off. When it is off, every plugin route answers the same 404, and that answer
 * names the switch so an operator is not sent hunting for a wrong URL.
 *
 * @vitest-environment node
 */
import { describe, test, expect, afterEach, vi } from 'vitest'
import { pluginsEnabled, pluginsDisabledResponse, PLUGINS_DISABLED_MESSAGE } from './switch'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('PLUGINS_ENABLED defaults off', () => {
  test('unset means disabled', () => {
    vi.stubEnv('PLUGINS_ENABLED', undefined)
    expect(pluginsEnabled()).toBe(false)
  })

  test('empty means disabled', () => {
    vi.stubEnv('PLUGINS_ENABLED', '')
    expect(pluginsEnabled()).toBe(false)
  })

  test.each(['false', '0', 'yes', 'on', 'FALSE', 'truthy', '2'])('%s does not enable it', v => {
    vi.stubEnv('PLUGINS_ENABLED', v)
    expect(pluginsEnabled()).toBe(false)
  })

  test.each(['true', 'TRUE', 'True', '1', ' true ', 'true\n'])('%j enables it', v => {
    vi.stubEnv('PLUGINS_ENABLED', v)
    expect(pluginsEnabled()).toBe(true)
  })

  test('is read at call time, so a recreated container picks up the new value', () => {
    vi.stubEnv('PLUGINS_ENABLED', 'false')
    expect(pluginsEnabled()).toBe(false)
    vi.stubEnv('PLUGINS_ENABLED', 'true')
    expect(pluginsEnabled()).toBe(true)
  })
})

describe('the disabled answer', () => {
  test('is a 404 with code plugins_disabled', async () => {
    const res = pluginsDisabledResponse()
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe('plugins_disabled')
    expect(body.error).toBe(PLUGINS_DISABLED_MESSAGE)
  })

  test('names the switch and the command that re-reads the environment', () => {
    expect(PLUGINS_DISABLED_MESSAGE).toMatch(/disabled/i)
    expect(PLUGINS_DISABLED_MESSAGE).toContain('PLUGINS_ENABLED=true')
    // A plain `docker compose restart` keeps the old environment.
    expect(PLUGINS_DISABLED_MESSAGE).toContain('./redamon.sh up')
  })

  test('is never cached', () => {
    expect(pluginsDisabledResponse().headers.get('Cache-Control')).toBe('no-store')
  })

  test('is the same whatever the switch says, so callers decide when to send it', async () => {
    vi.stubEnv('PLUGINS_ENABLED', 'true')
    const res = pluginsDisabledResponse()
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code: string }).code).toBe('plugins_disabled')
  })
})
