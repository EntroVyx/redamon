/**
 * The Gateway against the SDK's wire contract (services/plugin_runner/sdk/contract_cases.json,
 * D-39): every case with a request is replayed against the real route, in a world built
 * through the routes themselves from the case's `fake.given`, and must answer the case's
 * status, code, message and body. Ids the SDK's stub invents (a change set `fake-cs-1`, a
 * job `job-1`, a cursor) are replaced by the real ones the world produced. The cases that
 * pin the SDK's handling of a BROKEN Gateway (an answer that is not JSON, a malformed page)
 * describe answers this Gateway must never give, and are left out by name.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'crypto'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  db: null as unknown as Record<string, unknown>,
  registry: null as unknown,
  llmReply: '',
  capReached: false,
}))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn() }))
vi.mock('@/lib/agentFetch', () => ({
  AgentUnreachableError: class extends Error {},
  agentFetch: async (path: string, init?: RequestInit) => {
    if (path.startsWith('/agent-sessions/live')) return Response.json({ session_ids: [] })
    if (path === '/plugins/skill-parts') return Response.json(h.registry)
    if (path === '/plugins/skill-parts/validate') return Response.json({ ok: true, parts: {}, skill: { errors: [], chars: 0, maxChars: 0 } })
    if (path === '/plugins/llm/invoke') {
      const body = JSON.parse(String(init?.body))
      return Response.json({ content: h.llmReply, model_used: body.model, usage: { input_tokens: 0, output_tokens: 0, estimated: true } })
    }
    return Response.json({ detail: 'Not Found' }, { status: 404 })
  },
}))
vi.mock('./llmBudget', () => ({
  chargeLlmCall: async () => (h.capReached ? { allowed: false, count: null, cap: 100, key: 'llm:x' } : { allowed: true, count: 1, cap: 100, key: 'llm:x' }),
  recordLlmUsage: async () => {},
}))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { CALL_SECRET, GATEWAY_BASE } from './__testing__/gatewayHarness'
import { mintCallToken } from './callToken'
import { setNowForTests } from './clock'
import { startJob } from './jobs'
import { clearSkillPartsCache } from './skillPartsRegistry'
import { POST as sessionRead } from '@/app/api/plugin-gateway/v1/session/read/route'
import { POST as llmInvoke } from '@/app/api/plugin-gateway/v1/llm/invoke/route'
import { POST as dataGet } from '@/app/api/plugin-gateway/v1/data/get/route'
import { POST as dataPut } from '@/app/api/plugin-gateway/v1/data/put/route'
import { POST as dataQuery } from '@/app/api/plugin-gateway/v1/data/query/route'
import { POST as dataCount } from '@/app/api/plugin-gateway/v1/data/count/route'
import { POST as dataDelete } from '@/app/api/plugin-gateway/v1/data/delete/route'
import { POST as overrideGet } from '@/app/api/plugin-gateway/v1/override/get/route'
import { POST as overridePropose } from '@/app/api/plugin-gateway/v1/override/propose/route'
import { POST as overrideWithdraw } from '@/app/api/plugin-gateway/v1/override/withdraw/route'
import { POST as jobsProgress } from '@/app/api/plugin-gateway/v1/jobs/progress/route'

interface ContractCase {
  name: string
  context?: { sessionId?: string; projectId?: string; jobId?: string }
  request: { method: string; path: string; body: Record<string, unknown> } | null
  response: { status: number; body?: Record<string, unknown>; raw?: string } | null
  fake?: { setup?: Record<string, unknown>; given?: { method: string; args: unknown[]; kwargs: Record<string, unknown> }[] }
}

const CONTRACT = JSON.parse(readFileSync(join(__dirname, '../../../../services/plugin_runner/sdk/contract_cases.json'), 'utf8'))
const CASES: ContractCase[] = CONTRACT.cases
const BROKEN_GATEWAY = [
  'data.query answer with a next that is not text',
  'data.query answer without items',
  'data.count answer that is not a number',
  'an error answer that is not JSON',
  'a success answer that is not JSON',
]

const ROUTES: Record<string, (r: NextRequest) => Promise<Response>> = {
  'session/read': sessionRead,
  'llm/invoke': llmInvoke,
  'data/get': dataGet,
  'data/put': dataPut,
  'data/query': dataQuery,
  'data/count': dataCount,
  'data/delete': dataDelete,
  'override/get': overrideGet,
  'override/propose': overridePropose,
  'override/withdraw': overrideWithdraw,
  'jobs/progress': jobsProgress,
}

const PLUGIN = 'test-plugin'
const ALL = ['session:read', 'llm:invoke', 'override:skill.text']
const T0 = Date.parse('2026-10-09T10:00:00.000Z')
let db: FakePrisma
let t = T0

function defaultRegistry() {
  return { path_traversal: { skillMaxChars: 100, parts: { payload_reference: { text: 'Use ../ sequences.', maxChars: 4000 } } } }
}

function agentRegistry(
  setup: Record<string, { skillMaxChars: number; parts: Record<string, { text: string; maxChars: number; kind?: string; placeholders?: string[] }> }>,
) {
  return {
    skills: Object.entries(setup).map(([id, s]) => ({
      id,
      maxChars: s.skillMaxChars,
      parts: Object.entries(s.parts).map(([partId, p], order) => ({
        partId,
        constant: `${id}_prompts.${partId.toUpperCase()}`,
        kind: p.kind ?? 'plain',
        placeholders: p.placeholders ?? [],
        sha256: createHash('sha256').update(p.text, 'utf8').digest('hex'),
        chars: p.text.length,
        maxChars: p.maxChars,
        order,
        gate: 'always, when the skill renders',
        text: p.text,
      })),
    })),
  }
}

function seed(permissions: string[]) {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  db.seed('user', [{ id: 'user-1', name: 'U', email: 'u@example.com' }])
  db.seed('project', [{ id: 'project-1', userId: 'user-1', name: 'p' }])
  db.seed('conversation', [{ id: 'conv-1', sessionId: 'session-1', userId: 'user-1', projectId: 'project-1', title: 'Recon of example.com' }])
  db.seed('chatMessage', [
    { conversationId: 'conv-1', sequenceNum: 1, type: 'user_message', data: { text: 'scan example.com' }, createdAt: new Date('2026-10-09T10:00:00.000Z') },
    { conversationId: 'conv-1', sequenceNum: 2, type: 'assistant_message', data: { text: 'Starting.' }, createdAt: new Date('2026-10-09T10:00:05.000Z') },
  ])
  db.seed('pluginInstall', [
    {
      pluginId: PLUGIN,
      enabled: true,
      status: 'ready',
      activeVersion: '1.0.0',
      grantedPermissions: permissions,
      manifest: { id: PLUGIN, displayName: 'Test plugin', permissions: ALL, llmFeature: { description: 'x' }, actions: [] },
    },
  ])
  db.seed('userSettings', [{ userId: 'user-1', featureModels: { [`plugin:${PLUGIN}`]: 'scripted' } }])
}

async function tokenFor(ctx: ContractCase['context'] = {}, jid?: string) {
  return (
    await mintCallToken({
      pluginId: PLUGIN,
      version: '1.0.0',
      sub: 'user-1',
      prj: ctx.projectId,
      ses: ctx.sessionId,
      conv: ctx.sessionId ? 'conv-1' : undefined,
      perms: ALL,
      kind: jid ? 'job' : 'action',
      jid,
      timeoutSeconds: 900,
    })
  ).token
}

// Each call one second after the previous; the first at T0, as the contract's times assume.
async function post(path: string, body: unknown, token: string) {
  const op = path.replace('/api/plugin-gateway/v1/', '')
  const req = new NextRequest(GATEWAY_BASE + op, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const res = await ROUTES[op](req)
  t += 1000
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** A `fake.given` call, sent as the SDK client would send it. */
async function given(call: { method: string; args: unknown[]; kwargs: Record<string, unknown> }, token: string) {
  const [a, b, c] = call.args
  const k = call.kwargs
  if (call.method === 'data.put') {
    return post('data/put', { collection: a, key: b, value: c, owner: k.owner ?? 'user', ...(k.ttl_seconds ? { ttlSeconds: k.ttl_seconds } : {}) }, token)
  }
  if (call.method === 'override.propose') {
    return post('override/propose', { point: a, targetGroup: b, parts: c, note: k.note, scope: k.scope ?? 'user', ...(k.meta ? { meta: k.meta } : {}) }, token)
  }
  throw new Error(`no replay for given ${call.method}`)
}

beforeEach(() => {
  t = T0
  setNowForTests(() => new Date(t))
  clearSkillPartsCache()
  h.capReached = false
  h.llmReply = ''
  vi.stubEnv('PLUGIN_CALL_TOKEN_SECRET', CALL_SECRET)
  vi.stubEnv('AUTH_SECRET', 'a'.repeat(64))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  setNowForTests(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

test('every Gateway path of the contract has a route; the cases left out are exactly the broken-Gateway ones', () => {
  const withRequest = CASES.filter((c) => c.request)
  for (const c of withRequest) expect(ROUTES[c.request!.path.replace('/api/plugin-gateway/v1/', '')], c.name).toBeDefined()
  expect(withRequest.filter((c) => BROKEN_GATEWAY.includes(c.name)).map((c) => c.name).sort()).toEqual([...BROKEN_GATEWAY].sort())
  expect(CONTRACT.gatewayPrefix).toBe('/api/plugin-gateway/v1/')
})

const REPLAYED = CASES.filter((c) => c.request && !BROKEN_GATEWAY.includes(c.name))

describe.each(REPLAYED.map((c) => [c.name, c] as const))('%s', (_name, c) => {
  test('the route answers as the contract says', async () => {
    const setup = (c.fake?.setup ?? {}) as Record<string, unknown>
    seed((setup.permissions as string[] | undefined) ?? ALL)
    h.registry = agentRegistry((setup.registry as never) ?? defaultRegistry())
    if (Array.isArray(setup.llm)) h.llmReply = String(setup.llm[0])
    if (c.name.includes('no model chosen')) await db.userSettings.deleteMany({})
    if (c.name.includes("daily cap")) h.capReached = true
    if (c.name.includes('over the size limit')) vi.stubEnv('PLUGIN_DATA_MAX_VALUE_BYTES', '1')

    let jid: string | undefined
    if (c.context?.jobId) {
      const { job } = await startJob({
        pluginId: PLUGIN,
        userId: 'user-1',
        actionId: 'run',
        context: { projectId: null, sessionId: null, conversationId: null },
        deadline: new Date(T0 + 3_600_000),
      })
      jid = job.jobId
    }
    let token = await tokenFor(c.context, jid)
    if (c.name === 'an expired or forged call token') token = 'forged.call.token'

    const proposed: string[] = []
    for (const g of c.fake?.given ?? []) {
      const r = await given(g, await tokenFor(c.context))
      expect(r.status, `given ${g.method}`).toBe(200)
      if (g.method === 'override.propose') proposed.push(r.body.changeSetId as string)
    }

    const body: Record<string, unknown> = structuredClone(c.request!.body)
    if (typeof body.changeSetId === 'string' && /^fake-cs-\d+$/.test(body.changeSetId)) {
      body.changeSetId = proposed[Number(body.changeSetId.slice('fake-cs-'.length)) - 1]
    }
    if (c.name === 'data.query with where, order and a cursor') {
      for (const key of ['f1', 'f3']) await given({ method: 'data.put', args: ['findings', key, { severity: 'high', fixed: false }], kwargs: {} }, token)
      const first = await post('data/query', { ...body, limit: 1, cursor: undefined }, token)
      body.cursor = first.body.next
    }
    if (c.name === 'data.query with a cursor from another query') {
      for (const key of ['a', 'b']) await given({ method: 'data.put', args: ['other', key, 1], kwargs: {} }, token)
      body.cursor = (await post('data/query', { collection: 'other', owner: 'user', limit: 1 }, token)).body.next
    }
    if (c.name === 'a token over its call budget') {
      for (let i = 0; i < 600; i++) expect((await post('data/get', body, token)).status).toBe(200)
    }

    const got = await post(c.request!.path, body, token)
    const want = c.response!
    expect(got.status).toBe(want.status)
    const wantBody = want.body ?? {}
    if (want.status >= 400) {
      expect(got.body.code).toBe(wantBody.code)
      // The one case whose message names a size the test had to shrink.
      if (!c.name.includes('over the size limit')) expect(got.body.error).toBe(wantBody.error)
      return
    }
    switch (c.request!.path.replace('/api/plugin-gateway/v1/', '')) {
      case 'session/read':
        expect(got.body.meta).toMatchObject(wantBody.meta as object)
        expect({ ...got.body, meta: undefined }).toEqual({ ...wantBody, meta: undefined })
        break
      case 'data/query': {
        const strip = (items: unknown) => (items as Record<string, unknown>[]).map(({ key, value, expiresAt, updatedAt }) => ({ key, value, expiresAt, at: typeof updatedAt }))
        expect(strip(got.body.items)).toEqual(strip(wantBody.items))
        expect(got.body.next === null || typeof got.body.next === 'string').toBe(true)
        break
      }
      case 'override/get':
        expect({ ...got.body, displayName: undefined }).toEqual({ ...wantBody, displayName: undefined })
        expect(typeof got.body.displayName).toBe('string')
        break
      case 'override/propose':
        expect({ ...got.body, changeSetId: undefined }).toEqual({ ...wantBody, changeSetId: undefined })
        expect(got.body.changeSetId).toMatch(/^[0-9a-f-]{36}$/)
        break
      default:
        expect(got.body).toEqual(wantBody)
    }
  })
})
