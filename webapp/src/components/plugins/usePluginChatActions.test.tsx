/**
 * usePluginChatActions wires a gear-menu click to runPluginAction and owns the job modal
 * (design §6.7). Review and core-screen handlers are injected (step 6.4 passes placeholders;
 * 6.5/6.6 pass the real modals). Retry re-runs the action the job came from.
 */
import { test, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import { usePluginChatActions } from './usePluginChatActions'
import type { ChatSessionActionContribution } from '@/lib/plugins/contributions'

const ensureFeatureModel = vi.fn(async () => 'anthropic/claude')
vi.mock('@/components/shared/FeatureModelGate', () => ({
  useFeatureModelGate: () => ({ ensureFeatureModel, fetchWithFeatureModel: vi.fn(), userId: 'u1', savedVersion: 0 }),
}))
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() }
vi.mock('@/components/ui', async (orig) => ({ ...(await orig<typeof import('@/components/ui')>()), useToast: () => toast }))

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const item = (over: Partial<ChatSessionActionContribution> = {}): ChatSessionActionContribution => ({ key: 'a', label: 'Analyze', action: 'analyze', llm: false, async: false, ...over })
const plugin = { pluginId: 'skiller', displayName: 'Skiller' }
const context = { projectId: 'p1', sessionId: 's1' }

function Harness({ onReviewProposal, onCoreScreen }: { onReviewProposal: (id: string) => void; onCoreScreen: (s: string, c: unknown) => void }) {
  const { run, modals } = usePluginChatActions({ onReviewProposal, onCoreScreen })
  return (
    <div>
      <button onClick={() => run(plugin, item({ async: true }), context)}>run-async</button>
      <button onClick={() => run(plugin, item(), context)}>run-sync</button>
      <button onClick={() => run(plugin, item({ action: undefined, coreScreen: 'skill.text.versions' }), context)}>run-core</button>
      {modals}
    </div>
  )
}

function draw() {
  const onReviewProposal = vi.fn()
  const onCoreScreen = vi.fn()
  render(<Harness onReviewProposal={onReviewProposal} onCoreScreen={onCoreScreen} />)
  return { onReviewProposal, onCoreScreen }
}

test('a sync reviewProposal reaches the injected review handler', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(200, { ok: true, result: { reviewProposal: { extensionPoint: 'skill.text', changeSetId: 'cs_3' } } })))
  const { onReviewProposal } = draw()
  fireEvent.click(screen.getByText('run-sync'))
  await waitFor(() => expect(onReviewProposal).toHaveBeenCalledWith('cs_3'))
})

test('a coreScreen item reaches the injected core-screen handler', async () => {
  vi.stubGlobal('fetch', vi.fn())
  const { onCoreScreen } = draw()
  fireEvent.click(screen.getByText('run-core'))
  await waitFor(() => expect(onCoreScreen).toHaveBeenCalledWith('skill.text.versions', context))
})

test('an async action opens the job modal, polling the job', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    url.includes('/actions/') ? json(202, { jobId: 'job_1' }) : json(200, { jobId: 'job_1', pluginId: 'skiller', actionId: 'analyze', status: 'running', progress: { message: 'Working on it', fields: {} }, result: null, error: null, createdAt: new Date().toISOString(), updatedAt: '', deadline: '' }),
  ))
  draw()
  await act(async () => {
    fireEvent.click(screen.getByText('run-async'))
  })
  expect(await screen.findByText('Working on it')).toBeInTheDocument()
  expect(screen.getByText('Analyze')).toBeInTheDocument()
})

test('a job that fails on the model, then Retry, re-runs the action it came from', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/actions/')) return json(202, { jobId: 'job_1' })
    return json(200, { jobId: 'job_1', pluginId: 'skiller', actionId: 'analyze', status: 'failed', progress: null, result: null, error: { code: 'model_unavailable', message: 'gone' }, createdAt: new Date().toISOString(), updatedAt: '', deadline: '' })
  })
  vi.stubGlobal('fetch', fetchMock)
  draw()
  await act(async () => {
    fireEvent.click(screen.getByText('run-async'))
  })
  const retry = await screen.findByRole('button', { name: /retry/i })
  const actionCallsBefore = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/actions/')).length
  await act(async () => {
    fireEvent.click(retry)
  })
  await waitFor(() => expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/actions/')).length).toBe(actionCallsBefore + 1))
})
