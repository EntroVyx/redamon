import type { NextRequest } from 'next/server'
import { handleAction } from '@/lib/plugins/actions'

/** POST /api/plugins/[pluginId]/actions/[actionId]: runs a plugin action for the signed-in user (lib/plugins/actions.ts). */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ pluginId: string; actionId: string }> }) {
  const { pluginId, actionId } = await params
  return handleAction(request, pluginId, actionId)
}
