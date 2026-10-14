/**
 * Reading a long session for a plugin (TD-25, R-47): rows come in pages of at most 500,
 * each event is masked then cut as it is read, superseded snapshots and repeated phase
 * rows are dropped, and the answer stays under PLUGIN_TRANSCRIPT_MAX_BYTES. The session
 * here is synthetic and generated page by page, so the test itself stays small.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ findMany: null as unknown as (a: unknown) => Promise<unknown[]> }))
vi.mock('@/lib/prisma', () => ({ default: { chatMessage: { findMany: (a: unknown) => h.findMany(a) } } }))

import { readTranscript, type Transcript } from './transcript'

const N = 20_000
const BASE = Date.parse('2026-10-09T08:00:00.000Z')
const SECRET_HEAD = 'Authorization: Bearer HEADSECRETabcdefghijklmnop'
const SECRET_CUT = 'api_key=CUTSECRETzyxwvutsrqponmlkjih'
const SECRET_TAIL = 'Cookie: session=TAILSECRET0123456789abcdef'
// 20,000 characters: one secret at the start, one across the 2,500th character, one at the end.
const RAW =
  SECRET_HEAD + ' ' + 'a'.repeat(2_490 - SECRET_HEAD.length - 1) + SECRET_CUT + ' ' +
  'b'.repeat(20_000 - 2_490 - SECRET_CUT.length - 1 - SECRET_TAIL.length - 1) + '\n' + SECRET_TAIL

function row(i: number) {
  const step = Math.floor(i / 4)
  let type: string
  let data: Record<string, unknown>
  if (i === 0) {
    type = 'user_message'
    data = { content: 'test example.com for SQL injection' }
  } else if (i === N - 1) {
    type = 'assistant_message'
    data = { content: 'Done. One finding.' }
  } else if (i === N / 2) {
    type = 'guidance'
    data = { content: 'focus on /login', isGuidance: true }
  } else if (i % 1000 === 5) {
    type = 'lats_tree_update'
    data = { tree: { nodes: step, label: `tree ${step}` } }
  } else if (i % 4 === 0) {
    type = 'tool_complete'
    data = { tool_name: 'execute_curl', success: true, raw_output: RAW, output_summary: `step ${step}` }
  } else if (i % 4 === 1) {
    type = 'todo_update'
    data = { todos: [{ content: `step ${step}`, status: 'in_progress' }] }
  } else if (i % 4 === 2) {
    type = 'phase_update'
    // The agent's payload: iteration_count changes on every row (websocket_api.py on_phase_update).
    data = {
      current_phase: i < N / 2 ? 'informational' : 'exploitation',
      iteration_count: step,
      attack_path_type: i < N / 2 ? '' : 'sql_injection',
      skill_workflow: i < N / 2 ? null : { skillId: 'sql_injection', revision: 1 },
    }
  } else {
    type = 'thinking'
    data = { thought: `thinking about step ${step}` }
  }
  return { id: `m${String(i).padStart(6, '0')}`, sequenceNum: i, createdAt: new Date(BASE + i), type, data, conversationId: 'conv-1' }
}

type Cursor = { sequenceNum: number; createdAt: Date; id: string }
const after = (r: ReturnType<typeof row>, c: Cursor) =>
  r.sequenceNum > c.sequenceNum ||
  (r.sequenceNum === c.sequenceNum &&
    (r.createdAt.getTime() > c.createdAt.getTime() || (r.createdAt.getTime() === c.createdAt.getTime() && r.id > c.id)))

/** Reads the keyset cursor out of the OR clause the module builds; any other shape fails. */
function cursorOf(where: Record<string, unknown>): Cursor | null {
  const or = where.OR as Record<string, unknown>[] | undefined
  if (!or) return null
  const strict = or.find((w) => (w.sequenceNum as { gt?: number })?.gt !== undefined)!
  const tie = or.find((w) => (w.id as { gt?: string })?.gt !== undefined)!
  return {
    sequenceNum: (strict.sequenceNum as { gt: number }).gt,
    createdAt: tie.createdAt as Date,
    id: (tie.id as { gt: string }).gt,
  }
}

let takes: number[] = []

async function syntheticFindMany(a: unknown) {
  const args = a as { where: Record<string, unknown>; orderBy: unknown; take: number }
  takes.push(args.take)
  expect(args.where.conversationId).toBe('conv-1')
  expect(args.orderBy).toEqual([{ sequenceNum: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }])
  const c = cursorOf(args.where)
  // The OR alone gives the (conversationId, sequenceNum) index no lower bound: each page
  // would rescan the session from its first row.
  expect(args.where.sequenceNum).toEqual(c ? { gte: c.sequenceNum } : undefined)
  let start = 0
  if (c) while (start < N && !after(row(start), c)) start++
  const out = []
  for (let i = start; i < Math.min(N, start + args.take); i++) out.push(row(i))
  return out
}

beforeEach(() => {
  takes = []
  h.findMany = syntheticFindMany
})
afterEach(() => vi.unstubAllEnvs())

const conversation = {
  id: 'conv-1',
  sessionId: 'session-1',
  projectId: 'project-1',
  userId: 'user-1',
  title: 'Recon of example.com password=hunter2hunter2',
  status: 'active',
  currentPhase: 'exploitation',
  iterationCount: 42,
  agentRunning: false,
  createdAt: new Date(BASE),
  updatedAt: new Date(BASE + N),
}

const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out))
  return out
}

describe('a 20,000-event session', () => {
  let t: Transcript
  let pages: number[]
  // Read once: each read masks 5,000 outputs of 20,000 characters.
  beforeAll(async () => {
    takes = []
    // ~2 s alone; more when the suite runs files in parallel.
    h.findMany = syntheticFindMany
    t = await readTranscript(conversation, { running: false })
    pages = [...takes]
  }, 30_000)

  test('is read in pages of at most 500 rows, once', () => {
    expect(Math.max(...pages)).toBeLessThanOrEqual(500)
    expect(pages.length).toBe(N / 500 + 1)
  })

  test('the answer stays under the default 2 MB cap and says what it dropped', () => {
    expect(Buffer.byteLength(JSON.stringify(t), 'utf8')).toBeLessThanOrEqual(2_097_152)
    expect(t.truncated.keptEvents).toBe(t.events.length)
    expect(t.truncated.keptEvents + t.truncated.droppedEvents).toBe(N)
    expect(t.truncated.droppedEvents).toBeGreaterThan(0)
    expect(t.untrusted).toBe(true)
  })

  test('every long string is cut to its head and tail, after masking', () => {
    const all = strings(t.events)
    expect(Math.max(...all.map((s) => s.length))).toBeLessThan(4_000)
    const raw = t.events.find((e) => e.type === 'tool_complete')!.data as { raw_output: string }
    expect(raw.raw_output).toMatch(/characters cut/)
    expect(raw.raw_output.startsWith('Authorization: Bearer HEAD[REDACTED')).toBe(true)
    expect(raw.raw_output).toContain('Cookie: session=TAIL[REDACTED')
    const text = JSON.stringify(t)
    for (const s of ['HEADSECRETabcdef', 'CUTSECRETzyx', 'TAILSECRET01', 'zyxwvutsrqponmlkjih', 'hunter2hunter2']) {
      expect(text).not.toContain(s)
    }
  })

  test('only the last todo_update and lats_tree_update survive', () => {
    const todos = t.events.filter((e) => e.type === 'todo_update')
    const trees = t.events.filter((e) => e.type === 'lats_tree_update')
    expect(todos.map((e) => e.seq)).toEqual([N - 3])
    expect(trees.map((e) => e.seq)).toEqual([19_005])
  })

  test('repeated phase_update rows are dropped, changes kept', () => {
    const phases = t.events.filter((e) => e.type === 'phase_update').map((e) => (e.data as { current_phase: string }).current_phase)
    expect(phases).toEqual(['informational', 'exploitation'])
  })

  test('the conversation and the operator’s messages are always kept, in order', () => {
    const types = t.events.map((e) => e.type)
    expect(types[0]).toBe('user_message')
    expect(types.at(-1)).toBe('assistant_message')
    expect(types).toContain('guidance')
    const seqs = t.events.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(t.events[0]).toEqual({
      seq: 0,
      type: 'user_message',
      at: '2026-10-09T08:00:00.000Z',
      data: { content: 'test example.com for SQL injection' },
    })
  })

  test('meta: the conversation, masked, with the highest sequence read', () => {
    expect(t.meta).toEqual({
      id: 'conv-1',
      title: 'Recon of example.com password=hunt[REDACTED 14 chars]',
      status: 'active',
      currentPhase: 'exploitation',
      iterationCount: 42,
      createdAt: '2026-10-09T08:00:00.000Z',
      updatedAt: '2026-10-09T08:00:20.000Z',
      running: false,
      highWaterSeq: N - 1,
    })
  })
})

describe('the cap', () => {
  test('a small cap keeps the priority events, then the first and the last of the rest', { timeout: 30_000 }, async () => {
    vi.stubEnv('PLUGIN_TRANSCRIPT_MAX_BYTES', '200000')
    const t = await readTranscript(conversation, { running: 'unverified' })
    expect(Buffer.byteLength(JSON.stringify(t), 'utf8')).toBeLessThanOrEqual(200_000)
    const types = t.events.map((e) => e.type)
    for (const kept of ['user_message', 'guidance', 'assistant_message', 'todo_update', 'lats_tree_update']) {
      expect(types).toContain(kept)
    }
    expect(t.events.filter((e) => e.type === 'phase_update')).toHaveLength(2)
    const others = t.events.filter((e) => ['tool_complete', 'thinking'].includes(e.type)).map((e) => e.seq)
    expect(others[0]).toBeLessThan(100)
    expect(others.at(-1)).toBeGreaterThan(N - 100)
    expect(others.some((s) => s > 8_000 && s < 12_000)).toBe(false)
    expect(t.meta.running).toBe('unverified')
  })

  test('an event with a huge structure is cut as a whole', async () => {
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`f${i}`, 'x'.repeat(3_000)]))
    h.findMany = async (a: unknown) => {
      const args = a as { where: Record<string, unknown> }
      return args.where.OR ? [] : [{ id: 'm1', sequenceNum: 0, createdAt: new Date(BASE), type: 'tool_complete', data: wide }]
    }
    const t = await readTranscript(conversation, { running: false })
    const size = Buffer.byteLength(JSON.stringify(t.events[0]), 'utf8')
    expect(size).toBeLessThanOrEqual(70_000)
    expect(t.events[0].data).toMatchObject({ truncated: true })
  })
})
