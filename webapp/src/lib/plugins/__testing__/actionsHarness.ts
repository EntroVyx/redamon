/**
 * Requests for the plugin action and job routes, and a fake runner wired to them through
 * PLUGIN_RUNNER_URL/KEY. The world (users, projects, sessions, the `echo` install) comes
 * from gatewayHarness; session mocks stay in each test file (vi.mock must).
 */
import { NextRequest } from 'next/server'
import { startFakeRunner, type ActionScript, type FakeRunner, type FakeRunnerOptions } from './fakeRunner'

export const APP = 'http://localhost:3000'
export const RUNNER_KEY = 'k'.repeat(64)

export interface RouteRequestOptions {
  origin?: string | null
  contentType?: string | null
  rawBody?: string
}

function request(url: string, body: unknown, opts: RouteRequestOptions = {}): NextRequest {
  const headers = new Headers()
  if (opts.contentType !== null) headers.set('content-type', opts.contentType ?? 'application/json')
  if (opts.origin) headers.set('origin', opts.origin)
  return new NextRequest(url, { method: 'POST', headers, body: opts.rawBody ?? JSON.stringify(body ?? {}) })
}

export function actionRequest(pluginId: string, actionId: string, body: unknown, opts: RouteRequestOptions = {}) {
  return request(`${APP}/api/plugins/${pluginId}/actions/${actionId}`, body, opts)
}

export const actionParams = (pluginId: string, actionId: string) => ({ params: Promise.resolve({ pluginId, actionId }) })
export const jobParams = (jobId: string) => ({ params: Promise.resolve({ jobId }) })

export function cancelRequest(jobId: string, opts: RouteRequestOptions = {}) {
  return request(`${APP}/api/plugins/jobs/${jobId}/cancel`, {}, opts)
}

export function jobGetRequest(jobId: string) {
  return new NextRequest(`${APP}/api/plugins/jobs/${jobId}`)
}

/** A fake runner for the `echo` plugin, reachable by the webapp's runner client. */
export async function startEchoRunner(
  actions: Record<string, ActionScript>,
  opts: FakeRunnerOptions = {},
): Promise<FakeRunner> {
  const runner = await startFakeRunner({ runnerKey: RUNNER_KEY, actions, ...opts })
  process.env.PLUGIN_RUNNER_URL = runner.baseUrl
  process.env.PLUGIN_RUNNER_KEY = RUNNER_KEY
  return runner
}

/** Lets a promise the route left running settle (the fake runner's async scripts). */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
