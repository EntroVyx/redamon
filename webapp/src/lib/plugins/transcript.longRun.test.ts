/**
 * Long and hostile sessions read for a plugin (TD-25, R-47; phase 04 review): what people
 * wrote survives however much the agent produced around it, a phase row is dropped when
 * only its iteration count changed, a value under a credential-named key is masked as
 * Python masks it in JSON text, and target-written output cannot stall the reader.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ findMany: null as unknown as (a: unknown) => Promise<unknown[]> }))
vi.mock('@/lib/prisma', () => ({ default: { chatMessage: { findMany: (a: unknown) => h.findMany(a) } } }))

import { readTranscript } from './transcript'

const BASE = Date.parse('2026-10-09T08:00:00.000Z')
type Row = { id: string; sequenceNum: number; createdAt: Date; type: string; data: unknown; conversationId: string }

/** A findMany over rows generated on demand, honouring the module's keyset cursor. */
function session(n: number, make: (i: number) => { type: string; data: unknown }) {
  const row = (i: number): Row => ({ id: `m${String(i).padStart(7, '0')}`, sequenceNum: i, createdAt: new Date(BASE + i), conversationId: 'c', ...make(i) })
  return async (a: unknown) => {
    const { where, take } = a as { where: { OR?: { sequenceNum?: { gt?: number } }[] }; take: number }
    const gt = where.OR?.find((w) => w.sequenceNum?.gt !== undefined)?.sequenceNum?.gt
    const start = gt === undefined ? 0 : gt + 1
    const out: Row[] = []
    for (let i = start; i < Math.min(n, start + take); i++) out.push(row(i))
    return out
  }
}

const conversation = {
  id: 'c',
  title: 'long run',
  status: 'active',
  currentPhase: 'exploitation',
  iterationCount: 0,
  createdAt: new Date(BASE),
  updatedAt: new Date(BASE),
}

const phase = (i: number, n: number) => {
  const p = ['informational', 'exploitation', 'post_exploitation'][Math.floor((3 * i) / n)]
  return { current_phase: p, iteration_count: Math.floor(i / 5), attack_path_type: p === 'informational' ? '' : 'sql_injection', skill_workflow: null }
}

beforeEach(() => vi.unstubAllEnvs())

describe('a 60,000-row run with the agent’s real phase rows', () => {
  const N = 60_000
  const make = (i: number) => {
    if (i === 0) return { type: 'user_message', data: { content: 'test the shop' } }
    if (i === N / 4 || i === N / 2 || i === (3 * N) / 4) return { type: 'guidance', data: { content: `guidance at ${i}` } }
    switch (i % 5) {
      case 0:
        return { type: 'thinking', data: { thought: `step ${i}` } }
      case 1:
        return { type: 'tool_start', data: { tool_name: 'execute_curl', tool_args: { url: `http://shop.example/${i}` } } }
      case 2:
        return { type: 'tool_complete', data: { tool_name: 'execute_curl', raw_output: `HTTP/1.1 200 OK ${i}`, success: true } }
      case 3:
        return { type: 'phase_update', data: phase(i, N) }
      default:
        return { type: 'thinking', data: { thought: `after ${i}` } }
    }
  }

  test('every guidance is kept, and so is some tool output; a phase row is kept only when the phase changed', { timeout: 60_000 }, async () => {
    h.findMany = session(N, make)
    const t = await readTranscript(conversation, { running: false })
    const guidance = t.events.filter((e) => e.type === 'guidance').map((e) => e.seq)
    expect(guidance).toEqual([N / 4, N / 2, (3 * N) / 4])
    expect(t.events.some((e) => e.type === 'tool_complete')).toBe(true)
    const phases = t.events.filter((e) => e.type === 'phase_update').map((e) => (e.data as { current_phase: string }).current_phase)
    expect(phases).toEqual(['informational', 'exploitation', 'post_exploitation'])
    // The first row of each phase, so its iteration count says where the phase began.
    expect((t.events.find((e) => e.type === 'phase_update')!.data as { iteration_count: number }).iteration_count).toBe(0)
  })
})

describe('what people wrote outlasts what the agent wrote', () => {
  test('100,000 rows of long deep_think: the operator’s messages, guidance and answers all stay', { timeout: 120_000 }, async () => {
    const N = 100_000
    const people: Record<number, { type: string; data: unknown }> = {
      0: { type: 'user_message', data: { content: 'first' } },
      33_333: { type: 'user_message', data: { content: 'middle' } },
      50_000: { type: 'guidance', data: { content: 'focus' } },
      66_666: { type: 'approval_response', data: { decision: 'approve' } },
      99_993: { type: 'answer_response', data: { answer: 'yes' } },
    }
    h.findMany = session(N, (i) => people[i] ?? (i % 5 === 0 ? { type: 'deep_think', data: { thought: `x${i} `.repeat(150) } } : { type: 'thinking', data: { thought: `t${i}` } }))
    const t = await readTranscript(conversation, { running: false })
    expect(Buffer.byteLength(JSON.stringify(t), 'utf8')).toBeLessThanOrEqual(2_097_152)
    expect(t.events.filter((e) => Number(e.seq) in people).map((e) => e.seq)).toEqual(Object.keys(people).map(Number).sort((a, b) => a - b))
  })
})

describe('values under credential-named keys', () => {
  test('are masked as Python masks them in JSON text; other keys are left alone', async () => {
    h.findMany = session(1, () => ({
      type: 'tool_start',
      data: {
        tool_name: 'execute_hydra',
        tool_args: {
          password: 'hunter2hunter2',
          client_secret: 'RyDhj2xR1SFuDIXFsaA',
          'X-Api-Key': 'abcdef0123456789',
          auth_method: 'password_spray',
          note: 'plain text',
          list: ['password=hunter2hunter2'],
        },
      },
    }))
    const t = await readTranscript(conversation, { running: false })
    expect(t.events[0].data).toEqual({
      tool_name: 'execute_hydra',
      tool_args: {
        password: 'hunt[REDACTED 14 chars]',
        client_secret: 'RyDh[REDACTED 19 chars]',
        'X-Api-Key': 'abcd[REDACTED 16 chars]',
        auth_method: 'password_spray',
        note: 'plain text',
        list: ['password=hunt[REDACTED 14 chars]'],
      },
    })
  })

  test('a key that is itself secret-shaped is masked too', async () => {
    h.findMany = session(1, () => ({ type: 'tool_complete', data: { AKIAIOSFODNN7EXAMPLE: 'found' } }))
    const t = await readTranscript(conversation, { running: false })
    expect(t.events[0].data).toEqual({ 'AKIA[REDACTED 20 chars]': 'found' })
  })
})

describe('target-written output', () => {
  test('fifty rows of a hostile keyword run are read in seconds, not hours', { timeout: 60_000 }, async () => {
    h.findMany = session(50, () => ({ type: 'tool_complete', data: { raw_output: 'password'.repeat(40_000) } }))
    const t0 = performance.now()
    const t = await readTranscript(conversation, { running: false })
    expect(performance.now() - t0).toBeLessThan(5_000)
    expect(t.events).toHaveLength(50)
  })
})
