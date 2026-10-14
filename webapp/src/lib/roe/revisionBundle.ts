/**
 * Superseded RoE documents in a project export, and back.
 *
 * A bundle is untrusted on the way in: each revision is held to the same limits
 * as an upload, its hashes are recomputed from the bytes and the text it brings,
 * its stored parse is sanitized like the project's own, and the users it names
 * (who superseded it) belonged to the exporting install, so the importer is
 * recorded instead.
 */
import { roeTextDigest } from '@/lib/engagement'
import { cleanRoeFileName, sanitizeImportedRoeParsedJson } from './createRoe'
import { sha256Hex } from './extractText'
import { MAX_FILE_SIZE, MAX_TEXT_CHARS, canonicalMimeType, classifyRoeFile } from './limits'

export const REVISIONS_BUNDLE_PATH = 'engagement/roe-revisions.json'
export const MAX_IMPORTED_REVISIONS = 10

export interface ExportedRevision {
  documentName: string
  mimeType: string
  dataBase64: string | null
  rawText: string
  parsedJson: unknown
  appliedAt: string | null
  supersededAt: string
  reason: string
}

export function exportRevision(row: {
  documentName: string
  mimeType: string
  data: Uint8Array | null
  rawText: string
  parsedJson: unknown
  appliedAt: Date | null
  supersededAt: Date
  reason: string
}): ExportedRevision {
  return {
    documentName: row.documentName,
    mimeType: row.mimeType,
    dataBase64: row.data ? Buffer.from(row.data).toString('base64') : null,
    rawText: row.rawText,
    parsedJson: row.parsedJson ?? null,
    appliedAt: row.appliedAt ? row.appliedAt.toISOString() : null,
    supersededAt: row.supersededAt.toISOString(),
    reason: row.reason,
  }
}

const dateOr = (v: unknown, fallback: Date | null): Date | null => {
  if (typeof v !== 'string') return fallback
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? fallback : d
}

/** The create data for one imported revision, or null when it is not one. */
export function importRevision(
  raw: unknown,
  ctx: { projectId: string; importerUserId: string },
) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const documentName = cleanRoeFileName(typeof r.documentName === 'string' ? r.documentName : '')
  const kind = classifyRoeFile(documentName, typeof r.mimeType === 'string' ? r.mimeType : '')

  let data: Buffer | null = null
  if (typeof r.dataBase64 === 'string' && r.dataBase64) {
    data = Buffer.from(r.dataBase64, 'base64')
    if (data.length === 0 || data.length > MAX_FILE_SIZE) return null
  }
  const rawText = typeof r.rawText === 'string' ? r.rawText.slice(0, MAX_TEXT_CHARS) : ''
  if (!data && !rawText) return null

  const parsed = sanitizeImportedRoeParsedJson(r.parsedJson, { roeRawText: rawText, roeDocumentData: data })
  return {
    projectId: ctx.projectId,
    documentName,
    mimeType: kind ? canonicalMimeType(kind) : '',
    data: data ? new Uint8Array(data) : null,
    bytesSha256: data ? sha256Hex(data) : '',
    textSha256: roeTextDigest(rawText) ?? '',
    rawText,
    parsedJson: parsed,
    appliedAt: dateOr(r.appliedAt, null),
    supersededAt: dateOr(r.supersededAt, new Date()) as Date,
    supersededById: ctx.importerUserId,
    reason: r.reason === 'removed' ? 'removed' : 'replaced',
  }
}
