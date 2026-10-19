/**
 * The OpenAPI settings section: the idle banner, the per-document status read
 * from the last runs, and the advisory scope hint.
 *
 * A status is shown only while the row's URL hashes to the one recon fetched,
 * so the expected hash is computed here the way recon computes it (sha256 of
 * the public URL, first 12 hex digits) rather than through the code under test.
 */
import { createHash } from 'node:crypto'
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { OpenApiSection, OPENAPI_IDLE_MESSAGE } from './OpenApiSection'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const DOC = 'https://docs.example.com/openapi.json'
const recon = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 12)

type Props = Parameters<typeof OpenApiSection>[0]

function renderSection(data: Record<string, unknown>, extra: Partial<Props> = {}) {
  const updateField = vi.fn()
  render(
    <OpenApiSection
      data={{ openapiEnabled: true, openapiAutoDiscover: false, targetDomain: 'example.com', ...data } as unknown as Props['data']}
      updateField={updateField}
      {...extra}
    />
  )
  return { updateField }
}

function stubStatus(entries: string[]) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ openapiSourceStatus: entries })))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('OpenApiSection idle banner', () => {
  test('shown when enabled with no document and auto-discover off', () => {
    renderSection({ openapiSources: [] })
    expect(screen.getByRole('status').textContent).toContain(OPENAPI_IDLE_MESSAGE)
  })

  test('a disabled or blank row does not count as a document', () => {
    renderSection({ openapiSources: [{ id: 'a', url: DOC, enabled: false }, { id: 'b', url: '' }] })
    expect(screen.getByRole('status')).toBeTruthy()
  })

  test('gone with a document, with auto-discover, or with the tool off', () => {
    renderSection({ openapiSources: [{ id: 'a', url: DOC }] })
    expect(screen.queryByRole('status')).toBeNull()
    cleanup()
    renderSection({ openapiAutoDiscover: true, openapiSources: [] })
    expect(screen.queryByRole('status')).toBeNull()
    cleanup()
    renderSection({ openapiEnabled: false, openapiSources: [] })
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('OpenApiSection per-document status', () => {
  test('a row reads its last status while its URL is the one fetched', async () => {
    const fetchMock = stubStatus([
      `s1|${recon(DOC)}|ok|2026-10-01T00:00:00Z`,
      `s2|${recon('https://docs.example.com/old.json')}|http_404|2026-10-01T00:00:00Z`,
      `s3|${recon('https://docs.example.com/v3.json')}|blocked_address|2026-10-01T00:00:00Z`,
    ])
    renderSection({
      openapiSources: [
        // The query string is not part of what recon hashes.
        { id: 's1', url: `${DOC}?token=fixture` },
        // Edited since the run: its status no longer describes it.
        { id: 's2', url: 'https://docs.example.com/new.json' },
        { id: 's3', url: 'https://docs.example.com/v3.json' },
        { id: 's4', url: 'https://docs.example.com/added.json' },
      ],
    }, { projectId: 'proj-1' })

    expect(fetchMock).toHaveBeenCalledWith('/api/recon/proj-1/graph-inputs/OpenAPI')
    await waitFor(() => expect(screen.getByText('Imported')).toBeTruthy())
    expect(screen.getByText('Internal address blocked')).toBeTruthy()
    expect(screen.getAllByText('Not fetched yet')).toHaveLength(2)
    expect(screen.queryByText('HTTP 404')).toBeNull()
  })

  test('no project id: no request and no badge', async () => {
    const fetchMock = stubStatus([`s1|${recon(DOC)}|ok|2026-10-01T00:00:00Z`])
    renderSection({ openapiSources: [{ id: 's1', url: DOC }] })
    await new Promise(r => setTimeout(r, 0))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByText('Imported')).toBeNull()
  })

  test('an unreadable status shows no badge rather than a guess', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    renderSection({ openapiSources: [{ id: 's1', url: DOC }] }, { projectId: 'proj-1' })
    await new Promise(r => setTimeout(r, 0))
    expect(screen.queryByText('Not fetched yet')).toBeNull()
    expect(screen.queryByText('Imported')).toBeNull()
  })
})

describe('OpenApiSection scope hint', () => {
  const HINT = /Outside the project scope/

  test('a document under the project root has no hint', () => {
    renderSection({ openapiSources: [{ id: 'a', url: 'https://api.example.com/openapi.json' }] })
    expect(screen.queryByText(HINT)).toBeNull()
  })

  test('a document on another domain is flagged, not refused', () => {
    const { updateField } = renderSection({ openapiSources: [{ id: 'a', url: 'https://docs.example.org/openapi.json' }] })
    expect(screen.getByText(HINT)).toBeTruthy()
    expect(updateField).not.toHaveBeenCalled()
  })

  test('Domain batch: a subdomain of a group root that the list does not name is flagged', () => {
    renderSection({
      targetDomain: '',
      domainBatchMode: true,
      domainBatchHosts: ['www.example.com', 'api.example.com'],
      openapiSources: [
        { id: 'a', url: 'https://api.example.com/openapi.json' },
        { id: 'b', url: 'https://docs.example.com/openapi.json' },
      ],
    })
    expect(screen.getAllByText(HINT)).toHaveLength(1)
  })

  test('IP mode: a name is outside, an address inside a target CIDR is not', () => {
    renderSection({
      ipMode: true,
      targetIps: ['198.51.100.0/24'],
      openapiSources: [
        { id: 'a', url: 'https://198.51.100.7/openapi.json' },
        { id: 'b', url: 'https://docs.example.com/openapi.json' },
      ],
    })
    expect(screen.getAllByText(HINT)).toHaveLength(1)
  })
})
