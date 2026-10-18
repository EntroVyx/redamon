/**
 * Panel orchestration tests. The React Flow canvas is mocked (it does not render
 * in jsdom), so these cover the panel's own logic: node selection opens the
 * inspector, and the scrubber appears + drives which snapshot is shown.
 *
 * Run: npx vitest run --no-file-parallelism \
 *   src/app/graph/components/AIAssistantDrawer/LatsTreePanel.test.tsx
 */

import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { LatsTreeSnapshot, LatsNodeView } from '@/lib/websocket-types'
import type { LatsSearchItem } from './AgentTimeline'

// Mock the ReactFlow canvas: expose a button that selects a node.
vi.mock('./LatsTreeCanvas', () => ({
  LatsTreeCanvas: ({ snapshot, onSelectNode }: { snapshot: LatsTreeSnapshot; onSelectNode: (id: string) => void }) => (
    <button data-testid="mock-canvas" data-rollouts={snapshot.rollouts} onClick={() => onSelectNode('c3')}>
      canvas
    </button>
  ),
}))

import { LatsTreePanel } from './LatsTreePanel'

afterEach(cleanup)

function node(over: Partial<LatsNodeView>): LatsNodeView {
  return {
    id: 'n', parent_id: null, depth: 0, label: 'n', tool_name: null, status: 'evaluated',
    value: 0, local_value: 0, visits: 0, verdict: '', error_class: '', response_class: '',
    finding_confidence: 0, exploit_succeeded: false, duration_ms: 0,
    observation: '', reflection: '', is_dangerous: false, step_id: null, ...over,
  }
}

function snap(rollouts: number): LatsTreeSnapshot {
  return {
    search_id: 's1:root', objective: 'admin takeover', phase: 'exploitation', shadow_mode: true,
    rollouts, budget: { max_rollouts: 24, max_depth: 6 }, active_id: 'c3', best_trajectory: [],
    nodes: [
      node({ id: 'root', label: '/login', visits: 3 }),
      node({ id: 'c3', parent_id: 'root', depth: 1, label: 'reset', tool_name: 'execute_curl', visits: 2 }),
    ],
  }
}

function item(history: LatsTreeSnapshot[]): LatsSearchItem {
  return {
    type: 'lats_search', id: 's1:root', search_id: 's1:root', timestamp: new Date(),
    objective: 'admin takeover', phase: 'exploitation', shadow_mode: true,
    status: 'running', latest: history[history.length - 1], history,
  }
}

describe('LatsTreePanel', () => {
  test('selecting a node opens the inspector', () => {
    render(<LatsTreePanel item={item([snap(2)])} isOpen onClose={() => {}} />)
    expect(screen.queryByTestId('lats-node-inspector')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mock-canvas'))
    expect(screen.getByTestId('lats-node-inspector')).toBeInTheDocument()
    expect(screen.getByText(/execute_curl/)).toBeInTheDocument()
  })

  test('scrubber appears only when history has more than one snapshot', () => {
    const { rerender } = render(<LatsTreePanel item={item([snap(1)])} isOpen onClose={() => {}} />)
    expect(screen.queryByTestId('lats-scrubber')).not.toBeInTheDocument()
    rerender(<LatsTreePanel item={item([snap(1), snap(2)])} isOpen onClose={() => {}} />)
    expect(screen.getByTestId('lats-scrubber')).toBeInTheDocument()
  })

  test('scrubbing back shows an earlier snapshot', () => {
    render(<LatsTreePanel item={item([snap(1), snap(2), snap(3)])} isOpen onClose={() => {}} />)
    // defaults to latest (rollouts=3)
    expect(screen.getByTestId('mock-canvas').getAttribute('data-rollouts')).toBe('3')
    fireEvent.change(screen.getByLabelText('Replay search rollouts'), { target: { value: '0' } })
    expect(screen.getByTestId('mock-canvas').getAttribute('data-rollouts')).toBe('1')
  })
})
