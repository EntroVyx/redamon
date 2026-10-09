import type { NextRequest } from 'next/server'
import { sessionRunningState } from '@/lib/agentSessions'
import { GatewayError, withGateway } from '@/lib/plugins/gateway'
import { readTranscript } from '@/lib/plugins/transcript'

/**
 * POST /api/plugin-gateway/v1/session/read (`sdk.session.read`, needs `session:read`):
 * the session the action was started from, masked and capped (lib/plugins/transcript.ts).
 * `running` is the agent's answer for this session, not the stored flag.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(request: NextRequest) {
  return withGateway(request, { op: 'session/read', permission: 'session:read' }, async (ctx) => {
    if (!ctx.conversation) throw new GatewayError(400, 'no_session', 'This action was not started from a session.')
    const running = await sessionRunningState(ctx.conversation)
    return { ...(await readTranscript(ctx.conversation, { running })) }
  })
}
