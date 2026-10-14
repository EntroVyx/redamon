/**
 * The RoE page's own actions: replace, remove and download next to each other,
 * an upload in the empty state, and a confirmed replace refreshing the toolbar.
 *
 * @vitest-environment jsdom
 */
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const h = vi.hoisted(() => ({ setCurrentProject: vi.fn() }))
vi.mock('./AuthorizationHistory', () => ({ AuthorizationHistory: () => null }))
vi.mock('@/providers/ProjectProvider', () => ({
  useProject: () => ({
    currentProject: { id: 'p1', name: 'p', roeGlobalMaxRps: 5, roeExcludedHosts: [], roeTimeWindowEnabled: false },
    setCurrentProject: h.setCurrentProject,
    userId: null,
  }),
}))

import { RoeViewer } from './RoeViewer'
import { ToastProvider } from '@/components/ui'
import { resetRoeStore, setRoeEntry } from '@/components/roe/roeParseStore'
import { AGENT_ENFORCEMENT_WARNING } from '@/lib/roe/agentWarning'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
let fetchMock: ReturnType<typeof vi.fn>
let client: QueryClient

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  client = new QueryClient()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetRoeStore()
  h.setCurrentProject.mockReset()
})

function show(project: Record<string, unknown>) {
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RoeViewer projectId="p1" project={project as never} />
      </ToastProvider>
    </QueryClientProvider>,
  )
}

const WITH_DOC = { roeGlobalMaxRps: 5, roeDocumentName: 'roe-A.pdf', roeClientName: 'Northwind Example' }

describe('the RoE page header', () => {
  test('replace, remove and the download sit together', () => {
    show(WITH_DOC)
    expect(screen.getByRole('button', { name: /Replace RoE/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Remove/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /roe-A\.pdf/ })).toHaveAttribute('title', 'roe-A.pdf')
  })

  test('a failed download shows inline rather than opening a tab', async () => {
    fetchMock.mockResolvedValue(json(404, { error: 'No RoE document uploaded' }))
    show(WITH_DOC)
    fireEvent.click(screen.getByRole('button', { name: /roe-A\.pdf/ }))
    expect(await screen.findByText('No RoE document uploaded')).toBeInTheDocument()
  })

  test('the empty state offers the upload', () => {
    show({})
    expect(screen.getByRole('button', { name: /Upload RoE/ })).toBeInTheDocument()
  })

  test('rules the agent will not enforce carry the banner', () => {
    show({ roeDocumentName: 'a.pdf', roeClientName: 'N', roeForbiddenTools: ['execute_hydra'], roeParsedJson: { applied: { roeForbiddenTools: ['execute_hydra'] } } })
    expect(screen.getByText(AGENT_ENFORCEMENT_WARNING)).toBeInTheDocument()
  })
})

describe('a confirmed replace', () => {
  test('refreshes the project caches and the toolbar\'s project', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    setRoeEntry('p1', {
      status: 'review',
      file: new File(['x'], 'roe-B.pdf'),
      review: {
        mode: 'replace', rowVersion: 'v', parsedFields: { roeGlobalMaxRps: 20 }, bytesSha256: 'a',
        changes: [{ key: 'roeGlobalMaxRps', kind: 'set', before: 5, after: 20, meaning: '', section: null }],
        kept: [], rejected: [], ignored: [], unknownKeys: [], warnings: [],
        previews: { busy: { busy: false }, schedulesToPause: [], queuedJobsToReconfirm: 0, thirdParty: { ceilingMissing: false, needsAuthorization: false } },
      },
    })
    fetchMock.mockResolvedValue(json(200, {
      project: { id: 'p1', roeGlobalMaxRps: 20, roeExcludedHosts: [], roeTimeWindowEnabled: false, updatedAt: '2026-10-14T13:00:00.000Z' },
      changed: ['roeGlobalMaxRps'], pausedSchedules: [], queuedJobsNeedingReview: { count: 0 },
    }))
    show(WITH_DOC)
    fireEvent.click(screen.getByRole('button', { name: 'Replace RoE and save' }))
    await waitFor(() => expect(h.setCurrentProject).toHaveBeenCalled())
    expect(h.setCurrentProject.mock.calls[0][0]).toMatchObject({ id: 'p1', roeGlobalMaxRps: 20 })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project', 'p1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects'] })
  })
})
