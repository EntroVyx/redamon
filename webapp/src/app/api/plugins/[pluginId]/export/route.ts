import { NextResponse, type NextRequest } from 'next/server'
import { exportPluginData } from '@/lib/plugins/exportData'
import { errorResponse, lifecycleGet } from '@/lib/plugins/lifecycleRoutes'

/** GET /api/plugins/[pluginId]/export (admin): every row the plugin left, as a JSON download. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ pluginId: string }> }) {
  const { pluginId } = await params
  return lifecycleGet(`export ${pluginId}`, async (adminId) => {
    // A download unlocks a purge for an hour: a link on another site must not count as one.
    // Browsers send Sec-Fetch-Site on every request; the page's own link is same-origin.
    if (request.headers.get('sec-fetch-site') === 'cross-site') {
      return errorResponse(403, 'cross_site', 'The export is downloaded from the Plugins page itself.')
    }
    const out = await exportPluginData(pluginId, adminId)
    return new NextResponse(out.body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${out.filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  })
}
