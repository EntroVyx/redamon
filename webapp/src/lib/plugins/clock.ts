/**
 * The plugin platform's only source of time. Every plugin module that reads the
 * clock (catalog expiry, leases, token expiry, quotas) calls `now()`, so a test
 * can pin time instead of sleeping or racing the wall clock.
 */
let override: (() => Date) | null = null

export function now(): Date {
  return override ? override() : new Date()
}

/** Tests only. Refused in a production build so a stray call cannot freeze real time. */
export function setNowForTests(fn: (() => Date) | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('setNowForTests is for tests only')
  }
  override = fn
}
