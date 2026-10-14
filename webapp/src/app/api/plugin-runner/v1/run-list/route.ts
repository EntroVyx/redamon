import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { constantTimeEqual } from '@/lib/constantTimeEqual'
import { PLUGIN_PLATFORM_VERSION } from '@/lib/plugins/platformVersion'
import { showsContributions } from '@/lib/plugins/registry'
import { RUNNER_KEY_HEADER } from '@/lib/plugins/runnerClient'

/**
 * GET /api/plugin-runner/v1/run-list: the plugin versions the runner must run
 * (README.PLUGINS.md §7.2). The runner holds no database credentials, so it asks here,
 * through the plugin-gateway proxy, at start, every 60 s and on reload.
 *
 * Cookie-less (a TOKEN_AUTH_PREFIXES path in middleware.ts): the runner key is the only
 * credential, compared in constant time and failing closed. The session, X-Internal-Key
 * and the x-user-* headers mean nothing here.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Where the runner mounts the plugins volume; the webapp's own mount (PLUGINS_DIR) differs.
const RUNNER_PLUGINS_ROOT = '/plugins'
const NO_STORE = { 'Cache-Control': 'no-store' }

function refuse(status: number, code: string, error: string) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE })
}

export async function GET(request: NextRequest) {
  const expected = (process.env.PLUGIN_RUNNER_KEY || '').trim()
  if (!expected || expected === 'changeme') {
    console.error('[plugins] run-list refused: PLUGIN_RUNNER_KEY is not configured')
    return refuse(503, 'runner_not_configured', 'The plugin runner key is not configured.')
  }
  const given = request.headers.get(RUNNER_KEY_HEADER)
  if (!given || !constantTimeEqual(given, expected)) {
    console.warn('[plugins] run-list refused: missing or wrong runner key')
    return refuse(401, 'unauthorized', 'Invalid or missing runner key.')
  }

  // The rows whose contributions show: during an update the active version keeps running.
  const rows = await prisma.pluginInstall.findMany({
    where: { enabled: true, revokedReason: null, status: { in: ['ready', 'updating'] } },
    orderBy: { pluginId: 'asc' },
  })
  const plugins = rows
    .filter((r) => showsContributions(r) && r.activeVersion && r.manifest && typeof r.manifest === 'object')
    .map((r) => ({
      id: r.pluginId,
      version: r.activeVersion as string,
      manifest: r.manifest,
      root: `${RUNNER_PLUGINS_ROOT}/${r.pluginId}/versions/${r.activeVersion}`,
    }))
  return NextResponse.json({ platformVersion: PLUGIN_PLATFORM_VERSION, plugins }, { headers: NO_STORE })
}
