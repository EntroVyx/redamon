/**
 * The RoE review: what it shows, what blocks the confirm, and every way a
 * confirm can fail. Retrying never calls the model again: the only requests
 * here are the RoE route and the re-diff, both stubbed.
 *
 * @vitest-environment jsdom
 */
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import { RoeReviewModal } from './RoeReviewModal'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

function review(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'replace',
    projectId: 'p1',
    rowVersion: '2026-10-14T12:00:00.000Z',
    parsedFields: { roeGlobalMaxRps: 20 },
    bytesSha256: 'a'.repeat(64),
    modelUsed: 'deepseek/deepseek-v4-pro',
    documentName: 'roe-B.pdf',
    pages: 2,
    changes: [
      { key: 'roeGlobalMaxRps', kind: 'set', before: 5, after: 20, meaning: 'ceiling', section: 'TargetSection', widening: 'raises a rate ceiling' },
      { key: 'roeClientContactName', kind: 'reset', before: 'Alex', after: '', meaning: 'contact', section: 'RoeSection' },
      { key: 'naabuRateLimit', kind: 'restore', before: 10, after: 100, meaning: 'rate', section: 'PortScanSection' },
    ],
    kept: [{ key: 'katanaDepth', current: 4, previousDocument: 2, meaning: 'depth', section: 'ResourceEnumSection' }],
    rejected: [{ key: 'agentRequireToolConfirmation', value: false, why: 'a document may only tighten this setting (to true)' }],
    ignored: ['targetDomain'],
    unknownKeys: ['agentLhost'],
    warnings: [],
    previews: {
      busy: { busy: false },
      schedulesToPause: [{ id: 's1', label: 'nightly', why: 'the new Rules of Engagement widen the engagement' }],
      queuedJobsToReconfirm: 2,
      thirdParty: { ceilingMissing: false, needsAuthorization: false },
    },
    ...over,
  }
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function open(props: Partial<Parameters<typeof RoeReviewModal>[0]> = {}) {
  const handlers = { onClose: vi.fn(), onApplied: vi.fn(), onReviewChanged: vi.fn(), onApplyToForm: vi.fn() }
  const utils = render(
    <RoeReviewModal
      review={review()}
      target="existing"
      projectId="p1"
      file={new File(['x'], 'roe-B.pdf', { type: 'application/pdf' })}
      {...handlers}
      {...props}
    />,
  )
  return { ...utils, ...handlers }
}

const confirmButton = () => screen.getByRole('button', { name: /Replace RoE and save|Remove RoE and save|Apply/ })

describe('what the review shows', () => {
  test('rows grouped by why they change, with widening marked', () => {
    open()
    expect(screen.getByText(/Set by the new document \(1\)/)).toBeInTheDocument()
    expect(screen.getByText(/Reset to default/)).toBeInTheDocument()
    expect(screen.getByText(/Restored \(only the previous document set them\)/)).toBeInTheDocument()
    expect(screen.getByText(/Kept: changed after the previous document/)).toBeInTheDocument()
    expect(screen.getByText('Widens: raises a rate ceiling')).toBeInTheDocument()
    expect(screen.getByText(/a document may only tighten this setting/)).toBeInTheDocument()
    expect(screen.getByText(/targetDomain, agentLhost/)).toBeInTheDocument()
  })

  test('the model and the provider the document was sent to are named', () => {
    open()
    expect(screen.getByText('deepseek/deepseek-v4-pro')).toBeInTheDocument()
    expect(screen.getByText('deepseek')).toBeInTheDocument()
  })

  test('a long value is shown whole behind a toggle, never cut silently', () => {
    const long = 'x'.repeat(400)
    open({ review: review({ changes: [{ key: 'roeNotes', kind: 'set', before: '', after: long, meaning: 'notes', section: null }] }) })
    expect(screen.queryByText(long)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Show all \(400 characters\)/ }))
    expect(screen.getByText(long)).toBeInTheDocument()
  })

  test('the side effects are previewed before the confirm', () => {
    open()
    expect(screen.getByText(/1 scheduled scan will be paused/)).toBeInTheDocument()
    expect(screen.getByText(/nightly/)).toBeInTheDocument()
    expect(screen.getByText(/2 queued scans will wait for you/)).toBeInTheDocument()
  })

  test('an unsaved edit the replace would overwrite is listed as a conflict', () => {
    open({ unsavedKeys: ['naabuRateLimit', 'katanaCustomHeaders'] })
    const notice = screen.getByText(/You have unsaved edits this would replace/).parentElement!
    // Only the edit the replace touches, not the unrelated one.
    expect(notice.textContent).toContain('naabuRateLimit')
    expect(notice.textContent).not.toContain('katanaCustomHeaders')
  })
})

describe('what blocks the confirm', () => {
  test('running work disables it and says why', () => {
    open({ review: review({ previews: { ...review().previews as object, busy: { busy: true, verified: true, what: 'a full recon scan is running' } } }) })
    expect(confirmButton()).toBeDisabled()
    expect(screen.getByText(/Confirming is disabled while a full recon scan is running/)).toBeInTheDocument()
  })

  test('a third-party widening disables it and says how to authorize', () => {
    open({ review: review({ previews: { ...review().previews as object, thirdParty: { ceilingMissing: false, needsAuthorization: true } } }) })
    expect(confirmButton()).toBeDisabled()
    expect(screen.getByText(/Record an authorization for the new document first/)).toBeInTheDocument()
  })
})

describe('confirming', () => {
  test('success hands the saved row back', async () => {
    fetchMock.mockResolvedValue(json(200, { project: { id: 'p1' }, changed: ['roeGlobalMaxRps'] }))
    const { onApplied } = open()
    fireEvent.click(confirmButton())
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith({ project: { id: 'p1' }, changed: ['roeGlobalMaxRps'] }))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/projects/p1/roe')
    const body = init.body as FormData
    expect(JSON.parse(body.get('changes') as string)).toEqual({ roeGlobalMaxRps: 20, roeClientContactName: '', naabuRateLimit: 100 })
    expect(body.get('rowVersion')).toBe('2026-10-14T12:00:00.000Z')
  })

  test('stale with an identical re-diff confirms again by itself, once, and never calls the model', async () => {
    fetchMock
      .mockResolvedValueOnce(json(409, { code: 'roe_stale', error: 'stale' }))
      .mockResolvedValueOnce(json(200, review({ rowVersion: '2026-10-14T13:00:00.000Z' })))
      .mockResolvedValueOnce(json(200, { project: { id: 'p1' }, changed: [] }))
    const { onApplied, onReviewChanged } = open()
    fireEvent.click(confirmButton())
    await waitFor(() => expect(onApplied).toHaveBeenCalled())
    expect(onReviewChanged).toHaveBeenCalled()
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['/api/projects/p1/roe', '/api/roe/parse', '/api/projects/p1/roe'])
    // The re-diff is JSON: no file, so no model call.
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ 'Content-Type': 'application/json' })
    expect((fetchMock.mock.calls[2][1].body as FormData).get('rowVersion')).toBe('2026-10-14T13:00:00.000Z')
  })

  test('stale with a different re-diff stops and says the project changed', async () => {
    fetchMock
      .mockResolvedValueOnce(json(409, { code: 'roe_stale', error: 'stale' }))
      .mockResolvedValueOnce(json(200, review({ changes: [{ key: 'roeGlobalMaxRps', kind: 'set', before: 7, after: 20, meaning: '', section: null }] })))
    const { onApplied } = open()
    fireEvent.click(confirmButton())
    expect(await screen.findByText(/The project changed while you were reviewing/)).toBeInTheDocument()
    expect(onApplied).not.toHaveBeenCalled()
  })

  test('busy keeps the review open with the reason', async () => {
    fetchMock.mockResolvedValue(json(409, { code: 'roe_busy', error: 'Cannot change the Rules of Engagement while a GVM vulnerability scan is running.', busy: 'x' }))
    const { onApplied, onClose } = open()
    fireEvent.click(confirmButton())
    expect(await screen.findByText(/while a GVM vulnerability scan is running/)).toBeInTheDocument()
    expect(onApplied).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  test('a 400 names the offending keys', async () => {
    fetchMock.mockResolvedValue(json(400, { code: 'roe_key_not_allowed', error: 'A Rules of Engagement document may not change: targetDomain.', keys: ['targetDomain'] }))
    open()
    fireEvent.click(confirmButton())
    expect(await screen.findByText(/may not change: targetDomain/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  test('a 404 says the project was deleted and disables the confirm', async () => {
    fetchMock.mockResolvedValue(json(404, { code: 'not_found', error: 'The project no longer exists.' }))
    open()
    fireEvent.click(confirmButton())
    expect(await screen.findByText('This project was deleted')).toBeInTheDocument()
    expect(confirmButton()).toBeDisabled()
  })

  test('a network failure offers Retry, which re-sends only the confirm', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(json(200, { project: { id: 'p1' }, changed: [] }))
    const { onApplied } = open()
    fireEvent.click(confirmButton())
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(onApplied).toHaveBeenCalled())
    expect(fetchMock.mock.calls.every(c => c[0] === '/api/projects/p1/roe')).toBe(true)
  })

  test('a remove does not talk about a new document', () => {
    open({ review: review({ mode: 'remove' }), file: null })
    expect(screen.getByText(/^Reset to default \(1\)$/)).toBeInTheDocument()
    expect(screen.queryByText(/the new document is silent/)).toBeNull()
  })

  test('remove sends a DELETE with the confirmed set', async () => {
    fetchMock.mockResolvedValue(json(200, { project: { id: 'p1' }, changed: [] }))
    open({ review: review({ mode: 'remove' }), file: null })
    fireEvent.click(screen.getByRole('button', { name: 'Remove RoE and save' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE')
  })

  test('on a project being created, confirming fills the form and saves nothing', () => {
    const { onApplyToForm } = open({ target: 'create', projectId: null })
    fireEvent.click(screen.getByRole('button', { name: /Apply 3 changes/ }))
    expect(onApplyToForm).toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('providerOfModel', () => {
  test('names the provider a model id routes to', async () => {
    const { providerOfModel } = await import('./roeClient')
    expect(providerOfModel('deepseek/deepseek-v4-pro')).toBe('deepseek')
    expect(providerOfModel('custom/cmabc')).toBe('your custom provider')
    expect(providerOfModel('claude-opus-4-6')).toBe('anthropic')
    expect(providerOfModel(null)).toBe('the configured provider')
  })
})
