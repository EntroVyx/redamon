/** @vitest-environment node */
/**
 * D16: the report counts endpoints known only from an API specification apart
 * from observed ones. Both attack-surface queries split on the same predicate
 * recon uses, so a declaration never inflates the observed surface, and a node
 * an earlier release declared (no openapi_declared_only) counts as declared.
 *
 * Run: npx vitest run src/lib/report/reportData.declared.test.ts
 */
import { describe, test, expect, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ default: {} }))

import { queryAttackSurface, queryGraphOverview } from './reportData'

function int(n: number) { return { low: n, high: 0 } }

function fakeSession() {
  const queries: string[] = []
  return {
    queries,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run: vi.fn(async (cypher: string, _params: any) => {
      queries.push(cypher)
      if (cypher.includes('AS category')) {
        return { records: [{ get: (k: string) => ({ category: 'api', count: int(3), declared: int(2) } as Record<string, unknown>)[k] }] }
      }
      if (cypher.includes('AS baseUrls')) {
        return { records: [{ get: (k: string) => ({ baseUrls: int(1), endpoints: int(7), parameters: int(4), declaredEndpoints: int(9999), declaredParameters: int(13) } as Record<string, unknown>)[k] }] }
      }
      if (cypher.includes('AS position')) {
        return { records: [{ get: (k: string) => ({ position: 'query', total: int(4), injectable: int(1), declared: int(5) } as Record<string, unknown>)[k] }] }
      }
      return { records: [] }
    }),
  }
}

const PREDICATE = 'coalesce(e.openapi_declared_only, e.openapi_declared, false) AS declared'

describe('queryAttackSurface — observed and declared endpoints', () => {
  test('endpoint categories count declared-only endpoints apart', async () => {
    const s = fakeSession()
    const surface = await queryAttackSurface(s, 'p1')
    const q = s.queries.find(c => c.includes('AS category'))!
    expect(q).toContain(PREDICATE)
    expect(q).toContain('count(CASE WHEN NOT declared THEN 1 END) AS count')
    expect(surface.endpointCategories).toEqual([{ category: 'api', count: 3, declared: 2 }])
  })

  test('parameters of declared-only endpoints are neither observed nor injectable', async () => {
    const s = fakeSession()
    const surface = await queryAttackSurface(s, 'p1')
    const q = s.queries.find(c => c.includes('AS position'))!
    expect(q).toContain(PREDICATE)
    expect(q).toContain('count(CASE WHEN NOT declared AND p.is_injectable = true THEN 1 END) AS injectable')
    expect(surface.parameterAnalysis).toEqual([{ position: 'query', total: 4, injectable: 1, declared: 5 }])
  })
})

describe('queryGraphOverview — endpoint coverage', () => {
  test('the Endpoints card, the posture score and attackSurfaceSize read observed counts', async () => {
    const s = fakeSession()
    const overview = await queryGraphOverview(s, 'p1')
    const q = s.queries.find(c => c.includes('AS baseUrls'))!
    expect(q).toContain(PREDICATE)
    expect(q).toContain('count(DISTINCT CASE WHEN NOT declared THEN e END) AS endpoints')
    expect(q).toContain('count(DISTINCT CASE WHEN NOT declared THEN p END) AS parameters')
    expect(overview.endpointCoverage).toEqual(
      { baseUrls: 1, endpoints: 7, parameters: 4, declaredEndpoints: 9999, declaredParameters: 13 })
  })
})
