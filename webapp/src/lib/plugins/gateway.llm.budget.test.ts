/**
 * The plugin LLM budget at the Gateway (TD-09, D-47, R-69): a call is charged against the
 * plugin's own daily cap for the effective user BEFORE it is made, so a call that fails
 * or times out still counts; after a call the tokens and the model are added to the same
 * row (usage attributed to the plugin). The agent's shared per-user cap is not involved.
 *
 * @vitest-environment node
 */
import { test, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  db: null as unknown as Record<string, unknown>,
  agent: null as unknown as () => Promise<Response>,
  events: [] as string[],
  counts: new Map<string, number>(),
  usage: [] as unknown[][],
  cap: 3,
}))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/agentFetch', () => {
  class AgentUnreachableError extends Error {
    cause_: unknown
    constructor(cause: unknown) {
      super('agent down')
      this.cause_ = cause
    }
  }
  return {
    AgentUnreachableError,
    agentFetch: async () => {
      h.events.push('agent')
      return h.agent()
    },
  }
})
// The module's SQL runs on real Postgres elsewhere; here, its contract: refuse at the cap.
vi.mock('./llmBudget', () => ({
  chargeLlmCall: vi.fn(async (pluginId: string, userId: string) => {
    h.events.push('charge')
    const key = `${pluginId}:${userId}`
    const n = h.counts.get(key) ?? 0
    if (n >= h.cap) return { allowed: false, count: null, cap: h.cap, key: 'llm:2026-10-09' }
    h.counts.set(key, n + 1)
    return { allowed: true, count: n + 1, cap: h.cap, key: 'llm:2026-10-09' }
  }),
  recordLlmUsage: vi.fn(async (...a: unknown[]) => {
    h.events.push('record')
    h.usage.push(a)
  }),
}))

import { AgentUnreachableError } from '@/lib/agentFetch'
import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { ALICE, BOB, CALL_SECRET, answer, echoInstall, echoManifest, gatewayRequest, seedWorld, token, type TokenInput } from './__testing__/gatewayHarness'
import { POST as llmInvoke } from '@/app/api/plugin-gateway/v1/llm/invoke/route'

let db: FakePrisma
const MODEL = 'openai/gpt-test'

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  seedWorld(db)
  db.seed('pluginInstall', [echoInstall({ pluginId: 'other', manifest: echoManifest({ id: 'other' }) })])
  db.seed('userSettings', [
    { userId: ALICE, featureModels: { 'plugin:echo': MODEL, 'plugin:other': MODEL } },
    { userId: BOB, featureModels: { 'plugin:echo': MODEL } },
  ])
  h.events = []
  h.counts = new Map()
  h.usage = []
  h.cap = 3
  h.agent = async () => Response.json({ content: 'ok', model_used: MODEL, usage: { input_tokens: 10, output_tokens: 4, estimated: false } })
  vi.stubEnv('PLUGIN_CALL_TOKEN_SECRET', CALL_SECRET)
  vi.stubEnv('AUTH_SECRET', 'a'.repeat(64))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const hello = { messages: [{ role: 'user', content: 'Hello' }] }
const invoke = async (over: TokenInput = {}) => answer(await llmInvoke(gatewayRequest('llm/invoke', hello, { token: await token(over) })))
const BOB_TOKEN: TokenInput = { sub: BOB, prj: 'project-bob', ses: 'session-bob', conv: 'conv-bob' }

test('charged before the call; tokens and model recorded after it', async () => {
  expect((await invoke()).status).toBe(200)
  expect(h.events).toEqual(['charge', 'agent', 'record'])
  expect(h.usage).toEqual([['echo', ALICE, 'llm:2026-10-09', { inputTokens: 10, outputTokens: 4, model: MODEL }]])
})

test('the cap reached: 429 plugin_llm_cap with the contract body, the agent never called', async () => {
  for (let i = 0; i < 3; i++) expect((await invoke()).status).toBe(200)
  h.events = []
  expect(await invoke()).toEqual({ status: 429, body: { error: 'This plugin reached its daily model-call limit.', code: 'plugin_llm_cap' } })
  expect(h.events).toEqual(['charge'])
})

test('a call that times out still counts, and records no usage', async () => {
  h.agent = async () => {
    throw new AgentUnreachableError(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))
  }
  expect((await invoke()).status).toBe(504)
  expect(h.counts.get(`echo:${ALICE}`)).toBe(1)
  expect(h.usage).toEqual([])
})

test('a refused model still counts: the charge comes first', async () => {
  h.agent = async () => Response.json({ error: 'x', code: 'model_unavailable', model_used: MODEL }, { status: 503 })
  for (let i = 0; i < 3; i++) await invoke()
  h.agent = async () => Response.json({ content: 'ok', model_used: MODEL, usage: { input_tokens: 1, output_tokens: 1, estimated: false } })
  expect((await invoke()).body.code).toBe('plugin_llm_cap')
})

test('estimated usage is recorded as given', async () => {
  h.agent = async () => Response.json({ content: 'ok', model_used: MODEL, usage: { input_tokens: 7, output_tokens: 2, estimated: true } })
  await invoke()
  expect(h.usage[0][3]).toEqual({ inputTokens: 7, outputTokens: 2, model: MODEL })
})

test('the budget is per plugin and per effective user', async () => {
  for (let i = 0; i < 3; i++) await invoke()
  expect((await invoke()).status).toBe(429)
  expect((await invoke(BOB_TOKEN)).status).toBe(200)
  expect((await invoke({ pluginId: 'other' })).status).toBe(200)
  // An admin acting as Alice spends Alice's budget, not the admin's.
  expect((await invoke({ act: 'user-admin' })).status).toBe(429)
})

// Phase 04 review: the call was made and charged; failing to record its tokens must not
// lose the answer the plugin paid for.
test('the usage cannot be recorded: the answer still reaches the plugin', async () => {
  const { recordLlmUsage } = await import('./llmBudget')
  vi.mocked(recordLlmUsage).mockRejectedValueOnce(new Error('bigint out of range'))
  expect(await invoke()).toMatchObject({ status: 200, body: { content: 'ok', model_used: MODEL } })
})

test('the agent refusing for a weak master key: its own code, not agent_outdated', async () => {
  h.agent = async () =>
    Response.json({ error: 'INTERNAL_API_KEY is not configured', code: 'agent_not_configured', model_used: MODEL }, { status: 503 })
  expect(await invoke()).toMatchObject({ status: 503, body: { code: 'agent_not_configured' } })
})
