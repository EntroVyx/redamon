/**
 * @vitest-environment node
 */
import { describe, test, expect, afterEach } from 'vitest'
import { closeAllFakeServers } from './fakeHttpServer'
import { RUNNER_KEY_HEADER, startFakeRunner } from './fakeRunner'

const KEY = 'k'.repeat(64)
const auth = { [RUNNER_KEY_HEADER]: KEY }

afterEach(async () => {
  await closeAllFakeServers()
})

/** A body the supervisor accepts; `extra` adds or replaces fields. */
function action(extra: Record<string, unknown> = {}) {
  return { token: 't', params: {}, ctx: { pluginId: 'demo', version: '1.0.0', userId: 'u' }, timeoutSeconds: 30, ...extra }
}

async function post(url: string, body: unknown, headers: Record<string, string> = auth) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

describe('fakeRunner: the key check fails closed', () => {
  test('no key configured: every route answers 503 runner_not_configured', async () => {
    const r = await startFakeRunner()
    const res = await fetch(`${r.baseUrl}/runner/v1/health`, { headers: auth })
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('runner_not_configured')
  })

  test.each([
    ['missing', {} as Record<string, string>],
    ['wrong', { [RUNNER_KEY_HEADER]: 'x'.repeat(64) }],
    ['a prefix of the key', { [RUNNER_KEY_HEADER]: KEY.slice(0, 10) }],
  ])('%s key: 401, recorded as refused, no action runs', async (_label, headers) => {
    let ran = false
    const r = await startFakeRunner({ runnerKey: KEY, actions: { 'demo/run': () => { ran = true; return { result: {} } } } })
    const res = await post(`${r.baseUrl}/runner/v1/plugins/demo/actions/run`, {}, headers)
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('unauthorized')
    expect(r.refused).toHaveLength(1)
    expect(r.actionCalls).toHaveLength(0)
    expect(ran).toBe(false)
  })
})

describe('fakeRunner: the supervisor routes', () => {
  test('health reports version, boot id, state and workers', async () => {
    const workers = [{ id: 'demo', version: '1.0.0', pid: 10, uid: 20001, inFlight: 0, startedAt: '2026-01-01T00:00:00Z', restarts: 0 }]
    const r = await startFakeRunner({ runnerKey: KEY, bootId: 'boot-1', state: 'out_of_date', workers })
    const body = await (await fetch(`${r.baseUrl}/runner/v1/health`, { headers: auth })).json()
    expect(body).toEqual({ platformVersion: '1.0.0', bootId: 'boot-1', state: 'out_of_date', workers })
  })

  test('each start gets a new boot id by default', async () => {
    const a = await startFakeRunner({ runnerKey: KEY })
    const b = await startFakeRunner({ runnerKey: KEY })
    expect(a.options.bootId).not.toBe(b.options.bootId)
  })

  test('reload is counted', async () => {
    const r = await startFakeRunner({ runnerKey: KEY })
    await post(`${r.baseUrl}/runner/v1/reload`, {})
    await post(`${r.baseUrl}/runner/v1/reload`, {})
    expect(r.reloads).toBe(2)
  })

  test('a sync action returns its scripted result and records the call body', async () => {
    const r = await startFakeRunner({ runnerKey: KEY, actions: { 'demo/run': c => ({ result: { echo: c.body.params } }) } })
    const res = await post(`${r.baseUrl}/runner/v1/plugins/demo/actions/run`, action({ params: { a: 1 } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, result: { echo: { a: 1 } } })
    expect(r.actionCalls).toEqual([{ pluginId: 'demo', action: 'run', body: action({ params: { a: 1 } }) }])
  })

  test('a script can answer an error status (busy, timeout)', async () => {
    const r = await startFakeRunner({ runnerKey: KEY, actions: { 'demo/run': () => ({ status: 429, body: { code: 'plugin_busy' } }) } })
    const res = await post(`${r.baseUrl}/runner/v1/plugins/demo/actions/run`, action())
    expect(res.status).toBe(429)
    expect((await res.json()).code).toBe('plugin_busy')
  })

  test('an async action answers 202 with the given job id at once', async () => {
    let finish!: () => void
    const done = new Promise<void>(resolve => (finish = resolve))
    const r = await startFakeRunner({ runnerKey: KEY, actions: { 'demo/run': async () => { await done; return { result: {} } } } })
    const res = await post(`${r.baseUrl}/runner/v1/plugins/demo/actions/run`, action({ async: true, jobId: 'job-1' }))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ jobId: 'job-1', bootId: r.options.bootId })
    const again = await post(`${r.baseUrl}/runner/v1/plugins/demo/actions/run`, action({ async: true, jobId: 'job-1' }))
    expect(again.status).toBe(409)
    expect((await again.json()).code).toBe('job_running')
    finish()
  })

  // As the real supervisor answers (services/plugin_runner/tests/runner_contract_cases.json).
  test('an unknown plugin answers 404 unknown_plugin, an undeclared action 404 unknown_action', async () => {
    const r = await startFakeRunner({ runnerKey: KEY, actions: { 'demo/run': () => ({ result: {} }) } })
    const plugin = await post(`${r.baseUrl}/runner/v1/plugins/nope/actions/run`, action())
    expect(plugin.status).toBe(404)
    expect((await plugin.json()).code).toBe('unknown_plugin')
    const version = await post(`${r.baseUrl}/runner/v1/plugins/demo/actions/run`,
      action({ ctx: { pluginId: 'demo', version: '2.0.0', userId: 'u' } }))
    expect(version.status).toBe(404)
    expect((await version.json()).code).toBe('unknown_plugin')
    const undeclared = await post(`${r.baseUrl}/runner/v1/plugins/demo/actions/other`, action())
    expect(undeclared.status).toBe(404)
    expect((await undeclared.json()).code).toBe('unknown_action')
  })

  test('cancel of a running job is accepted and recorded; an unknown job is 404 unknown_job', async () => {
    let finish!: () => void
    const r = await startFakeRunner({
      runnerKey: KEY,
      actions: { 'demo/run': () => new Promise((resolve) => { finish = () => resolve({ result: {} }) }) },
    })
    await post(`${r.baseUrl}/runner/v1/plugins/demo/actions/run`, action({ async: true, jobId: 'job-9' }))
    expect((await post(`${r.baseUrl}/runner/v1/plugins/demo/jobs/job-9/cancel`, {})).status).toBe(200)
    expect(r.cancels).toEqual([{ pluginId: 'demo', jobId: 'job-9' }])
    const unknown = await post(`${r.baseUrl}/runner/v1/plugins/demo/jobs/job-0/cancel`, {})
    expect(unknown.status).toBe(404)
    expect((await unknown.json()).code).toBe('unknown_job')
    expect(r.cancels).toHaveLength(1)
    finish()
  })

  test.each([
    [{ token: '' }, 'token is required.'],
    [{ params: [] }, 'params must be a JSON object.'],
    [{ ctx: { pluginId: 'demo', version: '1.0.0' } }, 'ctx needs pluginId, version and userId.'],
    [{ timeoutSeconds: 0 }, 'timeoutSeconds must be a number of at least 1.'],
    [{ async: 'yes' }, 'async must be true or false.'],
    [{ async: true }, 'An async action needs the jobId the webapp created.'],
  ])('a body the supervisor refuses (%j) is 400 bad_request, before the script runs', async (change, message) => {
    let ran = false
    const r = await startFakeRunner({ runnerKey: KEY, actions: { 'demo/run': () => { ran = true; return { result: {} } } } })
    const res = await post(`${r.baseUrl}/runner/v1/plugins/demo/actions/run`, action(change))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: message, code: 'bad_request' })
    expect(ran).toBe(false)
  })

  test('an out-of-date runner refuses every action with 503 runner_out_of_date', async () => {
    const r = await startFakeRunner({ runnerKey: KEY, state: 'out_of_date', actions: { 'demo/run': () => ({ result: {} }) } })
    const res = await post(`${r.baseUrl}/runner/v1/plugins/demo/actions/run`, action())
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('runner_out_of_date')
  })

  test('the versions a plugin runs can be set', async () => {
    const r = await startFakeRunner({ runnerKey: KEY, versions: { demo: ['2.0.0'] }, actions: { 'demo/run': () => ({ result: {} }) } })
    const run = (version: string) => post(`${r.baseUrl}/runner/v1/plugins/demo/actions/run`,
      action({ ctx: { pluginId: 'demo', version, userId: 'u' } }))
    expect((await run('2.0.0')).status).toBe(200)
    expect((await run('1.0.0')).status).toBe(404)
  })

  test('logs return the last N lines, N capped at 1000', async () => {
    const lines = Array.from({ length: 1500 }, (_, i) => `line ${i}`)
    const r = await startFakeRunner({ runnerKey: KEY, logs: { demo: lines } })
    const last3 = await (await fetch(`${r.baseUrl}/runner/v1/plugins/demo/logs?lines=3`, { headers: auth })).json()
    expect(last3.lines).toEqual(['line 1497', 'line 1498', 'line 1499'])
    const capped = await (await fetch(`${r.baseUrl}/runner/v1/plugins/demo/logs?lines=5000`, { headers: auth })).json()
    expect(capped.lines).toHaveLength(1000)
  })
})
