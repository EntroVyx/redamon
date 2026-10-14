/**
 * The injectable clock every plugin module reads.
 *
 * @vitest-environment node
 */
import { describe, test, expect, afterEach, vi } from 'vitest'
import { now, setNowForTests } from './clock'

afterEach(() => {
  vi.unstubAllEnvs()
  setNowForTests(null)
})

describe('now()', () => {
  test('is the wall clock when nothing is injected', () => {
    const before = Date.now()
    const t = now().getTime()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(Date.now())
  })

  test('returns the injected time', () => {
    setNowForTests(() => new Date('2026-01-02T03:04:05Z'))
    expect(now().toISOString()).toBe('2026-01-02T03:04:05.000Z')
  })

  test('calls the injected function each time, so a test can advance time', () => {
    let t = Date.parse('2026-01-01T00:00:00Z')
    setNowForTests(() => new Date(t))
    expect(now().getTime()).toBe(t)
    t += 90_000
    expect(now().toISOString()).toBe('2026-01-01T00:01:30.000Z')
  })

  test('null restores the wall clock', () => {
    setNowForTests(() => new Date(0))
    setNowForTests(null)
    expect(now().getTime()).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'))
  })
})

describe('setNowForTests', () => {
  test('is refused in a production build', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(() => setNowForTests(() => new Date(0))).toThrow(/tests only/)
    vi.unstubAllEnvs()
    expect(now().getTime()).not.toBe(0)
  })
})
