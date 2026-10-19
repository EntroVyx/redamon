/**
 * @vitest-environment jsdom
 *
 * The OpenAPI partial-recon modal.
 *
 * A document's operations go under the API server the document itself names
 * (D13), so the modal must neither offer "Associate URLs to" nor send a BaseURL
 * in `url_attach_to`: a stale choice there would file a whole API under the
 * wrong host. The configured documents are listed with their last status, by
 * location only, because a document URL can carry a token.
 *
 * Run: npx vitest run src/components/projects/ProjectForm/WorkflowView/PartialReconModal.openapi.test.tsx
 */
import { createHash } from 'node:crypto'
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { PartialReconModal } from './PartialReconModal'

vi.mock('@/providers/ProjectProvider', async orig => ({
  ...(await orig<typeof import('@/providers/ProjectProvider')>()),
  useProject: () => ({ userId: 'u1' }),
  useOptionalProject: () => ({ userId: 'u1' }),
}))

const DOC = 'https://docs.acme.test/openapi.json'
const recon = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 12)

function mockFetch() {
  return vi.fn((url: string) => {
    if (url.includes('/graph-inputs/')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          domain: 'acme.test', existing_subdomains: [], existing_subdomains_count: 0,
          existing_baseurls: ['https://api.acme.test'], existing_baseurls_count: 1,
          openapiSourceStatus: [`s1|${recon(DOC)}|ok|2026-10-01T00:00:00Z`],
          source: 'graph',
        }),
      } as Response)
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
  })
}

function renderModal(toolId: string, openapiSources?: unknown) {
  const onConfirm = vi.fn()
  render(
    <PartialReconModal
      isOpen
      toolId={toolId}
      onClose={vi.fn()}
      onConfirm={onConfirm}
      projectId="p1"
      targetDomain="acme.test"
      userId="u1"
      openapiSources={openapiSources}
    />,
  )
  return { onConfirm }
}

async function typeUrl(value: string) {
  const box = await screen.findByPlaceholderText(/api\.example\.com:8443/)
  fireEvent.change(box, { target: { value } })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => { vi.stubGlobal('fetch', mockFetch()) })

describe('PartialReconModal — OpenAPI', () => {
  test('lists the configured documents by location, with their last status', async () => {
    renderModal('OpenAPI', [
      { id: 's1', url: `${DOC}?token=fixture-secret` },
      { id: 's2', url: 'https://docs.acme.test/v2.json' },
    ])
    const list = await screen.findByTestId('openapi-source-status')
    await waitFor(() => expect(list.textContent).toContain('Imported'))
    expect(list.textContent).toContain(DOC)
    expect(list.textContent).toContain('Not fetched yet')
    expect(list.textContent).not.toContain('fixture-secret')
  })

  test('custom URLs are sent with no BaseURL attachment, and none is offered', async () => {
    const { onConfirm } = renderModal('OpenAPI')
    await typeUrl('https://docs.acme.test/v2.json')
    expect(screen.queryByText('Associate URLs to')).toBeNull()

    fireEvent.click(await screen.findByRole('button', { name: /Run Partial Recon/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    const targets = onConfirm.mock.calls[0][0].user_targets
    expect(targets.urls).toEqual(['https://docs.acme.test/v2.json'])
    expect(targets).toHaveProperty('url_attach_to', null)
  })

  test('control: Katana still offers the attachment and sends the choice', async () => {
    // Proves the assertions above come from the OpenAPI branch, not from the
    // select being absent for every resource-enum tool.
    const { onConfirm } = renderModal('Katana')
    await typeUrl('https://api.acme.test/start')
    await screen.findByText('Associate URLs to')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'https://api.acme.test' } })

    fireEvent.click(await screen.findByRole('button', { name: /Run Partial Recon/i }))
    expect(onConfirm.mock.calls[0][0].user_targets.url_attach_to).toBe('https://api.acme.test')
  })

  test('the status list is OpenAPI only', async () => {
    renderModal('Katana', [{ id: 's1', url: DOC }])
    await screen.findByRole('button', { name: /Run Partial Recon/i })
    expect(screen.queryByTestId('openapi-source-status')).toBeNull()
  })
})
