/**
 * The supervisor API cases shared with the real runner
 * (services/plugin_runner/tests/runner_contract_cases.json, run against the real app by
 * test_supervisor_contract.py), here against the webapp's fake runner: the double behind
 * every runnerClient test cannot drift from the real thing (rule T3).
 *
 * @vitest-environment node
 */
import { describe, test, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startFakeRunner, type FakeRunnerOptions } from './__testing__/fakeRunner'
import { closeAllFakeServers } from './__testing__/fakeHttpServer'
import { ECHO_MIGRATIONS } from './__testing__/echoMigrations'

interface Request {
  method: 'GET' | 'POST'
  path: string
  key: string | null
  body?: Record<string, unknown>
}

interface Case {
  name: string
  before?: Request[]
  runnerState?: 'out_of_date'
  request: Request
  expect: { status: number; body?: unknown; bodyIncludes?: Record<string, unknown>; keys?: string[]; code?: string }
}

const CONTRACT = JSON.parse(
  readFileSync(join(__dirname, '../../../../services/plugin_runner/tests/runner_contract_cases.json'), 'utf8'),
) as { runnerKey: string; platformVersion: string; cases: Case[]; unconfigured: Case }

/** The echo fixture's behaviour for the actions the cases call. */
const ECHO: FakeRunnerOptions['actions'] = {
  'echo/echo': ({ body }) => {
    const ctx = body.ctx as Record<string, string | undefined>
    return {
      result: {
        echo: body.params, plugin: ctx.pluginId, version: ctx.version, user: ctx.userId,
        project: ctx.projectId ?? null, session: ctx.sessionId ?? null, job: ctx.jobId ?? null,
      },
    }
  },
  'echo/raise_plugin_error': ({ body }) => {
    const p = body.params as { code: string; message: string }
    return { status: 200, body: { ok: false, error: { code: p.code, message: p.message } } }
  },
  'echo/sleep': async ({ body }) => {
    const seconds = Number((body.params as { seconds?: number }).seconds ?? 0)
    await new Promise((resolve) => setTimeout(resolve, Math.min(seconds, 5) * 1000))
    return { result: { slept: seconds } }
  },
}

async function send(baseUrl: string, req: Request) {
  const headers: Record<string, string> = {}
  if (req.key === 'valid') headers['X-Plugin-Runner-Key'] = CONTRACT.runnerKey
  else if (req.key !== null) headers['X-Plugin-Runner-Key'] = req.key
  if (req.body) headers['Content-Type'] = 'application/json'
  return fetch(baseUrl + req.path, {
    method: req.method, headers, body: req.body ? JSON.stringify(req.body) : undefined,
  })
}

async function check(res: Response, e: Case['expect']) {
  expect(res.status).toBe(e.status)
  const body = (await res.json()) as Record<string, unknown>
  if (e.body !== undefined) expect(body).toEqual(e.body)
  if (e.bodyIncludes) {
    expect(Object.fromEntries(Object.keys(e.bodyIncludes).map((k) => [k, body[k]]))).toEqual(e.bodyIncludes)
  }
  if (e.keys) expect(Object.keys(body).sort()).toEqual([...e.keys].sort())
  if (e.code) expect(body.code).toBe(e.code)
}

afterEach(() => closeAllFakeServers())

describe('runner contract cases on the fake runner', () => {
  test.each(CONTRACT.cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const r = await startFakeRunner({
      runnerKey: CONTRACT.runnerKey, platformVersion: CONTRACT.platformVersion, actions: ECHO,
      migrations: ECHO_MIGRATIONS, state: c.runnerState ?? 'ok',
    })
    for (const before of c.before ?? []) await (await send(r.baseUrl, before)).body?.cancel()
    await check(await send(r.baseUrl, c.request), c.expect)
  })

  test(CONTRACT.unconfigured.name, async () => {
    const r = await startFakeRunner({ runnerKey: '', actions: ECHO })
    await check(await send(r.baseUrl, CONTRACT.unconfigured.request), CONTRACT.unconfigured.expect)
  })

  test('every case names a real supervisor route', () => {
    for (const c of CONTRACT.cases) {
      expect(c.request.path).toMatch(/^\/runner\/v1\/(health|reload|plugins\/[a-z0-9-]+\/(actions\/[a-z_]+|jobs\/[A-Za-z0-9-]+\/cancel|migrate|logs\?lines=\d+))$/)
    }
  })
})
