/**
 * POST /api/plugin-gateway/v1/session/read (`sdk.session.read`, D-42, D-46, R-62): the
 * token's own session, masked, capped, marked untrusted, never stored. `running` comes
 * from the agent's live list for THIS session, because `Conversation.agentRunning` stays
 * true after an agent crash and can miss a lost PATCH.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  db: null as unknown as Record<string, unknown>,
  agent: null as unknown as (path: string) => Promise<Response>,
}))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/agentFetch', () => ({
  agentFetch: (path: string) => h.agent(path),
  AgentUnreachableError: class extends Error {},
}))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import {
  ALICE_CONV,
  ALICE_PROJECT,
  ALICE_SESSION,
  BOB_SESSION,
  CALL_SECRET,
  answer,
  echoInstall,
  gatewayRequest,
  seedWorld,
  token,
} from './__testing__/gatewayHarness'
import { POST as sessionRead } from '@/app/api/plugin-gateway/v1/session/read/route'

let db: FakePrisma
const T = (ms: number) => new Date(Date.parse('2026-10-09T10:00:00.000Z') + ms)
let agentPaths: string[]

function agentAnswers(sessionIds: string[] | 'down' | 'error') {
  h.agent = async (path: string) => {
    agentPaths.push(path)
    if (sessionIds === 'down') throw new Error('connect ECONNREFUSED')
    if (sessionIds === 'error') return new Response('{"detail":"not ready"}', { status: 503 })
    return Response.json({ session_ids: sessionIds })
  }
}

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  seedWorld(db)
  agentPaths = []
  agentAnswers([])
  vi.stubEnv('PLUGINS_ENABLED', 'true')
  vi.stubEnv('PLUGIN_CALL_TOKEN_SECRET', CALL_SECRET)
  vi.stubEnv('AUTH_SECRET', 'a'.repeat(64))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function message(seq: number, type: string, data: unknown, ms = seq * 1000, conversationId = ALICE_CONV) {
  return { conversationId, sequenceNum: seq, type, data, createdAt: T(ms) }
}

const read = async (over: Parameters<typeof token>[0] = {}) =>
  answer(await sessionRead(gatewayRequest('session/read', {}, { token: await token(over) })))

describe('the transcript', () => {
  beforeEach(() => {
    db.seed('chatMessage', [
      message(2, 'assistant_message', { content: 'Starting with recon of example.com' }),
      message(0, 'user_message', { content: 'scan example.com, my key is AKIAIOSFODNN7EXAMPLE' }),
      message(1, 'tool_complete', {
        tool_name: 'execute_curl',
        raw_output: 'HTTP/1.1 200 OK\r\nSet-Cookie: x=1\r\n\r\n',
        nested: { request: 'GET / HTTP/1.1\r\nCookie: session=abcdef0123456789\r\n', list: ['token abcdefgh12345678'] },
      }),
      message(0, 'thinking', { thought: 'other conversation' }, 0, 'conv-bob'),
    ])
  })

  test('the token’s session, in order, masked inside nested data, marked untrusted', async () => {
    const r = await read()
    expect(r.status).toBe(200)
    const body = r.body as unknown as {
      meta: Record<string, unknown>
      events: { seq: number; type: string; at: string; data: Record<string, unknown> }[]
      truncated: unknown
      untrusted: boolean
    }
    expect(body.events.map((e) => [e.seq, e.type])).toEqual([
      [0, 'user_message'],
      [1, 'tool_complete'],
      [2, 'assistant_message'],
    ])
    expect(body.events[0]).toEqual({
      seq: 0,
      type: 'user_message',
      at: '2026-10-09T10:00:00.000Z',
      data: { content: 'scan example.com, my key is AKIA[REDACTED 20 chars]' },
    })
    expect(body.events[1].data).toEqual({
      tool_name: 'execute_curl',
      raw_output: 'HTTP/1.1 200 OK\r\nSet-Cookie: x=1\r\n\r\n',
      nested: { request: 'GET / HTTP/1.1\r\nCookie: session=abcd[REDACTED 16 chars]\r\n', list: ['token abcd[REDACTED 16 chars]'] },
    })
    expect(body.truncated).toEqual({ keptEvents: 3, droppedEvents: 0 })
    expect(body.untrusted).toBe(true)
    expect(body.meta).toMatchObject({
      id: ALICE_CONV,
      title: 'Recon of example.com',
      status: 'active',
      currentPhase: 'informational',
      iterationCount: 0,
      running: false,
      highWaterSeq: 2,
    })
  })

  test('nothing is written while reading: the transcript is never stored', async () => {
    const before = JSON.stringify([db.rows('pluginData'), db.rows('chatMessage'), db.rows('conversation')])
    await read()
    expect(JSON.stringify([db.rows('pluginData'), db.rows('chatMessage'), db.rows('conversation')])).toBe(before)
  })

  test('the cap keeps the priority events and records what it dropped', async () => {
    vi.stubEnv('PLUGIN_TRANSCRIPT_MAX_BYTES', '6000')
    db.seed(
      'chatMessage',
      Array.from({ length: 40 }, (_, i) => message(10 + i, 'thinking', { thought: `${i} ` + 'x'.repeat(400) })),
    )
    db.seed('chatMessage', [message(60, 'error', { message: 'tool failed' }), message(61, 'deep_think', { thought: 'rethink' })])
    const r = await read()
    const body = r.body as unknown as { events: { type: string; seq: number }[]; truncated: { keptEvents: number; droppedEvents: number } }
    expect(Buffer.byteLength(JSON.stringify(r.body), 'utf8')).toBeLessThanOrEqual(6000)
    const types = body.events.map((e) => e.type)
    for (const t of ['user_message', 'assistant_message', 'error', 'deep_think']) expect(types).toContain(t)
    expect(body.truncated.droppedEvents).toBeGreaterThan(0)
    expect(body.truncated.keptEvents + body.truncated.droppedEvents).toBe(45)
  })
})

describe('who may read it', () => {
  test('without session:read granted: 403 with the contract body', async () => {
    await db.pluginInstall.update({ where: { pluginId: 'echo' }, data: { grantedPermissions: ['llm:invoke'] } })
    expect(await read()).toEqual({
      status: 403,
      body: { error: 'This plugin was not granted session:read.', code: 'permission_denied' },
    })
  })

  test('an action not started from a session: 400 no_session with the contract body', async () => {
    expect(await read({ ses: undefined, conv: undefined })).toEqual({
      status: 400,
      body: { error: 'This action was not started from a session.', code: 'no_session' },
    })
  })

  test('a session not bound to the token’s user: 404', async () => {
    expect((await read({ ses: BOB_SESSION, conv: undefined })).status).toBe(404)
  })

  test('a disabled plugin: 403', async () => {
    db = createFakePrisma()
    h.db = db as unknown as Record<string, unknown>
    seedWorld(db, { install: echoInstall({ enabled: false }) })
    expect((await read()).status).toBe(403)
  })
})

describe('running comes from the agent for this session (RV-14)', () => {
  test('live in the agent although the flag is false: true', async () => {
    agentAnswers([ALICE_SESSION, 'session-other'])
    expect(((await read()).body.meta as { running: unknown }).running).toBe(true)
    expect(agentPaths).toEqual([`/agent-sessions/live?project_id=${ALICE_PROJECT}`])
  })

  test('a stale true flag the agent does not hold: false, and the flag is cleared', async () => {
    await db.conversation.update({ where: { sessionId: ALICE_SESSION }, data: { agentRunning: true } })
    agentAnswers(['session-other'])
    expect(((await read()).body.meta as { running: unknown }).running).toBe(false)
    expect((await db.conversation.findUnique({ where: { sessionId: ALICE_SESSION } }))!.agentRunning).toBe(false)
  })

  test.each(['down', 'error'] as const)('agent %s: unverified, and the flag is left alone', async (state) => {
    await db.conversation.update({ where: { sessionId: ALICE_SESSION }, data: { agentRunning: true } })
    agentAnswers(state)
    expect(((await read()).body.meta as { running: unknown }).running).toBe('unverified')
    expect((await db.conversation.findUnique({ where: { sessionId: ALICE_SESSION } }))!.agentRunning).toBe(true)
  })

  test('not live and no flag: false', async () => {
    expect(((await read()).body.meta as { running: unknown }).running).toBe(false)
  })
})
