/**
 * Plugin actions end to end on a running stack (D-63, D-21, phase 04 step 4.8): the
 * webapp, the plugin-gateway proxy and the runner with the `echo` fixture installed by
 * hand (files in the plugins volume, a ready `plugin_installs` row). A sync action, an
 * async one whose worker reports through the Gateway, a session read and data paging
 * through the Gateway, a plugin error, a cancel, and a worker crash that leaves the
 * platform serving.
 *
 * Skipped unless PLUGINS_INTEGRATION=1, with:
 *   PLUGINS_INTEGRATION_URL      the webapp (default http://localhost:3000)
 *   PLUGINS_INTEGRATION_COOKIE   a login token (redamon-auth) of the user below
 *   PLUGINS_INTEGRATION_PROJECT  a project of that user
 *   PLUGINS_INTEGRATION_SESSION  a chat session of that project
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'

const ON = process.env.PLUGINS_INTEGRATION === '1'
const BASE = (process.env.PLUGINS_INTEGRATION_URL || 'http://localhost:3000').replace(/\/+$/, '')
const COOKIE = process.env.PLUGINS_INTEGRATION_COOKIE || ''
const PROJECT = process.env.PLUGINS_INTEGRATION_PROJECT || ''
const SESSION = process.env.PLUGINS_INTEGRATION_SESSION || ''

async function call(path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, cookie: `redamon-auth=${COOKIE}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

const action = (id: string, params: Record<string, unknown> = {}, context: Record<string, unknown> = { projectId: PROJECT, sessionId: SESSION }) =>
  call(`/api/plugins/echo/actions/${id}`, { context, params })

async function waitForJob(jobId: string, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const job = await call(`/api/plugins/jobs/${jobId}`)
    if (!['queued', 'running'].includes(job.body.status as string) || Date.now() > until) return job
    await new Promise((r) => setTimeout(r, 500))
  }
}

describe.skipIf(!ON)('plugin actions on the running stack (PLUGINS_INTEGRATION=1)', () => {
  test('the configuration is complete', () => {
    expect(COOKIE && PROJECT && SESSION, 'set PLUGINS_INTEGRATION_COOKIE, _PROJECT and _SESSION').toBeTruthy()
  })

  test('a sync action runs in the runner with the context the webapp decided', async () => {
    const r = await action('echo', { hello: 'world' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      ok: true,
      result: { echo: { hello: 'world' }, plugin: 'echo', version: '1.0.0', project: PROJECT, session: SESSION, job: null },
    })
  }, 60_000)

  test("a plugin's own error is an answer", async () => {
    const r = await action('raise_plugin_error', { code: 'no_target', message: 'Pick a target first.' })
    expect(r).toMatchObject({ status: 200, body: { ok: false, error: { code: 'no_target', message: 'Pick a target first.' } } })
  }, 60_000)

  test('an async action: the worker reports its result through the proxy and the Gateway', async () => {
    const started = await action('sleep', { seconds: 0.5 }, { projectId: PROJECT })
    expect(started.status).toBe(202)
    const job = await waitForJob(started.body.jobId as string)
    expect(job.body).toMatchObject({ status: 'succeeded', result: { slept: 0.5 } })
  }, 90_000)

  test('a cancelled job stays cancelled', async () => {
    const started = await action('sleep', { seconds: 20 }, { projectId: PROJECT, sessionId: SESSION })
    expect(started.status).toBe(202)
    const cancelled = await call(`/api/plugins/jobs/${started.body.jobId}/cancel`, {})
    expect(cancelled.body.status).toBe('cancelled')
    await new Promise((r) => setTimeout(r, 6_000))
    expect((await call(`/api/plugins/jobs/${started.body.jobId}`)).body.status).toBe('cancelled')
  }, 60_000)

  test('the plugin reads its session through the Gateway, masked', async () => {
    const r = await action('read_session')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true })
    const result = r.body.result as { events: number; meta: { running: unknown } }
    expect(typeof result.events).toBe('number')
    expect([true, false, 'unverified']).toContain(result.meta.running)
  }, 60_000)

  test('the plugin pages its own data through the Gateway', async () => {
    const r = await action('list_items', { limit: 2 })
    expect(r).toMatchObject({ status: 200, body: { ok: true } })
    expect(Array.isArray((r.body.result as { items: unknown[] }).items)).toBe(true)
  }, 60_000)

  test('a worker that crashes fails its action; the platform keeps serving (D-12)', async () => {
    const crashed = await action('crash', { code: 3 })
    expect(crashed).toMatchObject({ status: 502, body: { code: 'worker_crashed' } })
    const status = await call('/api/plugins/status')
    expect(status.body).toMatchObject({ runner: { reachable: true } })
    // The supervisor replaces the worker with a backoff: meanwhile a coded 503, then service.
    const until = Date.now() + 30_000
    let again = await action('echo', { after: 'crash' })
    while (again.status !== 200 && Date.now() < until) {
      expect(again).toMatchObject({ status: 503, body: { code: 'worker_unavailable' } })
      await new Promise((r) => setTimeout(r, 500))
      again = await action('echo', { after: 'crash' })
    }
    expect(again.body).toMatchObject({ ok: true, result: { echo: { after: 'crash' } } })
  }, 90_000)
})
