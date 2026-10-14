import type { NextRequest } from 'next/server'
import { disable } from '@/lib/plugins/lifecycle'
import { lifecyclePost } from '@/lib/plugins/lifecycleRoutes'

/** POST /api/plugins/[pluginId]/disable (admin): code and data stay. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ pluginId: string }> }) {
  const { pluginId } = await params
  return lifecyclePost(request, `disable ${pluginId}`, (_body, adminId) => disable(pluginId, adminId))
}
