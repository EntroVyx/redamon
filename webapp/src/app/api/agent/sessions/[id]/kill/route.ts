import { NextRequest, NextResponse } from 'next/server'
import { internalKeyHeaders } from '@/lib/agentAuth'

const AGENT_API_URL = process.env.AGENT_API_URL || process.env.NEXT_PUBLIC_AGENT_API_URL || 'http://localhost:8080'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const resp = await fetch(`${AGENT_API_URL}/sessions/${id}/kill`, {
      method: 'POST',
      headers: internalKeyHeaders(),
    })
    if (!resp.ok) {
      const text = await resp.text()
      return NextResponse.json({ error: text }, { status: resp.status })
    }
    return NextResponse.json(await resp.json())
  } catch (error) {
    console.error('Session kill proxy error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to kill session' },
      { status: 502 }
    )
  }
}
