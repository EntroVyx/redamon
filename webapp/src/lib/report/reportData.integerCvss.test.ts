/**
 * Issue #207: a CVSS stored as a Neo4j INTEGER (10, not 10.0) reaches the report
 * as a driver Integer, whose valueOf() is a BigInt, and the Avg CVSS sum threw
 * "Cannot mix BigInt and other types". Runs the real gatherReportData and
 * generateReportHtml over a fake session that answers with real driver Integers.
 *
 * Run: npx vitest run src/lib/report/reportData.integerCvss.test.ts
 * @vitest-environment node
 */
import { describe, test, expect, vi } from 'vitest'
import neo4j from 'neo4j-driver'
import { gatherReportData } from '@/lib/report/reportData'
import { generateReportHtml } from '@/lib/report/reportTemplate'

function record(fields: Record<string, unknown>) {
  return { get: (k: string) => fields[k] ?? null }
}

vi.mock('@/app/api/graph/neo4j', () => ({
  getGraphSession: () => ({
    run: async (cypher: string) => {
      if (cypher.includes('v.cvss_score AS cvssScore')) {
        return { records: [record({ name: 'Synthetic', severity: 'critical', source: 'nuclei', cvssScore: neo4j.int(10), findingSource: 'Nuclei' })] }
      }
      if (cypher.includes('c.cvss AS cvss')) {
        // Two chains with a CWE, the lower score first, so only the attack-flow
        // sort puts the Integer 9 on top; techVersion as an Integer too: esc()
        // must render it, not throw on .replace.
        return { records: [
          record({ tech: 'synthetic-tech', techVersion: neo4j.int(8), cveId: 'CVE-0000-0002', cvss: 7.5, cweId: 'CWE-89' }),
          record({ tech: 'synthetic-tech', techVersion: neo4j.int(8), cveId: 'CVE-0000-0001', cvss: neo4j.int(9), cweId: 'CWE-79' }),
        ] }
      }
      if (cypher.includes('ex.cvss_score AS cvssScore')) {
        return { records: [record({ name: 'Synthetic exploit', severity: 'critical', cvssScore: neo4j.int(8), cisaKev: true, cveIds: [] })] }
      }
      return { records: [] }
    },
    close: async () => {},
  }),
}))

vi.mock('@/lib/prisma', () => ({
  default: {
    project: {
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({
        id: where.id, name: 'synthetic', targetDomain: 'example.test', targetIps: [],
        domainBatchGroups: null, stealthMode: false, roeDocumentName: null, roeParsedJson: null,
      }),
    },
    remediation: { findMany: async () => [] },
    scanJob: { findFirst: async () => null },
    conversation: { findMany: async () => [] },
    fireteam: { findMany: async () => [] },
  },
}))

describe('report with integer-typed CVSS (issue #207)', () => {
  test('builds, and averages the integer scores as numbers', async () => {
    const data = await gatherReportData('p1')
    expect(data.vulnerabilities.findings[0].cvssScore).toBe(10)
    expect(data.cveIntelligence.cveChains.map(c => c.cvss)).toEqual([7.5, 9])
    expect(data.cveIntelligence.exploits[0].cvssScore).toBe(8)
    expect(data.metrics.cvssAverage).toBe(8.8) // (10 + 9 + 7.5) / 3, one decimal
    expect(data.metrics.cveCriticalCount).toBe(1)
    expect(data.metrics.cveHighCount).toBe(1)
  })

  test('renders the HTML report: finding, exploit and CVE rows, chains sorted by score', async () => {
    const html = generateReportHtml(await gatherReportData('p1'), null)
    expect(html).toContain('<td>10.0</td>')
    expect(html).toContain('<td>8.0</td>')
    expect(html).toContain('synthetic-tech')
    const start = html.indexOf('Attack Flow Chains (')
    const flow = html.slice(start, html.indexOf('</table>', start))
    const top = flow.indexOf('CVE-0000-0001')
    expect(start).toBeGreaterThan(-1)
    expect(top).toBeGreaterThan(-1)
    expect(flow.indexOf('CVE-0000-0002')).toBeGreaterThan(top)
  })
})
