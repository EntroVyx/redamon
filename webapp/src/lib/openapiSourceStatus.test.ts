/**
 * The per-source OpenAPI status as the form reads it. The hash must equal the
 * one recon writes (sha256 of the public URL, first 12 hex digits; the
 * expected values below were computed with Python's hashlib), or every row
 * would read "Not fetched yet".
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import {
  NOT_FETCHED,
  documentInProjectScope,
  documentUrlHash,
  openApiStatusLabel,
  parseOpenApiSourceStatus,
  publicDocumentUrl,
  rowStatusLabel,
} from './openapiSourceStatus'

describe('the status recon writes', () => {
  test('is parsed by source id, ignoring malformed entries', () => {
    const parsed = parseOpenApiSourceStatus(['s1|1b2b05bdb639|ok|2026-10-19T00:00:00Z', 'broken', 7, 's2||x|y'])
    expect([...parsed.keys()]).toEqual(['s1'])
    expect(parsed.get('s1')).toEqual({ hash: '1b2b05bdb639', code: 'ok', at: '2026-10-19T00:00:00Z' })
    expect(parseOpenApiSourceStatus(null).size).toBe(0)
  })

  test.each([
    ['ok', 'Imported'], ['out_of_scope', 'Outside scope'], ['blocked_address', 'Internal address blocked'],
    ['http_401', 'HTTP 401'], ['invalid_document', 'Invalid document'], ['host_down', 'Host down'],
    ['transport_error', 'Unreachable'], ['limit_reached', 'Limit reached'], ['something_new', 'Unknown'],
  ])('%s reads %s', (code, label) => {
    expect(openApiStatusLabel(code)).toBe(label)
  })
})

describe('the URL hash matches recon', () => {
  test.each([
    ['https://API.example.com/openapi.json?token=fixture-secret#x', '1b2b05bdb639'],
    ['http://10.203.0.10:80/openapi.json', '21913abd810e'],
    ['https://api.example.com:8443/v1/spec.yaml', '30f9e45c91d2'],
  ])('%s', async (url, hash) => {
    expect(await documentUrlHash(url)).toBe(hash)
  })

  test('the query never reaches the hashed location', () => {
    expect(publicDocumentUrl('https://api.example.com/spec?token=x')).toBe('https://api.example.com/spec')
    expect(publicDocumentUrl('ftp://api.example.com/spec')).toBeNull()
  })
})

describe('a row shows its status only while its URL is the one fetched', () => {
  const statuses = parseOpenApiSourceStatus(['s1|1b2b05bdb639|blocked_address|t'])

  test('same URL: the status', () => {
    expect(rowStatusLabel({ id: 's1', url: 'x' }, statuses, '1b2b05bdb639')).toBe('Internal address blocked')
  })

  test('edited URL or never fetched: not fetched yet', () => {
    expect(rowStatusLabel({ id: 's1', url: 'x' }, statuses, 'ffffffffffff')).toBe(NOT_FETCHED)
    expect(rowStatusLabel({ id: 's2', url: 'x' }, statuses, '1b2b05bdb639')).toBe(NOT_FETCHED)
  })

  test('status unread or no hashing in this browser: unknown', () => {
    expect(rowStatusLabel({ id: 's1', url: 'x' }, null, '1b2b05bdb639')).toBeNull()
    expect(rowStatusLabel({ id: 's1', url: 'x' }, statuses, null)).toBeNull()
  })
})

describe('the advisory scope hint', () => {
  test('domain mode: under a root', () => {
    const project = { targetDomain: 'example.com' }
    expect(documentInProjectScope('https://docs.example.com/openapi.json', project)).toBe(true)
    expect(documentInProjectScope('https://example.org/openapi.json', project)).toBe(false)
  })

  test('batch mode: under any group root', () => {
    const project = { domainBatchMode: true, domainBatchGroups: [{ rootDomain: 'one.test', prefixes: ['*'] }] }
    expect(documentInProjectScope('https://api.one.test/spec', project)).toBe(true)
    expect(documentInProjectScope('https://two.test/spec', project)).toBe(false)
  })

  test('IP mode: inside a target IP or CIDR; a name is outside', () => {
    const project = { ipMode: true, targetIps: ['10.203.0.0/24', '198.51.100.7'] }
    expect(documentInProjectScope('http://10.203.0.10/openapi.json', project)).toBe(true)
    expect(documentInProjectScope('http://198.51.100.7:8080/spec', project)).toBe(true)
    expect(documentInProjectScope('http://10.204.0.1/spec', project)).toBe(false)
    expect(documentInProjectScope('http://docs.example.com/spec', project)).toBe(false)
  })

  test('cannot tell: no verdict', () => {
    expect(documentInProjectScope('not a url', { targetDomain: 'example.com' })).toBeNull()
    expect(documentInProjectScope('https://x.example.com/', {})).toBeNull()
  })
})
