import { NextResponse, type NextRequest } from 'next/server'
import { exportPluginData } from '@/lib/plugins/exportData'
import { lifecycleGet } from '@/lib/plugins/lifecycleRoutes'

/** GET /api/plugins/[pluginId]/export (admin): every row the plugin left, as a JSON download. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ pluginId: string }> }) {
  const { pluginId } = await params
  return lifecycleGet(`export ${pluginId}`, async (adminId) => {
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
