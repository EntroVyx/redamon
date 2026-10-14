/**
 * POST /api/plugin-gateway/v1/llm/invoke (`sdk.llm.invoke`, D-13, D-43, TD-09): the model
 * the user chose for THIS plugin in Models by feature, called through the agent with the
 * master key, so no provider key ever reaches the runner or the plugin. The request can
 * name messages and two options, never a model.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  db: null as unknown as Record<string, unknown>,
  agent: null as unknown as (path: string, init?: RequestInit) => Promise<Response>,
  agentCalls: [] as { path: string; body: Record<string, unknown>; timeoutMs?: number }[],
  charges: [] as string[],
  usage: [] as unknown[],
  allow: true,
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
    agentFetch: (path: string, init?: RequestInit, opts?: { timeoutMs?: number }) => {
      h.agentCalls.push({ path, body: JSON.parse(String(init?.body)), timeoutMs: opts?.timeoutMs })
      return h.agent(path, init)
    },
  }
})
vi.mock('./llmBudget', () => ({
  chargeLlmCall: vi.fn(async (pluginId: string, userId: string) => {
    h.charges.push(`${pluginId}:${userId}`)
    return h.allow ? { allowed: true, count: h.charges.length, cap: 100, key: 'llm:2026-10-09' } : { allowed: false, count: null, cap: 100, key: 'llm:2026-10-09' }
  }),
  recordLlmUsage: vi.fn(async (...a: unknown[]) => void h.usage.push(a)),
}))

import { AgentUnreachableError } from '@/lib/agentFetch'
import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { ALICE, CALL_SECRET, answer, echoInstall, gatewayRequest, seedWorld, token, type TokenInput } from './__testing__/gatewayHarness'
import { POST as llmInvoke } from '@/app/api/plugin-gateway/v1/llm/invoke/route'

let db: FakePrisma
const MODEL = 'openai/gpt-test'
const OK = { content: 'Hi there.', model_used: MODEL, usage: { input_tokens: 12, output_tokens: 3, estimated: false } }

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  seedWorld(db)
  db.seed('userSettings', [{ userId: ALICE, featureModels: { 'plugin:echo': MODEL, triage: 'anthropic/other' } }])
  h.agentCalls = []
  h.charges = []
  h.usage = []
  h.allow = true
  h.agent = async () => Response.json(OK)
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

const invoke = async (body: Record<string, unknown>, over: TokenInput = {}) =>
  answer(await llmInvoke(gatewayRequest('llm/invoke', body, { token: await token(over) })))
const hello = { messages: [{ role: 'user', content: 'Hello' }] }

describe('a call', () => {
  test('the contract answer; the agent gets the user, the plugin and the user’s model', async () => {
    expect(await invoke(hello)).toEqual({ status: 200, body: OK })
    expect(h.agentCalls).toEqual([
      {
        path: '/plugins/llm/invoke',
        body: { user_id: ALICE, plugin_id: 'echo', model: MODEL, messages: [{ role: 'user', content: 'Hello' }] },
        timeoutMs: 300_000,
      },
    ])
  })

  test('max_tokens and temperature pass through', async () => {
    await invoke({ messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello' }], max_tokens: 200, temperature: 0.2 })
    expect(h.agentCalls[0].body).toMatchObject({ max_tokens: 200, temperature: 0.2 })
  })

  test('a model named in the request is ignored: the user chose it', async () => {
    await invoke({ ...hello, model: 'anthropic/expensive', user_id: 'user-bob', plugin_id: 'other' })
    expect(h.agentCalls[0].body).toMatchObject({ model: MODEL, user_id: ALICE, plugin_id: 'echo' })
  })

  test('an admin acting as the user spends the user’s model, as the user', async () => {
    await invoke(hello, { act: 'user-admin' })
    expect(h.agentCalls[0].body).toMatchObject({ user_id: ALICE, model: MODEL })
    expect(h.charges).toEqual([`echo:${ALICE}`])
  })

  test('one [plugins] llm line per call, without the prompt', async () => {
    const log = vi.mocked(console.log)
    await invoke({ messages: [{ role: 'user', content: 'secret prompt text' }] })
    const lines = log.mock.calls.map((c) => c.join(' '))
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^\\[plugins\\] llm plugin=echo user=${ALICE} model=openai/gpt-test in=12 out=3 ms=\\d+$`)))
    expect(lines.join('\n')).not.toContain('secret prompt text')
  })
})

describe('refusals', () => {
  test('no model chosen for the plugin: 409 model_required with the contract message and the feature id', async () => {
    await db.userSettings.update({ where: { userId: ALICE }, data: { featureModels: { triage: 'x' } } })
    expect(await invoke(hello)).toEqual({
      status: 409,
      body: { error: 'Choose a model for this plugin in Models by feature.', code: 'model_required', featureId: 'plugin:echo' },
    })
    expect(h.charges).toEqual([])
    expect(h.agentCalls).toEqual([])
  })

  test('no settings row at all: 409 model_required', async () => {
    await db.userSettings.deleteMany({})
    expect((await invoke(hello)).body.code).toBe('model_required')
  })

  test('without llm:invoke granted: 403', async () => {
    db = createFakePrisma()
    h.db = db as unknown as Record<string, unknown>
    seedWorld(db, { install: echoInstall({ grantedPermissions: ['session:read'] }) })
    expect((await invoke(hello)).status).toBe(403)
  })

  test.each<[string, Record<string, unknown>, number, string]>([
    ['no messages', { messages: [] }, 422, 'invalid_messages'],
    ['messages that are not a list', { messages: 'Hello' }, 422, 'invalid_messages'],
    ['a role the agent does not take', { messages: [{ role: 'tool', content: 'x' }] }, 422, 'invalid_messages'],
    ['content that is not text', { messages: [{ role: 'user', content: { a: 1 } }] }, 422, 'invalid_messages'],
    ['51 messages', { messages: Array.from({ length: 51 }, () => ({ role: 'user', content: 'x' })) }, 413, 'too_many_messages'],
    ['over 1,000,000 characters', { messages: [{ role: 'user', content: 'x'.repeat(1_000_001) }] }, 413, 'messages_too_large'],
    ['max_tokens 16,001', { ...hello, max_tokens: 16_001 }, 422, 'invalid_options'],
    ['max_tokens 0', { ...hello, max_tokens: 0 }, 422, 'invalid_options'],
    ['temperature 3', { ...hello, temperature: 3 }, 422, 'invalid_options'],
    ['temperature as text', { ...hello, temperature: '0.2' }, 422, 'invalid_options'],
  ])('%s: %s, nothing charged or sent', async (_n, body, status, code) => {
    const r = await invoke(body)
    expect(r.status).toBe(status)
    expect(r.body.code).toBe(code)
    expect(h.charges).toEqual([])
    expect(h.agentCalls).toEqual([])
  })
})

describe('what the agent answers', () => {
  test('agent 401: 502, as callFeatureAgent answers it, with a code', async () => {
    h.agent = async () => Response.json({ detail: 'Unauthorized' }, { status: 401 })
    const r = await invoke(hello)
    expect(r.status).toBe(502)
    expect(typeof r.body.code).toBe('string')
    expect(typeof r.body.error).toBe('string')
  })

  test('an answer without model_used (an older agent): 502 agent_outdated', async () => {
    h.agent = async () => Response.json({ content: 'Hi' })
    expect(await invoke(hello)).toMatchObject({ status: 502, body: { code: 'agent_outdated' } })
  })

  test('the endpoint missing (404): agent_outdated', async () => {
    h.agent = async () => Response.json({ detail: 'Not Found' }, { status: 404 })
    expect(await invoke(hello)).toMatchObject({ status: 502, body: { code: 'agent_outdated' } })
  })

  test.each([
    ['model_unavailable', 503],
    ['providers_unreachable', 503],
  ])('%s passes through', async (code, status) => {
    h.agent = async () => Response.json({ error: 'provider said no', code, model_used: MODEL }, { status })
    const r = await invoke(hello)
    expect(r).toMatchObject({ status, body: { code } })
    expect(String(r.body.error)).not.toContain('provider said no')
  })

  test('agent unreachable: 503 agent_unreachable; agent timeout: 504 agent_timeout', async () => {
    h.agent = async () => {
      throw new AgentUnreachableError(new Error('ECONNREFUSED'))
    }
    expect(await invoke(hello)).toMatchObject({ status: 503, body: { code: 'agent_unreachable' } })
    h.agent = async () => {
      throw new AgentUnreachableError(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))
    }
    expect(await invoke(hello)).toMatchObject({ status: 504, body: { code: 'agent_timeout' } })
  })

  test('a failed model call: 502 with a code', async () => {
    h.agent = async () => Response.json({ error: 'The model call failed. Try again in a moment.', model_used: MODEL }, { status: 502 })
    expect(await invoke(hello)).toMatchObject({ status: 502, body: { code: 'llm_call_failed' } })
  })
})
