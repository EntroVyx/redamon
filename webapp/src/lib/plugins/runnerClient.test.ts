/**
 * The webapp's client for the plugin runner's supervisor (reached through the
 * plugin-gateway proxy). It sends the runner key, fails closed without one, maps
 * every transport failure to RunnerUnavailableError (routes answer 503
 * runner_unavailable) and every coded answer to RunnerError.
 *
 * @vitest-environment node
 */
import { describe, test, expect, afterEach } from 'vitest'
import { startFakeRunner } from './__testing__/fakeRunner'
import { closeAllFakeServers, startFakeServer } from './__testing__/fakeHttpServer'
import {
  RunnerError,
  RunnerUnavailableError,
  actionTimeoutMs,
  cancelJob,
  pluginLogs,
  runAction,
  runnerConfig,
  runnerHealth,
  runnerReload,
  type RunnerConfig,
} from './runnerClient'

const KEY = 'k'.repeat(64)
const CTX = { pluginId: 'echo', version: '1.0.0', userId: 'user-1' }

afterEach(async () => {
  await closeAllFakeServers()
  delete process.env.PLUGIN_RUNNER_URL
  delete process.env.PLUGIN_RUNNER_KEY
})

async function fake(opts = {}) {
  const r = await startFakeRunner({
    runnerKey: KEY,
    actions: {
      'echo/echo': (call) => ({ result: { echo: call.body.params } }),
      'echo/fails': () => ({ status: 200, body: { ok: false, error: { code: 'no_target', message: 'Pick one.' } } }),
      'echo/sleep': () => ({ result: { slept: true } }),
      'echo/busy': () => ({ status: 429, body: { error: 'Busy.', code: 'plugin_busy' } }),
      'echo/slow': () => ({ status: 504, body: { error: 'Too slow.', code: 'action_timeout' } }),
    },
    logs: { echo: ['a', 'b', 'c'] },
    ...opts,
  })
  const config: RunnerConfig = { baseUrl: r.baseUrl, key: KEY }
  return { r, config }
}

describe('configuration', () => {
  test('defaults to the proxy and reads the key from the environment', () => {
    process.env.PLUGIN_RUNNER_KEY = `  ${KEY}  `
    expect(runnerConfig()).toEqual({ baseUrl: 'http://plugin-gateway:7072', key: KEY })
    process.env.PLUGIN_RUNNER_URL = 'http://runner.example:9/'
    expect(runnerConfig().baseUrl).toBe('http://runner.example:9')
  })

  test.each(['', 'changeme'])('a missing or placeholder key (%j) fails closed without a request', async (key) => {
    const { r } = await fake()
    await expect(runnerHealth({ baseUrl: r.baseUrl, key })).rejects.toMatchObject({
      name: 'RunnerUnavailableError', reason: 'not_configured', code: 'runner_unavailable',
    })
    expect(r.server.calls).toHaveLength(0)
  })
})

describe('calls', () => {
  test('health carries the key and returns the supervisor state', async () => {
    const { r, config } = await fake({ bootId: 'boot-1' })
    const h = await runnerHealth(config)
    expect(h).toEqual({ platformVersion: '1.0.0', bootId: 'boot-1', state: 'ok', workers: [] })
    expect(r.server.calls[0].headers['x-plugin-runner-key']).toBe(KEY)
  })

  test('reload', async () => {
    const { r, config } = await fake()
    expect((await runnerReload(config)).ok).toBe(true)
    expect(r.reloads).toBe(1)
  })

  test('a sync action: its result, or the plugin error as a result', async () => {
    const { r, config } = await fake()
    const ok = await runAction('echo', 'echo', { token: 't', params: { a: 1 }, ctx: CTX, timeoutSeconds: 30 }, config)
    expect(ok).toEqual({ kind: 'result', ok: true, result: { echo: { a: 1 } } })
    expect(r.actionCalls[0].body).toEqual({ token: 't', params: { a: 1 }, ctx: CTX, timeoutSeconds: 30, async: false })
    const failed = await runAction('echo', 'fails', { token: 't', params: {}, ctx: CTX, timeoutSeconds: 30 }, config)
    expect(failed).toEqual({ kind: 'result', ok: false, error: { code: 'no_target', message: 'Pick one.' } })
  })

  test('an async action is accepted with its job id', async () => {
    const { config } = await fake()
    const out = await runAction('echo', 'sleep',
      { token: 't', params: {}, ctx: CTX, timeoutSeconds: 30, async: true, jobId: 'job-1' }, config)
    expect(out).toEqual({ kind: 'accepted', jobId: 'job-1' })
  })

  test.each([
    ['busy', 429, 'plugin_busy'],
    ['slow', 504, 'action_timeout'],
    ['undeclared', 404, 'unknown_action'],
  ])('a coded refusal (%s) becomes a RunnerError', async (action, status, code) => {
    const { config } = await fake()
    const call = runAction('echo', action, { token: 't', params: {}, ctx: CTX, timeoutSeconds: 30 }, config)
    await expect(call).rejects.toMatchObject({ name: 'RunnerError', status, code })
  })

  test('a wrong key is a RunnerError 401, not an outage', async () => {
    const { r } = await fake()
    await expect(runnerHealth({ baseUrl: r.baseUrl, key: 'w'.repeat(64) })).rejects.toMatchObject({
      name: 'RunnerError', status: 401, code: 'unauthorized',
    })
  })

  test('cancel: true when the job was running, false when it is unknown', async () => {
    let finish!: () => void
    const { config } = await fake({
      actions: { 'echo/sleep': () => new Promise((resolve) => { finish = () => resolve({ result: {} }) }) },
    })
    await runAction('echo', 'sleep', { token: 't', params: {}, ctx: CTX, timeoutSeconds: 30, async: true, jobId: 'j1' }, config)
    expect(await cancelJob('echo', 'j1', config)).toBe(true)
    expect(await cancelJob('echo', 'never', config)).toBe(false)
    finish()
  })

  test('logs', async () => {
    const { config } = await fake()
    expect(await pluginLogs('echo', 2, config)).toEqual(['b', 'c'])
  })
})

describe('failures', () => {
  test('nothing listening is RunnerUnavailableError', async () => {
    const s = await startFakeServer({})
    const base = s.baseUrl
    await s.close()
    await expect(runnerHealth({ baseUrl: base, key: KEY })).rejects.toMatchObject({
      name: 'RunnerUnavailableError', reason: 'unreachable',
    })
  })

  test('a silent runner times out as RunnerUnavailableError', async () => {
    const s = await startFakeServer({ 'GET /runner/v1/health': { delayMs: 1000, body: {} } })
    await expect(runnerHealth({ baseUrl: s.baseUrl, key: KEY, timeouts: { health: 100 } })).rejects.toMatchObject({
      name: 'RunnerUnavailableError', reason: 'timeout',
    })
  })

  test('a redirect is not followed', async () => {
    const s = await startFakeServer({ 'GET /runner/v1/health': { redirect: 'http://127.0.0.1:1/x' } })
    await expect(runnerHealth({ baseUrl: s.baseUrl, key: KEY })).rejects.toMatchObject({
      name: 'RunnerUnavailableError', reason: 'bad_response',
    })
  })

  test('an answer that is not JSON', async () => {
    const s = await startFakeServer({ 'GET /runner/v1/health': { body: 'hello' } })
    await expect(runnerHealth({ baseUrl: s.baseUrl, key: KEY })).rejects.toBeInstanceOf(RunnerUnavailableError)
  })

  test('an error answer without a code', async () => {
    const s = await startFakeServer({ 'GET /runner/v1/health': { status: 500, body: 'oops' } })
    await expect(runnerHealth({ baseUrl: s.baseUrl, key: KEY })).rejects.toMatchObject({
      name: 'RunnerError', status: 500, code: 'runner_error',
    })
    expect(new RunnerError(500, 'runner_error', 'x')).toBeInstanceOf(Error)
  })

  test.each([
    ['../projects', 'echo'],
    ['Echo', 'echo'],
    ['echo', '../../health'],
    ['echo', 'a/b'],
  ])('ids that are not ids (%s / %s) never become a request', async (pluginId, action) => {
    const { r, config } = await fake()
    await expect(runAction(pluginId, action, { token: 't', params: {}, ctx: CTX, timeoutSeconds: 5 }, config))
      .rejects.toBeInstanceOf(TypeError)
    expect(r.server.calls).toHaveLength(0)
  })

  test('an action may run its timeout plus ten seconds of margin', () => {
    expect(actionTimeoutMs(30)).toBe(40_000)
    expect(actionTimeoutMs(900)).toBe(910_000)
  })
})
