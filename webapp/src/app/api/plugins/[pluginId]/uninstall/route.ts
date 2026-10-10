import type { NextRequest } from 'next/server'
import { uninstall, type UninstallInput } from '@/lib/plugins/lifecycle'
import { lifecyclePost } from '@/lib/plugins/lifecycleRoutes'

/** POST /api/plugins/[pluginId]/uninstall `{mode: 'keep' | 'purge', confirm: '<pluginId>'}` (admin). */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ pluginId: string }> }) {
  const { pluginId } = await params
  return lifecyclePost(request, `uninstall ${pluginId}`, (body, adminId) =>
    uninstall(pluginId, body as unknown as UninstallInput, adminId),
  )
}
