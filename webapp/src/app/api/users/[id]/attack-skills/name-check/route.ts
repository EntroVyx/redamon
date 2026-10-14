import { NextRequest, NextResponse } from 'next/server'
import { requireUserAccess } from '@/lib/session'
import prisma from '@/lib/prisma'
import { isNameTaken, nameProblem, normalizeName, suggestVersionName } from '@/lib/userSkillNames'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/users/[id]/attack-skills/name-check?name=&sourceId=&exceptId= →
 * `{available, normalized, suggestion, reason?}`.
 *
 * Read-only, and it tells nothing the list route does not already show the same caller.
 * `sourceId` makes the suggestion the next version of that skill (`<root> vN`); `exceptId`
 * is the skill being renamed, whose own name does not count as taken. The write checks
 * again under its lock: this is the form's early answer, not the rule.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params
    const __denied = await requireUserAccess(request, id)
    if (__denied) return __denied
    const qs = request.nextUrl.searchParams
    const normalized = normalizeName(qs.get('name') ?? '')
    const exceptId = qs.get('exceptId') || undefined
    const sourceId = qs.get('sourceId') || undefined

    const source = sourceId
      ? await prisma.userAttackSkill.findFirst({
          where: { id: sourceId, userId: id }, select: { id: true, name: true, lineageRootId: true },
        })
      : null
    const problem = nameProblem(normalized)
    const taken = problem ? false : await isNameTaken(prisma, id, normalized, exceptId)
    const needSuggestion = !!source || taken
    const suggestion = needSuggestion
      ? (await suggestVersionName(prisma, id, source ?? { id: exceptId ?? '', name: normalized || 'Skill', lineageRootId: null })).name
      : null
    return NextResponse.json({
      available: !problem && !taken,
      normalized,
      suggestion,
      ...(problem ? { reason: problem.code } : taken ? { reason: 'name_taken' } : {}),
    })
  } catch (error) {
    console.error('Failed to check a skill name:', error)
    return NextResponse.json({ error: 'Failed to check the name' }, { status: 500 })
  }
}
