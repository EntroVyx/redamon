import { NextResponse, type NextRequest } from 'next/server'
import { getEffectiveUser } from '@/lib/session'
import { buildVersionsModel } from '@/lib/plugins/versionsModel'

/**
 * GET /api/plugins/overrides/versions?point=skill.text&group=<skill>&projectId=<id>: the
 * versions of a built-in skill in the effective user's scope, plus a project they own when
 * `projectId` is given (design §6). Another user's scope is never listed.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const eff = await getEffectiveUser()
  if (!eff) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  if (url.searchParams.get('point') !== 'skill.text') {
    return NextResponse.json({ error: 'Only skill.text versions are listed here.', code: 'bad_point' }, { status: 400 })
  }
  const group = url.searchParams.get('group') ?? ''
  const projectId = url.searchParams.get('projectId')
  const model = await buildVersionsModel(eff.userId, group, projectId)
  if (!model) return NextResponse.json({ error: 'No such built-in skill.', code: 'unknown_skill' }, { status: 404 })
  return NextResponse.json(model, { headers: { 'Cache-Control': 'no-store' } })
}
