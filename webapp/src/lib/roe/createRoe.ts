/**
 * The RoE artefacts of a project being CREATED, built on the server.
 *
 * The create form sends the document file beside the settings, and it used to
 * send the document's text and parse too, stored as they arrived: a client could
 * plant `roeParsedJson.applied.targetDomain`, which a later replace would then
 * have honoured as "what the previous document set", or store text that is not
 * the document's. Now the text is the server's own extraction and the parse is
 * rebuilt from the client's CONFIRMED keys, filtered and re-validated exactly as
 * a replace would filter them.
 */
import { field } from '@/lib/reconSettings/registry'
import { isParseWritable, parseValueProblem, type ParseRejection } from '@/lib/reconSettings/roeParse'
import { validateValue } from '@/lib/reconSettings/validators'
import { digestScopeDocument } from '@/lib/engagement'
import { sha256Hex as sha256OfBytes, type ExtractedDocument } from './extractText'
import { canonicalMimeType, MAX_MODEL_CHARS, type RoeFileKind } from './limits'
import type { RoeParsedJsonV2 } from './roeReplace'

/** Every column only an upload may write. A create without a document writes none. */
export const ROE_ARTEFACT_KEYS = ['roeDocumentData', 'roeDocumentName', 'roeDocumentMimeType', 'roeRawText', 'roeParsedJson'] as const

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

export function stripRoeArtefacts(params: Record<string, unknown>): void {
  for (const key of ROE_ARTEFACT_KEYS) delete params[key]
}

/** A stored filename, kept readable and bounded: it reaches headers and the report. */
export function cleanRoeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 255)
  return clean || 'roe-document'
}

const shortStrings = (v: unknown, cap = 200): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length <= 200).slice(0, cap) : []

export function buildCreateRoeArtefacts(args: {
  doc: ExtractedDocument
  file: { name: string; kind: RoeFileKind; bytes: Buffer }
  /** What the form sent as roeParsedJson: at most `applied`, `before`, `modelUsed`, ... */
  clientParsed: unknown
  appliedById: string
  actingAdminId: string | null
  now?: Date
}): Record<string, unknown> {
  const client = isObject(args.clientParsed) ? args.clientParsed : {}
  const clientApplied = isObject(client.applied) ? client.applied : {}
  const clientBefore = isObject(client.before) ? client.before : {}

  const applied: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(clientApplied)) {
    const spec = field(key)
    if (!spec || !isParseWritable(spec) || value === null || value === undefined) continue
    if (parseValueProblem(key, spec, value)) continue
    applied[key] = value
  }
  const recordKeys = new Set(Object.keys(applied).filter(k => field(k)?.deny_reason === 'engagement-record'))
  const before: Record<string, unknown> = {}
  for (const key of Object.keys(applied)) {
    if (recordKeys.has(key) || !Object.prototype.hasOwnProperty.call(clientBefore, key)) continue
    const value = clientBefore[key]
    const spec = field(key)!
    if (value !== undefined && !validateValue(key, spec, value, undefined)) before[key] = value
  }

  const rejected: ParseRejection[] = Array.isArray(client.rejected)
    ? client.rejected
        .filter((r): r is Record<string, unknown> => isObject(r) && typeof r.key === 'string' && typeof r.why === 'string')
        .slice(0, 200)
        .map(r => ({ key: String(r.key).slice(0, 200), value: null, why: String(r.why).slice(0, 500) }))
    : []

  const name = cleanRoeFileName(args.file.name)
  const mimeType = canonicalMimeType(args.file.kind)
  const parsed: RoeParsedJsonV2 = {
    version: 2,
    documentName: name,
    mimeType,
    bytesSha256: args.doc.bytesSha256,
    textSha256: args.doc.textSha256,
    modelUsed: typeof client.modelUsed === 'string' ? client.modelUsed.slice(0, 200) : null,
    truncated: args.doc.truncated || args.doc.text.length > MAX_MODEL_CHARS,
    appliedAt: (args.now ?? new Date()).toISOString(),
    appliedById: args.appliedById,
    actingAdminId: args.actingAdminId,
    applied,
    before,
    kept: [],
    resets: [],
    rejected,
    ignored: shortStrings(client.ignored),
    unknownKeys: shortStrings(client.unknownKeys),
  }

  return {
    roeDocumentData: new Uint8Array(args.file.bytes),
    roeDocumentName: name,
    roeDocumentMimeType: mimeType,
    roeRawText: args.doc.text,
    roeParsedJson: parsed,
  }
}

/**
 * An imported bundle's `roeParsedJson`, reduced to what may be believed.
 *
 * The bundle is untrusted, and a stored parse is what the next replace reads as
 * "what the previous document set": a planted `applied.targetDomain` would be
 * honoured there. Only keys a document may write today survive, with values
 * that pass today's validators; a parse from a later format is dropped whole;
 * the hashes are recomputed from the imported bytes and text rather than copied.
 */
export function sanitizeImportedRoeParsedJson(
  stored: unknown,
  imported: { roeRawText?: unknown; roeDocumentData?: Uint8Array | null },
): Record<string, unknown> | null {
  if (!isObject(stored)) return null
  const version = typeof stored.version === 'number' ? stored.version : 1
  if (version > 2) return null

  const applied: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(isObject(stored.applied) ? stored.applied : {})) {
    const spec = field(key)
    if (!spec || !isParseWritable(spec) || value === null || value === undefined) continue
    if (parseValueProblem(key, spec, value)) continue
    applied[key] = value
  }
  const before: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(isObject(stored.before) ? stored.before : {})) {
    const spec = field(key)
    if (!spec || !Object.prototype.hasOwnProperty.call(applied, key) || value === undefined) continue
    if (!validateValue(key, spec, value, undefined)) before[key] = value
  }
  const known = (v: unknown) => shortStrings(v).filter(k => field(k) !== undefined)
  const text = typeof imported.roeRawText === 'string' && imported.roeRawText ? imported.roeRawText : null
  const str = (v: unknown, cap: number) => (typeof v === 'string' ? v.slice(0, cap) : null)
  const appliedAt = typeof stored.appliedAt === 'string' && !Number.isNaN(Date.parse(stored.appliedAt)) ? stored.appliedAt : null

  return {
    version: 2,
    documentName: str(stored.documentName, 255),
    mimeType: str(stored.mimeType, 200),
    bytesSha256: imported.roeDocumentData ? sha256OfBytes(imported.roeDocumentData) : null,
    textSha256: text ? digestScopeDocument(text) : null,
    modelUsed: str(stored.modelUsed, 200),
    truncated: stored.truncated === true,
    appliedAt,
    applied,
    before,
    kept: known(stored.kept),
    resets: known(stored.resets),
    rejected: [],
    ignored: shortStrings(stored.ignored),
    unknownKeys: shortStrings(stored.unknownKeys),
    // Who applied it, and the admin behind them, were users of the EXPORTING
    // install; their ids mean nothing here.
    appliedById: null,
    actingAdminId: null,
  }
}
