import { NextRequest, NextResponse } from 'next/server'
import { internalKeyHeaders } from '@/lib/agentAuth'

const AGENT_API_URL = process.env.AGENT_API_URL || process.env.NEXT_PUBLIC_AGENT_API_URL || 'http://localhost:8080'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const body = await request.json()
    const resp = await fetch(`${AGENT_API_URL}/sessions/${id}/interact`, {
      method: 'POST',
      headers: internalKeyHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const text = await resp.text()
      return NextResponse.json({ error: text }, { status: resp.status })
    }
    return NextResponse.json(await resp.json())
  } catch (error) {
    console.error('Session interact proxy error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to interact with session' },
      { status: 502 }
    )
  }
}
