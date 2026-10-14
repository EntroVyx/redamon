/**
 * Superseded RoE documents through an export and an import.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'

import { digestScopeDocument } from '@/lib/engagement'
import { sha256Hex } from './extractText'
import { exportRevision, importRevision } from './revisionBundle'

const ROW = {
  documentName: 'roe-A.pdf', mimeType: 'application/pdf', data: new Uint8Array(Buffer.from('%PDF A')),
  rawText: 'RoE A', parsedJson: { version: 2, applied: { roeGlobalMaxRps: 5 } },
  appliedAt: new Date('2026-10-01T00:00:00.000Z'), supersededAt: new Date('2026-10-05T00:00:00.000Z'), reason: 'replaced',
}

describe('RoE revisions in a bundle', () => {
  test('round-trip: the bytes, text and parse come back, re-hashed, under the importer', () => {
    const exported = JSON.parse(JSON.stringify(exportRevision(ROW)))
    const data = importRevision(exported, { projectId: 'new', importerUserId: 'importer' })!
    expect(Buffer.from(data.data!).toString()).toBe('%PDF A')
    expect(data.bytesSha256).toBe(sha256Hex(Buffer.from('%PDF A')))
    expect(data.textSha256).toBe(digestScopeDocument('RoE A'))
    expect(data.supersededById).toBe('importer')
    expect((data.parsedJson as { applied: unknown }).applied).toEqual({ roeGlobalMaxRps: 5 })
    expect(data.appliedAt?.toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })

  test('a planted scope key in a revision parse is dropped', () => {
    const exported = { ...exportRevision(ROW), parsedJson: { version: 2, applied: { targetDomain: 'evil.example' } } }
    const data = importRevision(exported, { projectId: 'new', importerUserId: 'importer' })!
    expect((data.parsedJson as { applied: unknown }).applied).toEqual({})
  })

  test('an unknown type is stored as none, and an empty revision is not imported', () => {
    const html = importRevision({ ...exportRevision(ROW), documentName: 'x.html', mimeType: 'text/html' }, { projectId: 'n', importerUserId: 'i' })!
    expect(html.mimeType).toBe('')
    expect(importRevision({ documentName: 'a.pdf' }, { projectId: 'n', importerUserId: 'i' })).toBeNull()
    expect(importRevision('nope', { projectId: 'n', importerUserId: 'i' })).toBeNull()
  })
})
