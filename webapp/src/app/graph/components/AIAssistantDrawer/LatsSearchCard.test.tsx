/**
 * Component tests for LatsSearchCard (Layer 1).
 *
 * Run: npx vitest run --no-file-parallelism \
 *   src/app/graph/components/AIAssistantDrawer/LatsSearchCard.test.tsx
 *
 * Covers: node labels + values render, pruned/terminal glyphs, the pinned best
 * line, the observe-only badge in shadow mode, and the Expand callback.
 */

import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { LatsSearchCard } from './LatsSearchCard'

afterEach(cleanup)
import type { LatsSearchItem } from './AgentTimeline'
import type { LatsTreeSnapshot, LatsNodeView } from '@/lib/websocket-types'

function node(over: Partial<LatsNodeView>): LatsNodeView {
  return {
    id: 'n', parent_id: null, depth: 0, label: 'n', tool_name: null,
    status: 'evaluated', value: 0, local_value: 0, visits: 0, verdict: '',
    error_class: '', response_class: '', finding_confidence: 0, exploit_succeeded: false,
    duration_ms: 0, observation: '', reflection: '', is_dangerous: false,
    step_id: null, ...over,
  }
}

function makeItem(shadow = true): LatsSearchItem {
  const snapshot: LatsTreeSnapshot = {
    search_id: 's1:root', objective: 'admin takeover', phase: 'exploitation',
    shadow_mode: shadow, rollouts: 5, budget: { max_rollouts: 24, max_depth: 6 },
    active_id: 'c3', best_trajectory: ['root', 'c3'],
    nodes: [
      node({ id: 'root', label: '/login', value: 0.8 }),
      node({ id: 'c1', parent_id: 'root', depth: 1, label: 'default creds', status: 'pruned', value: 0.0, reflection: 'creds rejected' }),
      node({ id: 'c3', parent_id: 'root', depth: 1, label: 'forgot-password', value: 0.8, observation: 'token leaked' }),
      node({ id: 'c3t', parent_id: 'c3', depth: 2, label: 'forge token', status: 'terminal', value: 1.0, exploit_succeeded: true }),
    ],
  }
  return {
    type: 'lats_search', id: 's1:root', search_id: 's1:root', timestamp: new Date(),
    objective: 'admin takeover', phase: 'exploitation', shadow_mode: shadow,
    status: 'running', latest: snapshot, history: [snapshot],
  }
}

describe('LatsSearchCard', () => {
  test('renders node labels and values', () => {
    render(<LatsSearchCard item={makeItem()} />)
    // '/login' and 'forgot-password' now also appear as best-line breadcrumb steps
    expect(screen.getAllByText('/login').length).toBeGreaterThan(0)
    expect(screen.getAllByText('forgot-password').length).toBeGreaterThan(0)
    expect(screen.getByText('default creds')).toBeInTheDocument()
    // values rendered to 2dp
    expect(screen.getAllByText('0.80').length).toBeGreaterThan(0)
  })

  test('shows the pinned best line', () => {
    render(<LatsSearchCard item={makeItem()} />)
    const best = screen.getByTestId('lats-best-line')
    expect(best.textContent).toContain('/login')
    expect(best.textContent).toContain('forgot-password')
  })

  test('renders the full best-line step text without truncation', () => {
    const longLabel =
      'The POST /wifi_settings response is 7764 bytes vs 5040 for GET, suggesting it contains a form'
    const item = makeItem()
    item.latest = { ...item.latest, best_trajectory: ['root', 'c3'] }
    item.latest.nodes = item.latest.nodes.map(n =>
      n.id === 'c3' ? { ...n, label: longLabel } : n,
    )
    render(<LatsSearchCard item={item} />)
    const best = screen.getByTestId('lats-best-line')
    // whole sentence is present, nothing clipped with an ellipsis
    expect(best.textContent).toContain(longLabel)
    expect(best.textContent).not.toContain('…')
  })

  test('shows the observe-only badge in shadow mode', () => {
    render(<LatsSearchCard item={makeItem(true)} />)
    expect(screen.getByText('observe-only')).toBeInTheDocument()
  })

  test('hides the observe-only badge when driving', () => {
    render(<LatsSearchCard item={makeItem(false)} />)
    expect(screen.queryByText('observe-only')).not.toBeInTheDocument()
  })

  test('renders the reflection on a pruned node', () => {
    render(<LatsSearchCard item={makeItem()} />)
    expect(screen.getByText('creds rejected')).toBeInTheDocument()
  })

  test('fires onExpand when Expand tree is clicked', () => {
    const onExpand = vi.fn()
    render(<LatsSearchCard item={makeItem()} onExpand={onExpand} />)
    fireEvent.click(screen.getByTestId('lats-expand-btn'))
    expect(onExpand).toHaveBeenCalledOnce()
  })
})
