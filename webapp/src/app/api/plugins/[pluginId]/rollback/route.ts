import type { NextRequest } from 'next/server'
import { rollback } from '@/lib/plugins/lifecycle'
import { lifecyclePost } from '@/lib/plugins/lifecycleRoutes'

/** POST /api/plugins/[pluginId]/rollback (admin): the previous version active again, refused without down migrations. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ pluginId: string }> }) {
  const { pluginId } = await params
  return lifecyclePost(request, `rollback ${pluginId}`, (_body, adminId) => rollback(pluginId, adminId))
}
