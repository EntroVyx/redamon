/**
 * Unit tests for the LATS chat-state reducer.
 *
 * Run: npx vitest run --no-file-parallelism \
 *   src/app/graph/components/AIAssistantDrawer/hooks/latsChatState.test.ts
 *
 * Covers: start seeds one card keyed by search_id; update replaces latest +
 * pushes history; complete marks status + pins the best line; an orphan update
 * seeds a card instead of dropping; an orphan complete is a no-op.
 */

import { describe, test, expect } from 'vitest'
import { handleLatsStart, handleLatsUpdate, handleLatsComplete, findLatsIndex, buildLatsCardFromEvents, foldLatsRestoreMarkers } from './latsChatState'
import type { ChatItem, LatsSearchItem } from '../types'
import type {
  LatsStartPayload,
  LatsTreeUpdatePayload,
  LatsCompletePayload,
  LatsTreeSnapshot,
  LatsNodeView,
} from '@/lib/websocket-types'

function node(over: Partial<LatsNodeView>): LatsNodeView {
  return {
    id: 'n', parent_id: null, depth: 0, label: 'n', tool_name: null,
    status: 'evaluated', value: 0, local_value: 0, visits: 0, verdict: '',
    error_class: '', response_class: '', finding_confidence: 0, exploit_succeeded: false,
    duration_ms: 0, observation: '', reflection: '', is_dangerous: false,
    step_id: null, ...over,
  }
}

function snapshot(over: Partial<LatsTreeSnapshot> = {}): LatsTreeSnapshot {
  return {
    search_id: 's1:root', objective: 'admin takeover', phase: 'exploitation',
    shadow_mode: true, rollouts: 1, budget: { max_rollouts: 24, max_depth: 6 },
    active_id: 'root', best_trajectory: ['root', 'c3'],
    nodes: [
      node({ id: 'root', label: 'root', value: 0.8 }),
      node({ id: 'c3', parent_id: 'root', depth: 1, label: 'forgot-password', value: 0.8 }),
    ],
    ...over,
  }
}

const START: LatsStartPayload = {
  search_id: 's1:root', objective: 'admin takeover', phase: 'exploitation',
  budget: { max_rollouts: 24, max_depth: 6 }, shadow_mode: true,
}

describe('handleLatsStart', () => {
  test('seeds a single running card keyed by search_id', () => {
    const items = handleLatsStart([], START)
    expect(items).toHaveLength(1)
    const card = items[0] as LatsSearchItem
    expect(card.type).toBe('lats_search')
    expect(card.search_id).toBe('s1:root')
    expect(card.status).toBe('running')
    expect(card.shadow_mode).toBe(true)
    expect(findLatsIndex(items, 's1:root')).toBe(0)
  })

  test('a duplicate start refreshes in place, not a second card', () => {
    const once = handleLatsStart([], START)
    const twice = handleLatsStart(once, START)
    expect(twice.filter(i => i.type === 'lats_search')).toHaveLength(1)
  })
})

describe('handleLatsUpdate', () => {
  test('replaces latest and pushes history', () => {
    const started = handleLatsStart([], START)
    const p: LatsTreeUpdatePayload = { search_id: 's1:root', snapshot: snapshot() }
    const items = handleLatsUpdate(started, p)
    const card = items[0] as LatsSearchItem
    expect(card.latest.nodes).toHaveLength(2)
    expect(card.history).toHaveLength(1)
    // a second update grows history
    const items2 = handleLatsUpdate(items, { search_id: 's1:root', snapshot: snapshot({ rollouts: 2 }) })
    expect((items2[0] as LatsSearchItem).history).toHaveLength(2)
    expect((items2[0] as LatsSearchItem).latest.rollouts).toBe(2)
  })

  test('reflects prune/terminal statuses from the snapshot', () => {
    const started = handleLatsStart([], START)
    const snap = snapshot({
      nodes: [
        node({ id: 'root', label: 'root' }),
        node({ id: 'c1', parent_id: 'root', depth: 1, status: 'pruned', reflection: 'WAF' }),
        node({ id: 'c3', parent_id: 'root', depth: 1, status: 'terminal', exploit_succeeded: true }),
      ],
    })
    const items = handleLatsUpdate(started, { search_id: 's1:root', snapshot: snap })
    const statuses = (items[0] as LatsSearchItem).latest.nodes.map(n => n.status)
    expect(statuses).toContain('pruned')
    expect(statuses).toContain('terminal')
  })

  test('orphan update (no prior start) seeds a card', () => {
    const items = handleLatsUpdate([], { search_id: 's1:root', snapshot: snapshot() })
    expect(items).toHaveLength(1)
    expect((items[0] as LatsSearchItem).history).toHaveLength(1)
  })

  test('returns a new array (immutability)', () => {
    const started = handleLatsStart([], START)
    const items = handleLatsUpdate(started, { search_id: 's1:root', snapshot: snapshot() })
    expect(items).not.toBe(started)
  })
})

describe('handleLatsComplete', () => {
  test('marks complete and pins the final best line on latest AND last frame (S3)', () => {
    const started = handleLatsStart([], START)
    // last replay frame has a STALE best line...
    const updated = handleLatsUpdate(started, { search_id: 's1:root', snapshot: snapshot({ best_trajectory: ['root'] }) })
    const p: LatsCompletePayload = {
      search_id: 's1:root', best_trajectory: ['root', 'c3'],
      outcome: 'terminal_success', metrics: { rollouts: 3 },
    }
    const items = handleLatsComplete(updated, p)
    const card = items[0] as LatsSearchItem
    expect(card.status).toBe('complete')
    expect(card.outcome).toBe('terminal_success')
    expect(card.latest.best_trajectory).toEqual(['root', 'c3'])
    // ...and the last history frame is updated so the panel's latest frame matches
    expect(card.history[card.history.length - 1].best_trajectory).toEqual(['root', 'c3'])
  })

  test('orphan complete is a no-op', () => {
    const items: ChatItem[] = []
    expect(handleLatsComplete(items, {
      search_id: 'nope', best_trajectory: [], outcome: 'x',
    })).toBe(items)
  })
})

describe('buildLatsCardFromEvents (restore)', () => {
  test('replays a persisted event sequence into one card with rebuilt history', () => {
    const events = [
      { _latsEvent: 'lats_start' as const, payload: START },
      { _latsEvent: 'lats_tree_update' as const, payload: { search_id: 's1:root', snapshot: snapshot({ rollouts: 1 }) } },
      { _latsEvent: 'lats_tree_update' as const, payload: { search_id: 's1:root', snapshot: snapshot({ rollouts: 2 }) } },
      { _latsEvent: 'lats_complete' as const, payload: { search_id: 's1:root', best_trajectory: ['root', 'c3'], outcome: 'terminal_success' } },
    ]
    const card = buildLatsCardFromEvents(events)
    expect(card).not.toBeNull()
    expect(card!.search_id).toBe('s1:root')
    expect(card!.status).toBe('complete')
    expect(card!.outcome).toBe('terminal_success')
    expect(card!.history).toHaveLength(2)              // one per tree_update
    expect(card!.latest.best_trajectory).toEqual(['root', 'c3'])
  })

  test('an empty sequence yields null', () => {
    expect(buildLatsCardFromEvents([])).toBeNull()
  })
})

describe('foldLatsRestoreMarkers (restore post-pass)', () => {
  const marker = (kind: 'lats_start' | 'lats_tree_update' | 'lats_complete', payload: any, ts: Date) =>
    ({ _latsEvent: kind, payload, timestamp: ts } as any)

  test('folds one card per search_id at the first-event position + timestamp (C1)', () => {
    const t0 = new Date('2020-01-01T00:00:00Z')
    const t1 = new Date('2020-01-01T00:00:05Z')
    const older = { type: 'message', id: 'm0', role: 'assistant', content: 'before', timestamp: new Date('2019-01-01') } as any
    const newer = { type: 'message', id: 'm1', role: 'assistant', content: 'after', timestamp: new Date('2021-01-01') } as any
    const items = [
      older,
      marker('lats_start', START, t0),
      marker('lats_tree_update', { search_id: 's1:root', snapshot: snapshot() }, t1),
      newer,
    ]
    const out = foldLatsRestoreMarkers(items)
    // one card replaces the two markers; messages preserved around it
    expect(out).toHaveLength(3)
    const card = out.find(i => i.type === 'lats_search') as LatsSearchItem
    expect(card).toBeTruthy()
    // C1: stamped with the first event's persisted time, NOT now
    expect(card.timestamp).toEqual(t0)
    // placed between the two messages (index 1)
    expect(out[0]).toBe(older)
    expect(out[1]).toBe(card)
    expect(out[2]).toBe(newer)
  })

  test('handles two distinct searches as two cards', () => {
    const items = [
      marker('lats_start', START, new Date('2020-01-01')),
      marker('lats_start', { ...START, search_id: 's2:root' }, new Date('2020-01-02')),
      marker('lats_tree_update', { search_id: 's2:root', snapshot: { ...snapshot(), search_id: 's2:root' } }, new Date('2020-01-02')),
    ]
    const cards = foldLatsRestoreMarkers(items).filter(i => i.type === 'lats_search') as LatsSearchItem[]
    expect(cards.map(c => c.search_id).sort()).toEqual(['s1:root', 's2:root'])
  })

  test('passes through when there are no LATS markers', () => {
    const items = [{ type: 'message', id: 'm', role: 'user', content: 'hi', timestamp: new Date() } as any]
    expect(foldLatsRestoreMarkers(items)).toBe(items)
  })

  // Regression: the restore post-pass rewrote `restored` in place via
  //   const folded = foldLatsRestoreMarkers(restored)
  //   restored.length = 0; restored.push(...folded)
  // For a non-LATS conversation `folded` IS `restored` (same reference, see the
  // pass-through test above), so `restored.length = 0` also emptied `folded` and
  // the whole chat came back blank when reopening any session from history.
  describe('restore post-pass rewrite must not self-wipe (aliasing guard)', () => {
    const foldedRewrite = (restored: any[]) => {
      // Mirrors the guarded logic in useConversationRestoration.
      const folded = foldLatsRestoreMarkers(restored)
      if (folded !== restored) {
        restored.length = 0
        restored.push(...folded)
      }
      return restored
    }

    test('non-LATS timeline survives the rewrite', () => {
      const restored = [
        { type: 'message', id: 'm0', role: 'user', content: 'objective', timestamp: new Date() } as any,
        { type: 'thinking', id: 't0', thought: 'step', reasoning: '', action: 'thinking', updated_todo_list: [], timestamp: new Date() } as any,
        { type: 'tool_execution', id: 'x0', tool_name: 'nmap', tool_args: {}, status: 'success', output_chunks: [], timestamp: new Date() } as any,
      ]
      const out = foldedRewrite(restored)
      expect(out).toHaveLength(3)
      expect(out.map((i: any) => i.type)).toEqual(['message', 'thinking', 'tool_execution'])
    })

    test('the UNGUARDED rewrite would have emptied it (documents the bug)', () => {
      const restored = [{ type: 'message', id: 'm', role: 'user', content: 'hi', timestamp: new Date() } as any]
      const folded = foldLatsRestoreMarkers(restored)   // === restored
      restored.length = 0
      restored.push(...folded)                          // pushes nothing
      expect(restored).toHaveLength(0)                  // the blank-chat bug
    })

    test('LATS timeline still folds normally through the rewrite', () => {
      const restored = [
        { type: 'message', id: 'm0', role: 'user', content: 'go', timestamp: new Date() } as any,
        marker('lats_start', START, new Date('2020-01-01')),
        marker('lats_tree_update', { search_id: 's1:root', snapshot: snapshot() }, new Date('2020-01-01T00:00:05Z')),
      ]
      const out = foldedRewrite(restored)
      expect(out).toHaveLength(2) // message + one folded card
      expect(out.filter((i: any) => i.type === 'lats_search')).toHaveLength(1)
    })
  })
})
