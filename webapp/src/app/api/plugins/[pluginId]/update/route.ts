import type { NextRequest } from 'next/server'
import { update, type UpdateInput } from '@/lib/plugins/lifecycle'
import { lifecyclePost } from '@/lib/plugins/lifecycleRoutes'

/** POST /api/plugins/[pluginId]/update `{version, acceptedPermissions}` (admin): side by side, with data migrations. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ pluginId: string }> }) {
  const { pluginId } = await params
  return lifecyclePost(request, `update ${pluginId}`, (body, adminId) => update(pluginId, body as unknown as UpdateInput, adminId))
}
