import { NextResponse } from 'next/server'
import { requireEffectiveUser } from '@/lib/access'
import { PLUGIN_PLATFORM_VERSION } from '@/lib/plugins/platformVersion'
import { RunnerError, RunnerUnavailableError, runnerHealth } from '@/lib/plugins/runnerClient'
import { pluginsDisabledResponse, pluginsEnabled } from '@/lib/plugins/switch'

/**
 * GET /api/plugins/status: this webapp's platform version and what the plugin runner
 * reports, for the Plugins page's runner banner. A runner that is down, misconfigured
 * or out of date is a state to show, never a 5xx: nothing else depends on it (D-21).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  if (!pluginsEnabled()) return pluginsDisabledResponse()
  const user = await requireEffectiveUser()
  if (user instanceof NextResponse) return user

  let runner: Record<string, unknown>
  try {
    const h = await runnerHealth()
    runner = { reachable: true, platformVersion: h.platformVersion, state: h.state, workers: h.workers.length }
  } catch (e) {
    if (e instanceof RunnerUnavailableError) {
      runner = { reachable: false, error: e.reason === 'not_configured' ? 'runner_not_configured' : e.code }
    } else if (e instanceof RunnerError) {
      runner = { reachable: false, error: e.code }
    } else {
      throw e
    }
    console.warn(`[plugins] status: runner not reachable (${runner.error})`)
  }
  return NextResponse.json(
    { platformVersion: PLUGIN_PLATFORM_VERSION, runner },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
