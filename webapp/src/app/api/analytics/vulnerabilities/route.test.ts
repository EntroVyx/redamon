/**
 * Insights vulnerabilities: a CVSS stored as INTEGER (10, not 10.0) reaches the
 * route as a driver Integer and must leave it as a plain number, or it serializes
 * as {low, high} and the Insights cards' .toFixed() throws.
 *
 * Run: npx vitest run src/app/api/analytics/vulnerabilities/route.test.ts
 * @vitest-environment node
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'
import neo4j from 'neo4j-driver'
vi.mock('@/lib/access', () => ({ guardProject: vi.fn().mockResolvedValue(null) }))

let findingRows: Array<Record<string, unknown>> = []
let chainRows: Array<Record<string, unknown>> = []
let exploitRows: Array<Record<string, unknown>> = []

vi.mock('@/app/api/graph/neo4j', () => ({
  getGraphSession: () => ({
    run: async (cypher: string) => {
      const rows = cypher.includes('v.cvss_score AS cvssScore') ? findingRows
        : cypher.includes('c.cvss AS cvss,') ? chainRows
        : cypher.includes('ex.cvss_score AS cvssScore') ? exploitRows : []
      return { records: rows.map(row => ({ get: (k: string) => row[k] ?? null })) }
    },
    close: async () => {},
  }),
}))

const route = await import('./route')

const request = (projectId: string): any => ({
  nextUrl: new URL(`http://localhost/api/analytics/vulnerabilities?projectId=${projectId}`),
})

beforeEach(() => {
  findingRows = []
  chainRows = []
  exploitRows = []
})

describe('CVSS stored as INTEGER', () => {
  test('findings, CVE chains and exploits return it as a number', async () => {
    findingRows = [{ name: 'f', cvssScore: neo4j.int(10) }, { name: 'g', cvssScore: 9.8 }, { name: 'h' }]
    chainRows = [{ tech: 't', cveId: 'CVE-0000-0001', cvss: neo4j.int(9) }]
    exploitRows = [{ name: 'e', cvssScore: neo4j.int(8), cveIds: [] }]

    const body = await (await route.GET(request('p1'))).json()

    expect(body.findings.map((f: { cvssScore: unknown }) => f.cvssScore)).toEqual([10, 9.8, null])
    expect(body.cveChains[0].cvss).toBe(9)
    expect(body.exploits[0].cvssScore).toBe(8)
  })
})
