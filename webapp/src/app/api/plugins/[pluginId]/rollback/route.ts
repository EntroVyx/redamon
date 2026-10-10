import type { NextRequest } from 'next/server'
import { rollback } from '@/lib/plugins/lifecycle'
import { lifecyclePost } from '@/lib/plugins/lifecycleRoutes'

/**
 * POST /api/plugins/[pluginId]/rollback (admin) `{toVersion?}`: the previous version active
 * again, refused without down migrations, or when it is no longer the version confirmed.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ pluginId: string }> }) {
  const { pluginId } = await params
  return lifecyclePost(request, `rollback ${pluginId}`, (body, adminId) =>
    rollback(pluginId, adminId, undefined, (body as { toVersion?: unknown }).toVersion),
  )
}
