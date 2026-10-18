/**
 * Unit tests for the React Flow graph builder (pure; no ReactFlow rendering).
 *
 * Run: npx vitest run --no-file-parallelism \
 *   src/app/graph/components/AIAssistantDrawer/useLatsGraph.test.ts
 */

import { describe, test, expect } from 'vitest'
import { buildLatsGraph, latsValueColor } from './useLatsGraph'
import type { LatsTreeSnapshot, LatsNodeView } from '@/lib/websocket-types'

function node(over: Partial<LatsNodeView>): LatsNodeView {
  return {
    id: 'n', parent_id: null, depth: 0, label: 'n', tool_name: null, status: 'evaluated',
    value: 0, local_value: 0, visits: 0, verdict: '', error_class: '', response_class: '',
    finding_confidence: 0, exploit_succeeded: false, duration_ms: 0,
    observation: '', reflection: '', is_dangerous: false, step_id: null, ...over,
  }
}

function snapshot(): LatsTreeSnapshot {
  return {
    search_id: 's1:root', objective: 'o', phase: 'exploitation', shadow_mode: false,
    rollouts: 2, budget: { max_rollouts: 24, max_depth: 6 },
    active_id: 'c3', best_trajectory: ['root', 'c3'],
    nodes: [
      node({ id: 'root', label: '/login', value: 0.8, visits: 3 }),
      node({ id: 'c1', parent_id: 'root', depth: 1, label: 'creds', status: 'pruned', value: 0, visits: 1 }),
      node({ id: 'c3', parent_id: 'root', depth: 1, label: 'reset', value: 0.8, visits: 2 }),
    ],
  }
}

describe('buildLatsGraph', () => {
  test('emits one node per tree node and one edge per parent link', () => {
    const { nodes, edges } = buildLatsGraph(snapshot())
    expect(nodes).toHaveLength(3)
    expect(edges).toHaveLength(2)              // root has no parent edge
    expect(nodes.every(n => n.type === 'latsNode')).toBe(true)
  })

  test('best-trajectory edge is the golden thread; others are not', () => {
    const { edges } = buildLatsGraph(snapshot())
    const best = edges.find(e => e.id === 'root->c3')!
    const other = edges.find(e => e.id === 'root->c1')!
    expect(best.style?.stroke).toBe('#fbbf24')     // gold
    expect(other.style?.stroke).not.toBe('#fbbf24')
  })

  test('pruned edge is dimmed', () => {
    const { edges } = buildLatsGraph(snapshot())
    const pruned = edges.find(e => e.id === 'root->c1')!
    expect(pruned.style?.opacity).toBeLessThan(1)
  })

  test('selected node is flagged', () => {
    const { nodes } = buildLatsGraph(snapshot(), 'c3')
    const c3 = nodes.find(n => n.id === 'c3')!
    expect((c3.data as { isSelected: boolean }).isSelected).toBe(true)
  })

  test('best node data flag set (and not for pruned)', () => {
    const { nodes } = buildLatsGraph(snapshot())
    expect((nodes.find(n => n.id === 'c3')!.data as { isBest: boolean }).isBest).toBe(true)
    expect((nodes.find(n => n.id === 'c1')!.data as { isBest: boolean }).isBest).toBe(false)
  })
})

describe('latsValueColor', () => {
  test('maps 0 -> red hue, 1 -> green hue, clamps out of range', () => {
    expect(latsValueColor(0)).toBe('hsl(0, 68%, 45%)')
    expect(latsValueColor(1)).toBe('hsl(120, 68%, 45%)')
    expect(latsValueColor(2)).toBe('hsl(120, 68%, 45%)')   // clamped
    expect(latsValueColor(-1)).toBe('hsl(0, 68%, 45%)')     // clamped
  })
})
