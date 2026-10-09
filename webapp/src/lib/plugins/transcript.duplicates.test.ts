/**
 * `chat_messages.sequenceNum` is assigned max+1 outside a transaction with no unique
 * constraint, so duplicates exist (RV-13, R-62). Paging must use the compound order
 * (sequenceNum, createdAt, id): a `sequenceNum > last` cursor would skip every row that
 * shares the last sequence number of a page.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { readTranscript } from './transcript'

let db: FakePrisma
const T = (ms: number) => new Date(Date.parse('2026-10-09T10:00:00.000Z') + ms)

const conversation = {
  id: 'conv-1',
  sessionId: 'session-1',
  projectId: 'project-1',
  userId: 'user-1',
  title: '',
  status: 'active',
  currentPhase: 'informational',
  iterationCount: 0,
  agentRunning: false,
  createdAt: T(0),
  updatedAt: T(0),
}

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
})

function seed(rows: [id: string, seq: number, ms: number][]) {
  db.seed(
    'chatMessage',
    rows.map(([id, seq, ms]) => ({ id, conversationId: 'conv-1', sequenceNum: seq, createdAt: T(ms), type: 'thinking', data: { id } })),
  )
}

describe('duplicate sequence numbers', () => {
  test('rows sharing a sequence number across page boundaries all come back once, in order', async () => {
    // Inserted out of order; three rows share seq 1 (two in the same millisecond), two share 2.
    seed([
      ['m-f', 3, 9],
      ['m-c', 1, 5],
      ['m-b', 1, 5],
      ['m-a', 0, 1],
      ['m-d', 1, 6],
      ['m-e', 2, 7],
      ['m-g', 2, 7],
    ])
    db.seed('chatMessage', [{ id: 'other', conversationId: 'conv-2', sequenceNum: 1, createdAt: T(5), type: 'thinking', data: {} }])
    for (const pageRows of [1, 2, 3, 500]) {
      const t = await readTranscript(conversation, { running: false, pageRows })
      expect(t.events.map((e) => (e.data as { id: string }).id), `pageRows=${pageRows}`).toEqual([
        'm-a',
        'm-b',
        'm-c',
        'm-d',
        'm-e',
        'm-g',
        'm-f',
      ])
      expect(t.truncated).toEqual({ keptEvents: 7, droppedEvents: 0 })
      expect(t.meta.highWaterSeq).toBe(3)
    }
  })

  test('a page size over 500 is clamped', async () => {
    seed([['m-a', 0, 1]])
    const spy = vi.spyOn(db.chatMessage, 'findMany')
    await readTranscript(conversation, { running: false, pageRows: 10_000 })
    expect(Math.max(...spy.mock.calls.map((c) => (c[0] as { take: number }).take))).toBe(500)
  })

  test('an empty session has no high-water sequence', async () => {
    const t = await readTranscript(conversation, { running: false })
    expect(t.events).toEqual([])
    expect(t.meta.highWaterSeq).toBeNull()
    expect(t.truncated).toEqual({ keptEvents: 0, droppedEvents: 0 })
  })
})
