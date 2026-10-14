/**
 * The job window names the skill a picked job works on (platform 1.1.0, D12): "Skill: <name>"
 * when the job carries a name, "a deleted skill" when the recorded skill no longer exists
 * (null), and nothing for a job started without a pick (undefined, a 1.0.0 action).
 */
import { test, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { JobProgressModal } from './JobProgressModal'
import type { PluginJob } from './runPluginAction'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function draw(job: PluginJob) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    jobId: job.jobId, pluginId: 'skiller', actionId: 'analyze', status: 'running', progress: { message: 'Reading the session', fields: {} },
    result: null, error: null, createdAt: '2026-10-10T10:00:00.000Z', updatedAt: '', deadline: '',
  }), { status: 200 })))
  render(<JobProgressModal job={job} onClose={vi.fn()} onReviewProposal={vi.fn()} pollMs={1000} now={() => Date.parse('2026-10-10T10:00:05.000Z')} />)
}

const base = { jobId: 'job_1', pluginId: 'skiller', displayName: 'Skiller', label: 'Improve skill from this session' }

test('a job with a skill name shows "Skill: <name>"', async () => {
  draw({ ...base, skillName: 'My SQLi flow v2' })
  await screen.findByText('Reading the session')
  expect(screen.getByTestId('job-skill').textContent).toBe('Skill: My SQLi flow v2')
})

test('a job whose skill was deleted (null) shows "a deleted skill"', async () => {
  draw({ ...base, skillName: null })
  await screen.findByText('Reading the session')
  expect(screen.getByTestId('job-skill').textContent).toBe('Skill: a deleted skill')
})

test('a job started without a pick (undefined) shows no skill line', async () => {
  draw(base)
  await screen.findByText('Reading the session')
  expect(screen.queryByTestId('job-skill')).toBeNull()
  expect(screen.queryByText(/^Skill:/)).toBeNull()
})

test('the skill name is text, never markup', async () => {
  draw({ ...base, skillName: '<b>bold</b>' })
  await screen.findByText('Reading the session')
  const line = screen.getByTestId('job-skill')
  expect(line.textContent).toBe('Skill: <b>bold</b>')
  expect(line.querySelector('b')).toBeNull()
})
