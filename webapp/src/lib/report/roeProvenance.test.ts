/**
 * Which RoE a report describes, and whether it changed after the newest scan.
 *
 * @vitest-environment node
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ newest: null as { startedAt: Date } | null }))
vi.mock('@/lib/prisma', () => ({ default: { scanJob: { findFirst: async () => h.newest } } }))
vi.mock('@/app/api/graph/neo4j', () => ({ getGraphSession: vi.fn() }))

import { queryRoeProvenance } from './reportData'

beforeEach(() => { h.newest = { startedAt: new Date('2026-10-02T10:00:00.000Z') } })

describe('queryRoeProvenance', () => {
  test('no document is no provenance', async () => {
    expect(await queryRoeProvenance('p1', { roeDocumentName: '', roeParsedJson: null })).toBeNull()
  })

  test('a document applied after the newest scan is flagged', async () => {
    const out = await queryRoeProvenance('p1', { roeDocumentName: 'B.pdf', roeParsedJson: { appliedAt: '2026-10-03T00:00:00.000Z' } })
    expect(out).toEqual({ documentName: 'B.pdf', appliedAt: '2026-10-03T00:00:00.000Z', newestScanAt: '2026-10-02T10:00:00.000Z', appliedAfterNewestScan: true })
  })

  test('one applied before it is not, and a project never scanned is not', async () => {
    expect((await queryRoeProvenance('p1', { roeDocumentName: 'A.pdf', roeParsedJson: { appliedAt: '2026-10-01T00:00:00.000Z' } }))!.appliedAfterNewestScan).toBe(false)
    h.newest = null
    expect((await queryRoeProvenance('p1', { roeDocumentName: 'A.pdf', roeParsedJson: { appliedAt: '2026-10-01T00:00:00.000Z' } }))!.appliedAfterNewestScan).toBe(false)
  })
})
