/**
 * Unit tests for the LATS tidy-tree layout.
 *
 * Run: npx vitest run --no-file-parallelism \
 *   src/app/graph/components/AIAssistantDrawer/latsTreeLayout.test.ts
 */

import { describe, test, expect } from 'vitest'
import { latsTreeLayout, LATS_X_STEP, LATS_Y_STEP } from './latsTreeLayout'
import type { LatsNodeView } from '@/lib/websocket-types'

function node(id: string, parent_id: string | null, depth: number): LatsNodeView {
  return {
    id, parent_id, depth, label: id, tool_name: null, status: 'evaluated',
    value: 0, local_value: 0, visits: 0, verdict: '', error_class: '', response_class: '',
    finding_confidence: 0, exploit_succeeded: false, duration_ms: 0,
    observation: '', reflection: '', is_dangerous: false, step_id: null,
  }
}

// The canonical Node A tree: root -> 4 children, one of which has 3 grandchildren.
function nodeATree(): LatsNodeView[] {
  return [
    node('root', null, 0),
    node('c1', 'root', 1), node('c2', 'root', 1),
    node('c3', 'root', 1), node('c4', 'root', 1),
    node('c3a', 'c3', 2), node('c3b', 'c3', 2), node('c3c', 'c3', 2),
  ]
}

describe('latsTreeLayout', () => {
  test('x equals depth * xStep', () => {
    const pos = latsTreeLayout(nodeATree())
    const byId = new Map(pos.map(p => [p.id, p]))
    expect(byId.get('root')!.x).toBe(0)
    expect(byId.get('c1')!.x).toBe(LATS_X_STEP)
    expect(byId.get('c3a')!.x).toBe(2 * LATS_X_STEP)
  })

  test('siblings are y-monotonic in child order', () => {
    const pos = latsTreeLayout(nodeATree())
    const byId = new Map(pos.map(p => [p.id, p]))
    expect(byId.get('c1')!.y).toBeLessThan(byId.get('c2')!.y)
    expect(byId.get('c2')!.y).toBeLessThan(byId.get('c3')!.y)
    expect(byId.get('c3a')!.y).toBeLessThan(byId.get('c3b')!.y)
    expect(byId.get('c3b')!.y).toBeLessThan(byId.get('c3c')!.y)
  })

  test('internal node is centered on its children', () => {
    const pos = latsTreeLayout(nodeATree())
    const byId = new Map(pos.map(p => [p.id, p]))
    const mid = (byId.get('c3a')!.y + byId.get('c3c')!.y) / 2
    expect(byId.get('c3')!.y).toBeCloseTo(mid)
  })

  test('no two nodes share the same position', () => {
    const pos = latsTreeLayout(nodeATree())
    const keys = pos.map(p => `${p.x},${p.y}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('bounded and overlap-free for a 60-node tree', () => {
    const nodes: LatsNodeView[] = [node('root', null, 0)]
    for (let i = 0; i < 59; i++) nodes.push(node(`n${i}`, 'root', 1))
    const pos = latsTreeLayout(nodes)
    expect(pos).toHaveLength(60)
    const keys = pos.map(p => `${p.x},${p.y}`)
    expect(new Set(keys).size).toBe(60)          // no overlaps
    const maxY = Math.max(...pos.map(p => p.y))
    expect(maxY).toBeLessThanOrEqual(60 * LATS_Y_STEP)   // bounded
  })

  test('custom step overrides apply', () => {
    const pos = latsTreeLayout(nodeATree(), { xStep: 100, yStep: 10 })
    expect(pos.find(p => p.id === 'c1')!.x).toBe(100)
  })

  test('tolerates a dangling parent_id without throwing', () => {
    const nodes = [node('a', 'ghost', 1), node('b', 'a', 2)]
    const pos = latsTreeLayout(nodes)
    expect(pos).toHaveLength(2)   // 'a' treated as a root
  })
})
