/**
 * Replacing one Rules of Engagement document with another, as a proposal.
 *
 * A new document UNDOES what the old one changed, then applies itself:
 *
 *   the record      (client, contacts, dates, ...) is replaced wholesale: a
 *                   field the new document is silent on goes back to its default.
 *   everything else a key the new document sets takes its value. A key only the
 *                   previous document set goes back to what it was before ANY
 *                   document, unless someone changed it since, in which case it
 *                   is kept and said to be.
 *
 * `before` is inherited, never re-read: when the new document sets a key the
 * previous one also set, the value from before the previous document is carried
 * forward, so A -> B -> C still restores what the project had before A.
 *
 * Remove is a replace with an empty document.
 *
 * The STORED parse is never trusted. A settings save, an import and older
 * clients all wrote `roeParsedJson` unchecked, so a planted
 * `applied.targetDomain` must not make scope writable here: every stored key is
 * re-classified against today's registry and every stored value re-validated.
 *
 * Pure. No database, no network: the routes load the row and the defaults and
 * pass them in, which is what makes the rules testable one by one.
 *
 * There is no literal field-name list in this file, and there must never be
 * one. Which fields are the record, which are writable and which are safety
 * switches is asked of the registry.
 */
import { defaultFor } from '@/lib/project-preset-utils'
import { engagementRecordFields, field } from '@/lib/reconSettings/registry'
import {
  buildParseProposal,
  isParseWritable,
  parseValueProblem,
  sameValue,
  MAX_PROPOSED_CHANGES,
  type ParseRejection,
} from '@/lib/reconSettings/roeParse'
import { validateValue } from '@/lib/reconSettings/validators'
import { wideningReason } from './roeWidening'

export type ReplaceRowKind = 'set' | 'reset' | 'restore'

export interface ReplaceRow {
  key: string
  /** set: the new document's value. reset: a record field it is silent on. restore: undoing the previous document. */
  kind: ReplaceRowKind
  /** What the project holds now. */
  before: unknown
  after: unknown
  meaning: string
  section: string | null
  /** Why this row widens the engagement, when it does. */
  widening?: string
}

export interface KeptRow {
  key: string
  /** The value someone set after the previous document, which stays. */
  current: unknown
  /** What the previous document had set. */
  previousDocument: unknown
  meaning: string
  section: string | null
}

export interface ReplaceProposal {
  changes: ReplaceRow[]
  kept: KeptRow[]
  rejected: ParseRejection[]
  ignored: string[]
  /** Every valid value the new document states, changed or not: the next `applied`. */
  applied: Record<string, unknown>
  /** For each non-record key in `applied`: its value before any document. */
  before: Record<string, unknown>
  resets: string[]
  /** Stored keys or values rule 7 refused to honour. */
  droppedFromPrevious: string[]
  /** Rows that came from the model, the only ones the implausibility cap counts. */
  modelChangeCount: number
}

export interface StoredRoeParse {
  applied: Record<string, unknown>
  before: Record<string, unknown>
  dropped: string[]
}

const RECORD_KEYS = (): Set<string> => new Set(engagementRecordFields().filter(f => isParseWritable(f)).map(f => f.key))

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * What a stored `roeParsedJson` may still be believed about (rule 7).
 *
 * A key is honoured only while a document may write it TODAY, and only with a
 * value that passes today's validators and safety rules. `before` survives only
 * for honoured keys and only with a valid value; anything else falls back to the
 * default when it is restored.
 */
export function readStoredRoeParse(stored: unknown): StoredRoeParse {
  const out: StoredRoeParse = { applied: {}, before: {}, dropped: [] }
  if (!isObject(stored)) return out
  const version = typeof stored.version === 'number' ? stored.version : 1
  if (version > 2) {
    out.dropped.push('version')
    return out
  }
  const applied = isObject(stored.applied) ? stored.applied : {}
  for (const [key, value] of Object.entries(applied)) {
    const spec = field(key)
    if (!spec || !isParseWritable(spec) || value === null || value === undefined || parseValueProblem(key, spec, value)) {
      out.dropped.push(key)
      continue
    }
    out.applied[key] = value
  }
  const before = isObject(stored.before) ? stored.before : {}
  for (const [key, value] of Object.entries(before)) {
    const spec = field(key)
    if (!spec || !Object.prototype.hasOwnProperty.call(out.applied, key)) continue
    // A pre-document value was an operator's, so it is held to the field's
    // validator but not to the document-only safety rules.
    if (value === undefined || validateValue(key, spec, value, undefined)) {
      out.dropped.push(`before.${key}`)
      continue
    }
    out.before[key] = value
  }
  return out
}

export interface ReplaceInput {
  /** What the model read from the new document; `{}` to remove. */
  parsed: Record<string, unknown>
  /** The project's stored values (at least every parse-writable key). */
  current: Record<string, unknown>
  /** The stored `roeParsedJson`, whatever shape it has. */
  previous: unknown
  /** `/api/projects/defaults`, as a preset reset reads it. */
  defaults: Record<string, unknown>
}

export function buildReplaceProposal(input: ReplaceInput): ReplaceProposal {
  const { current, defaults } = input
  const parse = buildParseProposal(input.parsed, {})
  const applied: Record<string, unknown> = Object.fromEntries(parse.changes.map(c => [c.key, c.after]))
  const previous = readStoredRoeParse(input.previous)
  const recordKeys = RECORD_KEYS()

  const changes: ReplaceRow[] = []
  const kept: KeptRow[] = []
  const resets: string[] = []
  const before: Record<string, unknown> = {}
  const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k)
  const defaultOf = (key: string): { found: boolean; value: unknown } => {
    const d = defaultFor(key, defaults)
    return d.found ? { found: true, value: d.value } : { found: false, value: undefined }
  }
  const row = (key: string, kind: ReplaceRowKind, after: unknown): ReplaceRow => {
    const spec = field(key)!
    return { key, kind, before: current[key], after, meaning: spec.meaning, section: spec.form_section }
  }

  // Rule 2: the record is replaced wholesale.
  for (const key of [...recordKeys].sort()) {
    if (has(applied, key)) {
      if (!sameValue(current[key], applied[key])) changes.push(row(key, 'set', applied[key]))
      continue
    }
    const d = defaultOf(key)
    if (d.found && !sameValue(current[key], d.value)) {
      changes.push(row(key, 'reset', d.value))
      resets.push(key)
    }
  }

  // Rules 3 and 4: every other key either document touched.
  const others = new Set([...Object.keys(applied), ...Object.keys(previous.applied)].filter(k => !recordKeys.has(k)))
  for (const key of [...others].sort()) {
    const previouslySet = has(previous.applied, key)
    const preDocument = previouslySet
      ? (has(previous.before, key) ? previous.before[key] : defaultOf(key).value)
      : current[key]

    if (has(applied, key)) {
      before[key] = preDocument
      if (!sameValue(current[key], applied[key])) changes.push(row(key, 'set', applied[key]))
      continue
    }
    // Only the previous document set it.
    if (!sameValue(current[key], previous.applied[key])) {
      const spec = field(key)!
      kept.push({
        key, current: current[key], previousDocument: previous.applied[key],
        meaning: spec.meaning, section: spec.form_section,
      })
      continue
    }
    if (preDocument !== undefined && !sameValue(current[key], preDocument)) {
      changes.push(row(key, 'restore', preDocument))
    }
  }

  const afterRow = { ...current, ...Object.fromEntries(changes.map(c => [c.key, c.after])) }
  for (const c of changes) {
    const why = wideningReason(c.key, c.before, c.after, current, afterRow)
    if (why) c.widening = why
  }
  changes.sort((a, b) => a.key.localeCompare(b.key))

  return {
    changes,
    kept,
    rejected: parse.rejected,
    ignored: parse.ignored,
    applied,
    before,
    resets,
    droppedFromPrevious: previous.dropped,
    modelChangeCount: changes.filter(c => c.kind === 'set').length,
  }
}

/** The implausibility cap, counted on what the model proposed rather than on undo rows. */
export function replaceIsImplausible(proposal: ReplaceProposal): boolean {
  return proposal.modelChangeCount > MAX_PROPOSED_CHANGES
}

export const isWidening = (proposal: Pick<ReplaceProposal, 'changes'>): boolean =>
  proposal.changes.some(c => Boolean(c.widening))

/** The confirmed set a client sends back: every row's key and resulting value. */
export function changesMap(proposal: Pick<ReplaceProposal, 'changes'>): Record<string, unknown> {
  return Object.fromEntries(proposal.changes.map(c => [c.key, c.after]))
}

/** Do two confirmed sets describe the same write? */
export function sameChanges(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a).sort()
  const bk = Object.keys(b).sort()
  return ak.length === bk.length && ak.every((k, i) => k === bk[i] && sameValue(a[k], b[k]))
}

/**
 * May a confirmed set name this key at all? Rule 6, plus the honoured keys of
 * the previous document (a restore writes those).
 */
export function keyAllowedInChanges(key: string, previous: StoredRoeParse): boolean {
  const spec = field(key)
  if (!spec) return false
  if (isParseWritable(spec)) return true
  return Object.prototype.hasOwnProperty.call(previous.applied, key)
}

export interface RoeParsedJsonV2 {
  version: 2
  documentName: string
  mimeType: string
  bytesSha256: string
  textSha256: string
  modelUsed: string | null
  truncated: boolean
  appliedAt: string
  appliedById: string
  actingAdminId: string | null
  applied: Record<string, unknown>
  before: Record<string, unknown>
  kept: string[]
  resets: string[]
  rejected: ParseRejection[]
  ignored: string[]
  unknownKeys: string[]
}

/** The stored parse, built on the server only: no client value lands here unchecked. */
export function buildRoeParsedJson(args: {
  proposal: ReplaceProposal
  documentName: string
  mimeType: string
  bytesSha256: string
  textSha256: string
  modelUsed: string | null
  truncated: boolean
  appliedById: string
  actingAdminId: string | null
  unknownKeys?: string[]
  now?: Date
}): RoeParsedJsonV2 {
  const { proposal } = args
  return {
    version: 2,
    documentName: args.documentName,
    mimeType: args.mimeType,
    bytesSha256: args.bytesSha256,
    textSha256: args.textSha256,
    modelUsed: args.modelUsed,
    truncated: args.truncated,
    appliedAt: (args.now ?? new Date()).toISOString(),
    appliedById: args.appliedById,
    actingAdminId: args.actingAdminId,
    applied: proposal.applied,
    before: proposal.before,
    kept: proposal.kept.map(k => k.key),
    resets: proposal.resets,
    rejected: proposal.rejected,
    ignored: proposal.ignored,
    unknownKeys: (args.unknownKeys ?? []).filter(k => typeof k === 'string').slice(0, 200),
  }
}
