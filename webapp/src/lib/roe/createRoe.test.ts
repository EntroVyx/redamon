/**
 * The RoE artefacts a create stores, and the parse an import may bring: both
 * rebuilt on the server, neither trusted as sent.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'

import { digestScopeDocument } from '@/lib/engagement'
import { buildCreateRoeArtefacts, cleanRoeFileName, sanitizeImportedRoeParsedJson, stripRoeArtefacts } from './createRoe'

const DOC = { text: 'RoE', pages: 1, truncated: false, bytesSha256: 'a'.repeat(64), textSha256: digestScopeDocument('RoE') }

describe('buildCreateRoeArtefacts', () => {
  test('keeps only confirmed keys a document may write, with valid values', () => {
    const out = buildCreateRoeArtefacts({
      doc: DOC,
      file: { name: 'roe.pdf', kind: 'pdf', bytes: Buffer.from('x') },
      clientParsed: {
        applied: { roeGlobalMaxRps: 5, roeClientName: 'N', targetDomain: 'evil.example', naabuRateLimit: 'fast', agentGuardrailEnabled: false },
        before: { roeGlobalMaxRps: 0, roeClientName: 'old', naabuRateLimit: 3 },
      },
      appliedById: 'u1',
      actingAdminId: null,
    })
    const parsed = out.roeParsedJson as Record<string, unknown>
    expect(parsed.applied).toEqual({ roeGlobalMaxRps: 5, roeClientName: 'N' })
    // The record is replaced wholesale, so it needs no `before`.
    expect(parsed.before).toEqual({ roeGlobalMaxRps: 0 })
    expect(out.roeRawText).toBe('RoE')
    expect(out.roeDocumentMimeType).toBe('application/pdf')
  })
})

describe('stripRoeArtefacts and cleanRoeFileName', () => {
  test('a body loses every artefact; a filename loses control characters', () => {
    const body: Record<string, unknown> = { roeRawText: 'x', roeParsedJson: {}, roeDocumentName: 'a', katanaDepth: 2 }
    stripRoeArtefacts(body)
    expect(body).toEqual({ katanaDepth: 2 })
    expect(cleanRoeFileName('a\r\nb.pdf')).toBe('ab.pdf')
    expect(cleanRoeFileName('   ')).toBe('roe-document')
  })
})

describe('sanitizeImportedRoeParsedJson', () => {
  test('a planted scope key and a denied key are dropped; hashes are recomputed', () => {
    const out = sanitizeImportedRoeParsedJson(
      { version: 2, applied: { targetDomain: 'evil.example', agentLhost: '203.0.113.9', roeGlobalMaxRps: 5 }, before: { roeGlobalMaxRps: 0 }, textSha256: '0'.repeat(64), appliedById: 'someone-elsewhere' },
      { roeRawText: 'the imported text', roeDocumentData: null },
    )!
    expect(out.applied).toEqual({ roeGlobalMaxRps: 5 })
    expect(out.before).toEqual({ roeGlobalMaxRps: 0 })
    expect(out.textSha256).toBe(digestScopeDocument('the imported text'))
    expect(out.appliedById).toBeNull()
  })

  test('a later format is dropped whole, and a non-object is nothing', () => {
    expect(sanitizeImportedRoeParsedJson({ version: 3, applied: { roeGlobalMaxRps: 5 } }, {})).toBeNull()
    expect(sanitizeImportedRoeParsedJson('x', {})).toBeNull()
  })
})
