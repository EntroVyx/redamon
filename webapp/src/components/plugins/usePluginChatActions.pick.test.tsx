/**
 * usePluginChatActions with a pick (platform 1.1.0, plan Phase 3.3, D12): the click opens the
 * core's skill picker, then the model gate, then the POST with the pick; the job window names
 * the picked skill; Retry from the job window replays the SAME pick without asking again,
 * while a new click asks again.
 */
import { test, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { usePluginChatActions } from './usePluginChatActions'
import type { ChatSessionActionContribution } from '@/lib/plugins/contributions'

const ensureFeatureModel = vi.fn(async () => 'anthropic/claude')
vi.mock('@/components/shared/FeatureModelGate', () => ({
  useFeatureModelGate: () => ({ ensureFeatureModel, fetchWithFeatureModel: vi.fn(), userId: 'u1', savedVersion: 0 }),
}))
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/components/ui', async (orig) => ({ ...(await orig<typeof import('@/components/ui')>()), useToast: () => toast }))

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const pickItem: ChatSessionActionContribution = { key: 'analyze', label: 'Improve skill from this session', action: 'analyze', pick: 'session.skill', llm: true, async: true }
const plugin = { pluginId: 'skiller', displayName: 'Skiller' }
const context = { projectId: 'p1', sessionId: 's1' }

const SKILLS = {
  running: false,
  suggested: 'user_skill:sk1',
  skills: [
    { ref: 'skill.text:sql_injection', kind: 'builtin', name: 'SQL Injection', turns: 9, exists: true, selectable: true, revision: 3 },
    { ref: 'user_skill:sk1', kind: 'user', name: 'My SQLi flow v2', turns: 14, exists: true, selectable: true },
  ],
}

const jobView = (status: string, error: unknown = null) => ({
  jobId: 'job_1', pluginId: 'skiller', actionId: 'analyze', status, progress: null, result: null, error,
  createdAt: new Date().toISOString(), updatedAt: '', deadline: '',
})

function stub(jobStatus: 'running' | 'failed-model' = 'running') {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/session-skills')) return json(200, SKILLS)
    if (url.includes('/actions/')) return json(202, { jobId: 'job_1' })
    if (url.includes('/api/plugins/jobs/')) {
      return json(200, jobStatus === 'running' ? jobView('running') : jobView('failed', { code: 'model_unavailable', message: 'The model is gone.' }))
    }
    return json(404, {})
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const calls = (fetchMock: ReturnType<typeof vi.fn>, part: string) => fetchMock.mock.calls.filter((c) => String(c[0]).includes(part))
const postBodies = (fetchMock: ReturnType<typeof vi.fn>) => calls(fetchMock, '/actions/').map((c) => JSON.parse(String((c[1] as RequestInit).body)))

function Harness() {
  const { run, modals } = usePluginChatActions({ onReviewProposal: vi.fn(), onCoreScreen: vi.fn() })
  return (
    <div>
      <button onClick={() => run(plugin, pickItem, context)}>run-pick</button>
      {modals}
    </div>
  )
}

function draw() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Harness />
    </QueryClientProvider>,
  )
}

test('the click opens the picker first; the gate is not asked while it is open', async () => {
  const fetchMock = stub()
  draw()
  fireEvent.click(screen.getByText('run-pick'))
  expect(await screen.findByText('Choose a skill')).toBeInTheDocument()
  await screen.findByTestId('pick-user_skill:sk1')
  expect(ensureFeatureModel).not.toHaveBeenCalled()
  expect(calls(fetchMock, '/actions/')).toHaveLength(0)
})

test('Cancel in the picker closes it and starts nothing', async () => {
  const fetchMock = stub()
  draw()
  fireEvent.click(screen.getByText('run-pick'))
  await screen.findByTestId('pick-user_skill:sk1')
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  })
  await waitFor(() => expect(screen.queryByText('Choose a skill')).toBeNull())
  expect(ensureFeatureModel).not.toHaveBeenCalled()
  expect(calls(fetchMock, '/actions/')).toHaveLength(0)
})

test('Start: gate, then the POST with the pick, then the job window', async () => {
  const fetchMock = stub()
  draw()
  fireEvent.click(screen.getByText('run-pick'))
  await screen.findByTestId('pick-user_skill:sk1')
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  })
  await waitFor(() => expect(calls(fetchMock, '/actions/')).toHaveLength(1))
  expect(ensureFeatureModel).toHaveBeenCalledTimes(1)
  expect(postBodies(fetchMock)[0]).toEqual({ context, params: { pick: { kind: 'session.skill', ref: 'user_skill:sk1' } } })
  expect(await screen.findByTestId('job-skill')).toBeInTheDocument()
  expect(screen.queryByText('Choose a skill')).toBeNull()
})

test('the job window names a picked user skill as "<name> (your skill)" (plan §2, Phase 6 e2e)', async () => {
  stub()
  draw()
  fireEvent.click(screen.getByText('run-pick'))
  await screen.findByTestId('pick-user_skill:sk1')
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  })
  expect((await screen.findByTestId('job-skill')).textContent).toBe('Skill: My SQLi flow v2 (your skill)')
})

test('the job window names a picked built-in skill by its name', async () => {
  stub()
  draw()
  fireEvent.click(screen.getByText('run-pick'))
  fireEvent.click(within(await screen.findByTestId('pick-skill.text:sql_injection')).getByRole('radio'))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  })
  expect((await screen.findByTestId('job-skill')).textContent).toBe('Skill: SQL Injection')
})

test('Retry from the job window replays the SAME pick without reopening the picker', async () => {
  const fetchMock = stub('failed-model')
  draw()
  fireEvent.click(screen.getByText('run-pick'))
  // Pick the built-in one, so the replay is not just the suggestion again.
  fireEvent.click(within(await screen.findByTestId('pick-skill.text:sql_injection')).getByRole('radio'))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  })
  const retry = await screen.findByRole('button', { name: /retry/i })
  expect(calls(fetchMock, '/session-skills')).toHaveLength(1)
  await act(async () => {
    fireEvent.click(retry)
  })
  await waitFor(() => expect(calls(fetchMock, '/actions/')).toHaveLength(2))
  const [first, second] = postBodies(fetchMock)
  expect(second).toEqual(first)
  expect(second.params).toEqual({ pick: { kind: 'session.skill', ref: 'skill.text:sql_injection' } })
  // No second picker: no second read of the session's skills, no picker on screen.
  expect(calls(fetchMock, '/session-skills')).toHaveLength(1)
  expect(screen.queryByText('Choose a skill')).toBeNull()
})

test('a new click (not Retry) asks for the skill again', async () => {
  const fetchMock = stub()
  draw()
  fireEvent.click(screen.getByText('run-pick'))
  await screen.findByTestId('pick-user_skill:sk1')
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  })
  await screen.findByTestId('job-skill')
  fireEvent.click(screen.getByText('run-pick'))
  expect(await screen.findByText('Choose a skill')).toBeInTheDocument()
  await waitFor(() => expect(calls(fetchMock, '/session-skills')).toHaveLength(2))
})
