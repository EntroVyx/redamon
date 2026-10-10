/**
 * A fake plugin-runner supervisor (phase 03 "Supervisor API") for webapp tests:
 * the same routes and key check, scripted answers, every call recorded. It is
 * the double behind `runnerClient.ts` (rule T3); the contract suite of step 3.8
 * runs the same cases against it and the real image.
 *
 *   GET  /runner/v1/health
 *   POST /runner/v1/reload
 *   POST /runner/v1/plugins/{id}/actions/{action}      sync 200 | async 202 {jobId, bootId}
 *   POST /runner/v1/plugins/{id}/jobs/{jobId}/cancel     200 | 404 unknown_job
 *   GET  /runner/v1/plugins/{id}/logs?lines=N
 *
 * Every route requires `X-Plugin-Runner-Key`; no key configured → 503
 * `runner_not_configured` (fail closed, TD-08). An action is checked in the supervisor's
 * order (supervisor/app.py): the body (400 bad_request), the runner being out of date (503
 * runner_out_of_date), the plugin at `ctx.version` (404 unknown_plugin), the action (404
 * unknown_action), an async job id already running (409 job_running).
 */
import { randomUUID, timingSafeEqual } from 'crypto'
import { startFakeServer, type FakeRequest, type FakeResponse, type FakeServer } from './fakeHttpServer'

export const RUNNER_KEY_HEADER = 'x-plugin-runner-key'

export interface FakeWorker {
  id: string
  version: string
  pid: number
  uid: number
  inFlight: number
  startedAt: string
  restarts: number
  /** As the supervisor's describe(): starting, ready, failed, restarting, stopping, stopped. */
  state?: string
}

export interface ActionCall {
  pluginId: string
  action: string
  body: Record<string, unknown>
}

/** The scripted outcome of one action call; `result` is wrapped as `{ok: true, result}`. */
export type ActionScript = (call: ActionCall) => FakeResponse | { result: unknown } | Promise<FakeResponse | { result: unknown }>

export interface FakeRunnerOptions {
  /** The key the fake demands; '' or undefined → every route 503 runner_not_configured. */
  runnerKey?: string
  platformVersion?: string
  bootId?: string
  state?: 'ok' | 'out_of_date' | 'degraded'
  workers?: FakeWorker[]
  /**
   * Keyed `${pluginId}/${action}`. A plugin with no key here answers 404 unknown_plugin,
   * an undeclared action of a known plugin 404 unknown_action (as the real supervisor).
   */
  actions?: Record<string, ActionScript>
  /** Keyed by plugin id. */
  logs?: Record<string, string[]>
  /** The versions running per plugin id; a plugin not listed runs 1.0.0. */
  versions?: Record<string, string[]>
  /**
   * Called on each reload before it answers, as the supervisor converges on the run list
   * then: a test sets here the workers (and their state) the reload leaves running.
   */
  onReload?: (options: FakeRunnerOptions) => void | Promise<void>
}

export interface FakeRunner {
  server: FakeServer
  baseUrl: string
  options: Required<Pick<FakeRunnerOptions, 'platformVersion' | 'bootId' | 'state'>> & FakeRunnerOptions
  reloads: number
  actionCalls: ActionCall[]
  /** Accepted cancels: of jobs whose script was still running. */
  cancels: Array<{ pluginId: string; jobId: string }>
  /** Calls refused for a missing or wrong key. */
  refused: FakeRequest[]
  close(): Promise<void>
}

function json(status: number, body: object): FakeResponse {
  return { status, body }
}

/** The supervisor's `_action_body` checks; the message of the first one that fails. */
function actionBodyError(body: Record<string, unknown>): string | null {
  const { token, params, ctx, timeoutSeconds, jobId } = body
  const isAsync = body.async ?? false
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (typeof token !== 'string' || !token) return 'token is required.'
  if (!obj(params)) return 'params must be a JSON object.'
  if (!obj(ctx) || !['pluginId', 'version', 'userId'].every((k) => typeof ctx[k] === 'string' && ctx[k])) {
    return 'ctx needs pluginId, version and userId.'
  }
  if (typeof timeoutSeconds !== 'number' || timeoutSeconds < 1) return 'timeoutSeconds must be a number of at least 1.'
  if (typeof isAsync !== 'boolean') return 'async must be true or false.'
  if (jobId !== undefined && jobId !== null && (typeof jobId !== 'string' || !jobId || jobId.length > 200)) {
    return 'jobId must be a short string.'
  }
  if (isAsync && (jobId === undefined || jobId === null)) return 'An async action needs the jobId the webapp created.'
  return null
}

function keyMatches(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function startFakeRunner(opts: FakeRunnerOptions = {}): Promise<FakeRunner> {
  const options = {
    platformVersion: '1.0.0',
    bootId: randomUUID(),
    state: 'ok' as const,
    ...opts,
  }
  // What the routes record; it becomes the returned runner, so tests read live values.
  const record = {
    reloads: 0,
    actionCalls: [] as ActionCall[],
    cancels: [] as Array<{ pluginId: string; jobId: string }>,
    refused: [] as FakeRequest[],
  }
  // `${pluginId}/${jobId}` of async scripts still running, for cancel.
  const running = new Set<string>()
  const knownPlugin = (id: string) => Object.keys(options.actions ?? {}).some((k) => k.startsWith(`${id}/`))

  const handle = async (req: FakeRequest): Promise<FakeResponse> => {
    if (!options.runnerKey) return json(503, { error: 'The plugin runner has no key configured.', code: 'runner_not_configured' })
    if (!keyMatches(req.headers[RUNNER_KEY_HEADER], options.runnerKey)) {
      record.refused.push(req)
      return json(401, { error: 'Invalid or missing runner key.', code: 'unauthorized' })
    }
    const p = req.path
    if (req.method === 'GET' && p === '/runner/v1/health') {
      return json(200, { platformVersion: options.platformVersion, bootId: options.bootId, state: options.state, workers: options.workers ?? [] })
    }
    if (req.method === 'POST' && p === '/runner/v1/reload') {
      record.reloads++
      await options.onReload?.(options)
      return json(200, { ok: options.state === 'ok', state: options.state, workers: (options.workers ?? []).length })
    }
    let m = /^\/runner\/v1\/plugins\/([^/]+)\/actions\/([^/]+)$/.exec(p)
    if (req.method === 'POST' && m) {
      const [pluginId, action] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])]
      let body: Record<string, unknown>
      try {
        body = JSON.parse(req.body.toString('utf8') || '{}')
      } catch {
        return json(400, { error: 'Body is not JSON.', code: 'bad_request' })
      }
      const call = { pluginId, action, body }
      record.actionCalls.push(call)
      const invalid = actionBodyError(body)
      if (invalid) return json(400, { error: invalid, code: 'bad_request' })
      if (options.state === 'out_of_date') {
        return json(503, {
          error: 'The plugin runner is out of date for this RedAmon version; rebuild it.', code: 'runner_out_of_date',
        })
      }
      const version = (body.ctx as Record<string, string>).version
      if (!knownPlugin(pluginId) || !(options.versions?.[pluginId] ?? ['1.0.0']).includes(version)) {
        return json(404, { error: `Plugin ${pluginId} ${version} is not running.`, code: 'unknown_plugin' })
      }
      const script = options.actions?.[`${pluginId}/${action}`]
      if (!script) return json(404, { error: `Plugin ${pluginId} declares no action ${action}.`, code: 'unknown_action' })
      if (body.async === true) {
        const jobId = body.jobId as string
        const key = `${pluginId}/${jobId}`
        if (running.has(key)) return json(409, { error: `Job ${jobId} is already running.`, code: 'job_running' })
        running.add(key)
        // The job's outcome is the caller's to observe; a rejection must not crash the test run.
        void Promise.resolve(script(call))
          .catch(() => undefined)
          .finally(() => running.delete(key))
        return json(202, { jobId, bootId: options.bootId })
      }
      const out = await script(call)
      return 'result' in out ? json(200, { ok: true, result: out.result }) : out
    }
    m = /^\/runner\/v1\/plugins\/([^/]+)\/jobs\/([^/]+)\/cancel$/.exec(p)
    if (req.method === 'POST' && m) {
      const [pluginId, jobId] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])]
      if (!running.has(`${pluginId}/${jobId}`)) {
        return json(404, { error: `Job ${jobId} is not running.`, code: 'unknown_job' })
      }
      record.cancels.push({ pluginId, jobId })
      return json(200, { ok: true })
    }
    m = /^\/runner\/v1\/plugins\/([^/]+)\/logs$/.exec(p)
    if (req.method === 'GET' && m) {
      const lines = options.logs?.[decodeURIComponent(m[1])] ?? []
      const n = Math.min(Math.max(parseInt(req.query.get('lines') ?? '200', 10) || 200, 1), 1000)
      return json(200, { lines: lines.slice(-n) })
    }
    return json(404, { error: 'Not found.', code: 'not_found' })
  }

  const server = await startFakeServer({}, { fallback: handle })
  return Object.assign(record, { server, baseUrl: server.baseUrl, options, close: () => server.close() })
}
