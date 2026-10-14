/**
 * The runner client's migration call (TD-28): one batch of rows to
 * POST /runner/v1/plugins/{id}/migrate, answered with each row's new value or its
 * deletion. The request never carries a call token; a refusal keeps the runner's code.
 *
 * @vitest-environment node
 */
import { describe, test, expect, afterEach } from 'vitest'
import { startFakeRunner, type FakeRunnerOptions } from './__testing__/fakeRunner'
import { closeAllFakeServers } from './__testing__/fakeHttpServer'
import { ECHO_MIGRATIONS } from './__testing__/echoMigrations'
import { RUNNER_TIMEOUTS, RunnerError, RunnerUnavailableError, runMigration, type MigrationRow, type RunnerConfig } from './runnerClient'

const KEY = 'k'.repeat(64)

afterEach(() => closeAllFakeServers())

async function fake(opts: FakeRunnerOptions = {}) {
  const r = await startFakeRunner({ runnerKey: KEY, migrations: ECHO_MIGRATIONS, diskVersions: { echo: ['1.0.0', '1.1.0'] }, ...opts })
  const config: RunnerConfig = { baseUrl: r.baseUrl, key: KEY }
  return { r, config }
}

const rows = (...values: unknown[]): MigrationRow[] =>
  values.map((value, i) => ({ id: `r${i}`, collection: 'items', key: `k${i}`, ownerType: 'user', value }))

describe('runMigration', () => {
  test('answers each row, a deletion as delete: true, and sends no token', async () => {
    const { r, config } = await fake()
    const out = await runMigration('echo', { version: '1.1.0', step: 2, direction: 'up', rows: rows(5, { delete: true }) }, config)
    expect(out).toEqual([{ id: 'r0', value: { v: 2, data: 5 } }, { id: 'r1', delete: true }])
    expect(r.migrateCalls).toHaveLength(1)
    expect(r.migrateCalls[0].body).toEqual({ version: '1.1.0', step: 2, direction: 'up', rows: rows(5, { delete: true }) })
    expect(JSON.stringify(r.migrateCalls[0])).not.toMatch(/token/i)
    expect(r.server.calls[0].path).toBe('/runner/v1/plugins/echo/migrate')
  })

  test.each([
    ['a raising row', { version: '1.0.0', step: 2, direction: 'up' as const, rows: rows(1, { raise: true }) }, 422, 'migration_failed'],
    ['a missing step', { version: '1.0.0', step: 3, direction: 'down' as const, rows: rows(1) }, 422, 'migration_missing'],
    ['a version not on the volume', { version: '9.9.9', step: 2, direction: 'up' as const, rows: rows(1) }, 404, 'unknown_version'],
    ['an oversized batch result', { version: '1.0.0', step: 2, direction: 'up' as const, rows: rows({ grow: 3 * 1024 * 1024 }) }, 422, 'result_too_large'],
  ])('%s is a RunnerError with the runner code', async (_n, req, status, code) => {
    const { config } = await fake()
    await expect(runMigration('echo', req, config)).rejects.toMatchObject({ name: 'RunnerError', status, code })
  })

  test('the raising row is named in the message', async () => {
    const { config } = await fake()
    const e = await runMigration('echo', { version: '1.0.0', step: 2, direction: 'up', rows: rows(1, { raise: true }) }, config).catch((x) => x)
    expect(e).toBeInstanceOf(RunnerError)
    expect(e.message).toBe('migrate_row raised ValueError on row r1.')
  })

  test('the runner down is RunnerUnavailableError', async () => {
    const { r, config } = await fake()
    await r.close()
    await expect(runMigration('echo', { version: '1.0.0', step: 2, direction: 'up', rows: rows(1) }, config)).rejects.toBeInstanceOf(
      RunnerUnavailableError,
    )
  })

  test('arguments are checked before sending', async () => {
    const { r, config } = await fake()
    await expect(runMigration('../x', { version: '1.0.0', step: 2, direction: 'up', rows: [] }, config)).rejects.toBeInstanceOf(TypeError)
    await expect(runMigration('echo', { version: '1.0.0', step: 1, direction: 'up', rows: [] }, config)).rejects.toBeInstanceOf(TypeError)
    await expect(runMigration('echo', { version: 'x', step: 2, direction: 'up', rows: [] }, config)).rejects.toBeInstanceOf(TypeError)
    expect(r.server.calls).toHaveLength(0)
  })

  test('a batch may take the runner its whole timeout, and a bit', () => {
    expect(RUNNER_TIMEOUTS.migrate).toBeGreaterThan(120_000)
  })
})

test("the client waits for one batch at least as long as the runner may take", async () => {
  const { readFileSync } = await import('node:fs')
  const path = await import('node:path')
  const supervisor = (f: string) => readFileSync(path.resolve(__dirname, '../../../../services/plugin_runner/supervisor', f), 'utf8')
  const num = (src: string, re: RegExp) => Number(src.match(re)![1])
  const config = supervisor('config.py')
  const ready = num(config, /ready_timeout: float = ([\d.]+)/)
  const migrate = num(config, /migrate_timeout: float = ([\d.]+)/)
  const scrub = num(supervisor('spawn.py'), /SCRUB_TIMEOUT = ([\d.]+)/)
  // The worker's start, the batch (sending and reading share one deadline), the 5 + 2 s
  // clean-up and the UID scrub: shorter, and a slow batch is reported as a runner outage.
  expect(RUNNER_TIMEOUTS.migrate).toBeGreaterThanOrEqual((ready + migrate + 7 + scrub) * 1000)
})
