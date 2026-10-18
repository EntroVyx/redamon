/**
 * Component tests for the LATS node inspector (Layer 3).
 *
 * Run: npx vitest run --no-file-parallelism \
 *   src/app/graph/components/AIAssistantDrawer/LatsNodeInspector.test.tsx
 */

import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { cleanup } from '@testing-library/react'
import { LatsNodeInspector } from './LatsNodeInspector'
import type { LatsTreeSnapshot, LatsNodeView } from '@/lib/websocket-types'

afterEach(cleanup)

function node(over: Partial<LatsNodeView>): LatsNodeView {
  return {
    id: 'n', parent_id: null, depth: 0, label: 'n', tool_name: null, status: 'evaluated',
    value: 0, local_value: 0, visits: 0, verdict: '', error_class: '', response_class: '',
    finding_confidence: 0, exploit_succeeded: false, duration_ms: 0,
    observation: '', reflection: '', is_dangerous: false, step_id: null, ...over,
  }
}

const snapshot: LatsTreeSnapshot = {
  search_id: 's1:root', objective: 'o', phase: 'exploitation', shadow_mode: false,
  rollouts: 2, budget: { max_rollouts: 24, max_depth: 6 },
  active_id: 'c3', best_trajectory: [],
  nodes: [
    node({ id: 'root', label: '/login', visits: 4 }),
    node({ id: 'c3', parent_id: 'root', depth: 1, label: 'reset', tool_name: 'execute_curl',
           tool_args: { url: 'https://t/reset' }, value: 0.8, local_value: 0.72, visits: 2,
           verdict: 'new_info', error_class: 'success', finding_confidence: 85,
           observation: 'token leaked' }),
  ],
}

describe('LatsNodeInspector', () => {
  test('renders the exact command', () => {
    render(<LatsNodeInspector node={snapshot.nodes[1]} snapshot={snapshot} onClose={() => {}} />)
    expect(screen.getByText(/execute_curl/)).toBeInTheDocument()
    expect(screen.getByText(/https:\/\/t\/reset/)).toBeInTheDocument()
  })

  test('renders the score breakdown', () => {
    render(<LatsNodeInspector node={snapshot.nodes[1]} snapshot={snapshot} onClose={() => {}} />)
    // value (0.800) appears twice: score breakdown + the UCT exploit term.
    expect(screen.getAllByText('0.800').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('0.720')).toBeInTheDocument()   // local value (unique)
    expect(screen.getByText('85')).toBeInTheDocument()      // finding confidence
  })

  test('computes the UCT explore term from visits + parent visits', () => {
    render(<LatsNodeInspector node={snapshot.nodes[1]} snapshot={snapshot} onClose={() => {}} />)
    // explore = 1.4 * sqrt(ln(4)/2) ≈ 1.166
    expect(screen.getByText('1.166')).toBeInTheDocument()
  })

  test('shows infinity for an unvisited node', () => {
    const unvisited = node({ id: 'x', parent_id: 'root', depth: 1, visits: 0 })
    const snap = { ...snapshot, nodes: [snapshot.nodes[0], unvisited] }
    render(<LatsNodeInspector node={unvisited} snapshot={snap} onClose={() => {}} />)
    expect(screen.getByText(/∞/)).toBeInTheDocument()
  })

  test('fires onClose', () => {
    const onClose = vi.fn()
    render(<LatsNodeInspector node={snapshot.nodes[1]} snapshot={snapshot} onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('Close inspector'))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
