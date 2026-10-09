import { NextRequest, NextResponse } from 'next/server'
import { requireUserAccess } from '@/lib/session'
import prisma from '@/lib/prisma'
import { BUILT_IN_SKILLS } from '@/lib/builtinSkills'

interface RouteParams {
  params: Promise<{ id: string }>
}

// GET /api/users/[id]/attack-skills/available - Built-in + user skills for project toggle UI
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params
    const __denied = await requireUserAccess(request, id)
    if (__denied) return __denied

    const userSkills = await prisma.userAttackSkill.findMany({
      where: { userId: id },
      select: { id: true, name: true, description: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      builtIn: BUILT_IN_SKILLS,
      user: userSkills,
    })
  } catch (error) {
    console.error('Failed to fetch available attack skills:', error)
    return NextResponse.json(
      { error: 'Failed to fetch available attack skills' },
      { status: 500 }
    )
  }
}
