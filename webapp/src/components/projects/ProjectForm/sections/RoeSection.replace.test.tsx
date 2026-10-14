/**
 * The engagement record on a SAVED project: the upload is always there, the
 * current document can be downloaded or removed, and a confirmed replace hands
 * the saved row back to the form.
 *
 * @vitest-environment jsdom
 */
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/providers/ProjectProvider', () => ({ useProject: () => ({ userId: null }) }))

import { RoeSection } from './RoeSection'
import { ToastProvider } from '@/components/ui'
import { resetRoeStore } from '@/components/roe/roeParseStore'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetRoeStore()
})

function renderEdit(data: Record<string, unknown>, onServerRowMerged = vi.fn()) {
  render(
    <ToastProvider>
      <RoeSection
        data={data as never}
        updateField={vi.fn()}
        updateMultipleFields={vi.fn()}
        mode="edit"
        projectId="p1"
        onFileSelected={vi.fn()}
        onServerRowMerged={onServerRowMerged}
        unsavedKeys={[]}
      />
    </ToastProvider>,
  )
  return { onServerRowMerged }
}

describe('a saved project', () => {
  test('without a document it offers Upload RoE (no longer create-only)', () => {
    renderEdit({})
    expect(screen.getByRole('button', { name: /Upload RoE/ })).toBeInTheDocument()
  })

  test('with a document it shows it, and offers Replace and Remove', () => {
    renderEdit({ roeDocumentName: 'roe-A.pdf', roeParsedJson: { appliedAt: '2026-10-01T00:00:00.000Z' } })
    expect(screen.getByText('roe-A.pdf')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Replace RoE/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Remove RoE/ })).toBeInTheDocument()
  })

  test('Remove opens a review of an empty document, and confirming merges the saved row', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, {
        mode: 'remove', rowVersion: 'v1', parsedFields: {},
        changes: [{ key: 'roeGlobalMaxRps', kind: 'restore', before: 5, after: 0, meaning: '', section: null }],
        kept: [], rejected: [], ignored: [], warnings: [],
        previews: { busy: { busy: false }, schedulesToPause: [], queuedJobsToReconfirm: 0, thirdParty: { ceilingMissing: false, needsAuthorization: false } },
      }))
      .mockResolvedValueOnce(json(200, {
        project: { id: 'p1', roeGlobalMaxRps: 0, roeDocumentName: '', updatedAt: '2026-10-14T13:00:00.000Z' },
        changed: ['roeGlobalMaxRps'], pausedSchedules: [], queuedJobsNeedingReview: { count: 0 },
      }))
    const { onServerRowMerged } = renderEdit({ roeDocumentName: 'roe-A.pdf', roeGlobalMaxRps: 5 })
    fireEvent.click(screen.getByRole('button', { name: /Remove RoE/ }))
    expect(await screen.findByText('Review removing the Rules of Engagement')).toBeInTheDocument()
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ projectId: 'p1', remove: true })
    fireEvent.click(screen.getByRole('button', { name: 'Remove RoE and save' }))
    await waitFor(() => expect(onServerRowMerged).toHaveBeenCalled())
    expect(onServerRowMerged.mock.calls[0]).toEqual([
      { id: 'p1', roeGlobalMaxRps: 0, roeDocumentName: '', updatedAt: '2026-10-14T13:00:00.000Z' },
      ['roeGlobalMaxRps'],
    ])
  })
})
