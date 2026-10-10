import type { NextRequest } from 'next/server'
import { install, type InstallInput } from '@/lib/plugins/lifecycle'
import { lifecyclePost } from '@/lib/plugins/lifecycleRoutes'

/** POST /api/plugins/[pluginId]/install `{version, acceptedPermissions, restoreOverrides?}` (admin). */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ pluginId: string }> }) {
  const { pluginId } = await params
  return lifecyclePost(request, `install ${pluginId}`, (body, adminId) => install(pluginId, body as unknown as InstallInput, adminId))
}
