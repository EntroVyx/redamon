/**
 * The replace rules (roe_fix_plan.md §2), one by one, on the pure engine.
 *
 * `apply` below plays the route: it writes the proposal's rows over the row and
 * stores the server-built parse, so a sequence of documents can be followed the
 * way the database would see it.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'

import { engagementLimitFields, engagementRecordFields, field } from '@/lib/reconSettings/registry'
import { MAX_PROPOSED_CHANGES } from '@/lib/reconSettings/roeParse'
import {
  buildReplaceProposal,
  buildRoeParsedJson,
  changesMap,
  isWidening,
  keyAllowedInChanges,
  readStoredRoeParse,
  replaceIsImplausible,
  sameChanges,
  type ReplaceProposal,
} from './roeReplace'
import { directionOf, wideningReason } from './roeWidening'

const D = (key: string) => field(key)!.default

/** A project row with the whole record, and every other key these tests touch, at its default. */
function freshRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const f of engagementRecordFields()) row[f.key] = f.default
  for (const key of [
    'roeClientName', 'roeClientContactName', 'roeAllowProductionTesting', 'roeEngagementEndDate',
    'roeEngagementStartDate', 'roeGlobalMaxRps', 'roeExcludedHosts', 'roeForbiddenTools',
    'naabuRateLimit', 'nucleiEnabled', 'katanaDepth', 'agentRequireToolConfirmation',
    'roeTimeWindowEnabled', 'roeTimeWindowDays', 'roeTimeWindowStartTime', 'roeTimeWindowEndTime',
  ]) row[key] = D(key)
  return { ...row, ...over }
}

interface State { row: Record<string, unknown>; stored: unknown }

function apply(state: State, proposal: ReplaceProposal): State {
  return {
    row: { ...state.row, ...changesMap(proposal) },
    stored: buildRoeParsedJson({
      proposal, documentName: 'doc.pdf', mimeType: 'application/pdf',
      bytesSha256: 'a'.repeat(64), textSha256: 'b'.repeat(64), modelUsed: 'm', truncated: false,
      appliedById: 'u1', actingAdminId: null,
    }),
  }
}

function replace(state: State, parsed: Record<string, unknown>): ReplaceProposal {
  return buildReplaceProposal({ parsed, current: state.row, previous: state.stored, defaults: {} })
}

const keysOf = (p: ReplaceProposal, kind?: string) =>
  p.changes.filter(c => !kind || c.kind === kind).map(c => c.key)

describe('rule 2: the record is replaced wholesale', () => {
  test('a record field the new document is silent on goes back to its default', () => {
    let s: State = { row: freshRow(), stored: null }
    s = apply(s, replace(s, { roeClientName: 'Northwind', roeClientContactName: 'Alex' }))
    expect(s.row.roeClientName).toBe('Northwind')

    const p = replace(s, { roeClientName: 'Northwind' })
    expect(keysOf(p, 'reset')).toEqual(['roeClientContactName'])
    expect(p.resets).toEqual(['roeClientContactName'])
    expect(changesMap(p).roeClientContactName).toBe(D('roeClientContactName'))
  })

  test('a record value equal to the new one is not a change', () => {
    const s: State = { row: freshRow({ roeClientName: 'Northwind' }), stored: null }
    expect(keysOf(replace(s, { roeClientName: 'Northwind' }))).toEqual([])
  })
})

describe('rule 3: other keys', () => {
  test('a key the new document sets takes its value', () => {
    const s: State = { row: freshRow({ naabuRateLimit: 100 }), stored: null }
    const p = replace(s, { naabuRateLimit: 10 })
    expect(p.changes).toEqual([expect.objectContaining({ key: 'naabuRateLimit', kind: 'set', before: 100, after: 10 })])
    expect(p.before).toEqual({ naabuRateLimit: 100 })
  })

  test('a key only the previous document set is restored to its value before that document', () => {
    let s: State = { row: freshRow({ naabuRateLimit: 100 }), stored: null }
    s = apply(s, replace(s, { naabuRateLimit: 10 }))
    const p = replace(s, {})
    expect(p.changes).toEqual([expect.objectContaining({ key: 'naabuRateLimit', kind: 'restore', after: 100 })])
  })

  test('a value someone changed after the previous document is kept, and listed', () => {
    let s: State = { row: freshRow({ naabuRateLimit: 100 }), stored: null }
    s = apply(s, replace(s, { naabuRateLimit: 10 }))
    s = { ...s, row: { ...s.row, naabuRateLimit: 25 } } // an MCP agent or a person
    const p = replace(s, {})
    expect(keysOf(p)).not.toContain('naabuRateLimit')
    expect(p.kept).toEqual([expect.objectContaining({ key: 'naabuRateLimit', current: 25, previousDocument: 10 })])
  })

  test('a key neither document set is untouched', () => {
    const s: State = { row: freshRow({ katanaDepth: 4 }), stored: null }
    expect(keysOf(replace(s, { naabuRateLimit: 10 }))).toEqual(['naabuRateLimit'])
  })

  test('a legacy stored parse with no `before` restores the default', () => {
    const s: State = {
      row: freshRow({ naabuRateLimit: 10 }),
      stored: { applied: { naabuRateLimit: 10 }, rejected: [], ignored: [] },
    }
    const p = replace(s, {})
    expect(p.changes).toEqual([expect.objectContaining({ key: 'naabuRateLimit', kind: 'restore', after: D('naabuRateLimit') })])
  })
})

describe('rule 4: before is inherited, never re-read', () => {
  test('A -> A -> B -> C still restores the value from before A', () => {
    let s: State = { row: freshRow({ naabuRateLimit: 100 }), stored: null }
    s = apply(s, replace(s, { naabuRateLimit: 10 })) // A
    s = apply(s, replace(s, { naabuRateLimit: 10 })) // A again
    expect((s.stored as { before: Record<string, unknown> }).before.naabuRateLimit).toBe(100)
    s = apply(s, replace(s, { naabuRateLimit: 20 })) // B
    expect((s.stored as { before: Record<string, unknown> }).before.naabuRateLimit).toBe(100)
    const c = replace(s, {}) // C, silent on it
    expect(changesMap(c).naabuRateLimit).toBe(100)
  })
})

describe('rule 5: lists are replaced, not merged', () => {
  test('the new list is the list', () => {
    let s: State = { row: freshRow(), stored: null }
    s = apply(s, replace(s, { roeExcludedHosts: ['a.roe-e2e.example', 'b.roe-e2e.example'] }))
    const p = replace(s, { roeExcludedHosts: ['b.roe-e2e.example'] })
    expect(changesMap(p).roeExcludedHosts).toEqual(['b.roe-e2e.example'])
  })
})

describe('rules 6 and 7: what a document, or a stored parse, may write', () => {
  test('a scope key in the model output is ignored', () => {
    const p = replace({ row: freshRow(), stored: null }, { targetDomain: 'evil.example', naabuRateLimit: 5 })
    expect(keysOf(p)).toEqual(['naabuRateLimit'])
    expect(p.ignored).toContain('targetDomain')
  })

  test('a planted applied.targetDomain is dropped, never restored or allowed', () => {
    const stored = { version: 2, applied: { targetDomain: 'evil.example', naabuRateLimit: 10 }, before: { targetDomain: 'x' } }
    const read = readStoredRoeParse(stored)
    expect(read.applied).toEqual({ naabuRateLimit: 10 })
    expect(read.dropped).toContain('targetDomain')
    expect(keyAllowedInChanges('targetDomain', read)).toBe(false)
    const p = replace({ row: freshRow({ naabuRateLimit: 10 }), stored }, {})
    expect(keysOf(p)).not.toContain('targetDomain')
  })

  test('a stored value that fails validation is dropped', () => {
    const read = readStoredRoeParse({ applied: { naabuRateLimit: 'fast', katanaDepth: 3 } })
    expect(read.applied).toEqual({ katanaDepth: 3 })
  })

  test('a stored unsafe value for a tighten-only switch is not honoured', () => {
    const read = readStoredRoeParse({ applied: { agentRequireToolConfirmation: false } })
    expect(read.applied).toEqual({})
  })

  test('a denied key is never allowed in a confirmed set', () => {
    expect(keyAllowedInChanges('agentLhost', readStoredRoeParse(null))).toBe(false)
    expect(keyAllowedInChanges('naabuRateLimit', readStoredRoeParse(null))).toBe(true)
  })

  test('a stored parse from a future version is not read at all', () => {
    expect(readStoredRoeParse({ version: 3, applied: { katanaDepth: 3 } }).applied).toEqual({})
  })
})

describe('rule 8: remove', () => {
  test('the record goes to defaults and what the document set is restored', () => {
    let s: State = { row: freshRow({ naabuRateLimit: 100 }), stored: null }
    s = apply(s, replace(s, { roeClientName: 'Northwind', roeGlobalMaxRps: 5, naabuRateLimit: 10 }))
    const p = replace(s, {})
    expect(changesMap(p)).toEqual({
      roeClientName: D('roeClientName'),
      roeGlobalMaxRps: D('roeGlobalMaxRps'),
      naabuRateLimit: 100,
    })
  })
})

describe('widening', () => {
  test('removing or raising the ceiling widens; setting one does not', () => {
    expect(wideningReason('roeGlobalMaxRps', 5, 0)).toMatch(/removes/)
    expect(wideningReason('roeGlobalMaxRps', 5, 20)).toMatch(/raises/)
    expect(wideningReason('roeGlobalMaxRps', 0, 5)).toBeNull()
    expect(wideningReason('roeGlobalMaxRps', 20, 5)).toBeNull()
  })

  test('removing an excluded host or a forbidden tool widens; adding one does not', () => {
    expect(wideningReason('roeExcludedHosts', ['a', 'b'], ['b'])).toMatch(/removes a/)
    expect(wideningReason('roeExcludedHosts', ['b'], ['a', 'b'])).toBeNull()
    expect(wideningReason('roeForbiddenTools', ['execute_hydra'], [])).toMatch(/execute_hydra/)
  })

  test('the window: off widens, more days and longer hours widen, but only while it is on', () => {
    const on = { roeTimeWindowEnabled: true }
    expect(wideningReason('roeTimeWindowEnabled', true, false)).toMatch(/turns off/)
    expect(wideningReason('roeTimeWindowDays', ['monday'], ['monday', 'saturday'], on, on)).toMatch(/saturday/)
    expect(wideningReason('roeTimeWindowDays', ['monday', 'tuesday'], ['monday'], on, on)).toBeNull()
    expect(wideningReason('roeTimeWindowStartTime', '09:00', '08:00', on, on)).toMatch(/earlier/)
    expect(wideningReason('roeTimeWindowEndTime', '18:00', '20:00', on, on)).toMatch(/later/)
    expect(wideningReason('roeTimeWindowEndTime', '18:00', '20:00', {}, on)).toBeNull()
  })

  test('a later phase, any allow flag on and a tool turned on widen', () => {
    expect(wideningReason('roeMaxSeverityPhase', 'exploitation', 'post_exploitation')).toMatch(/phase/)
    expect(wideningReason('roeMaxSeverityPhase', 'post_exploitation', 'informational')).toBeNull()
    expect(wideningReason('roeAllowDos', false, true)).toBeTruthy()
    expect(wideningReason('nucleiEnabled', false, true)).toBeTruthy()
    expect(wideningReason('nucleiEnabled', true, false)).toBeNull()
  })

  test('resetting roeAllowProductionTesting widens, because its default is true', () => {
    expect(D('roeAllowProductionTesting')).toBe(true)
    let s: State = { row: freshRow(), stored: null }
    s = apply(s, replace(s, { roeAllowProductionTesting: false }))
    const p = replace(s, {})
    const row = p.changes.find(c => c.key === 'roeAllowProductionTesting')!
    expect(row.kind).toBe('reset')
    expect(row.widening).toBeTruthy()
    expect(isWidening(p)).toBe(true)
  })

  test('the engagement dates: a later end or an earlier start widens, and so does clearing one', () => {
    expect(wideningReason('roeEngagementEndDate', '2026-11-27', '2026-12-18')).toMatch(/later/)
    expect(wideningReason('roeEngagementEndDate', '2026-11-27', '')).toBeTruthy()
    expect(wideningReason('roeEngagementEndDate', '2026-11-27', '2026-11-20')).toBeNull()
    expect(wideningReason('roeEngagementStartDate', '2026-11-02', '2026-10-01')).toMatch(/earlier/)
  })

  test('restoring a safety switch below its safe value widens', () => {
    let s: State = { row: freshRow({ agentRequireToolConfirmation: false }), stored: null }
    s = apply(s, replace(s, { agentRequireToolConfirmation: true }))
    const p = replace(s, {})
    const row = p.changes.find(c => c.key === 'agentRequireToolConfirmation')!
    expect(row).toMatchObject({ kind: 'restore', after: false })
    expect(row.widening).toMatch(/safety/)
  })

  test('every engagement limit has a direction, so a new one cannot slip through unjudged', () => {
    const missing = engagementLimitFields()
      .filter(f => f.key !== 'roeEnabled' && directionOf(f.key) === undefined)
      .map(f => f.key)
    expect(missing).toEqual([])
  })
})

describe('the implausibility cap counts only what the model proposed', () => {
  test('undo rows do not count toward it', () => {
    const p = replace({ row: freshRow(), stored: null }, { naabuRateLimit: 5 })
    expect(p.modelChangeCount).toBe(1)
    expect(replaceIsImplausible({ ...p, modelChangeCount: MAX_PROPOSED_CHANGES })).toBe(false)
    expect(replaceIsImplausible({ ...p, modelChangeCount: MAX_PROPOSED_CHANGES + 1 })).toBe(true)
    // A remove of a big document is all resets and restores, and never implausible.
    let s: State = { row: freshRow(), stored: null }
    s = apply(s, replace(s, { roeClientName: 'N', roeGlobalMaxRps: 5, naabuRateLimit: 3 }))
    expect(replace(s, {}).modelChangeCount).toBe(0)
  })
})

describe('the confirmed set', () => {
  test('sameChanges compares keys and values structurally', () => {
    expect(sameChanges({ a: [1, 2], b: 1 }, { b: 1, a: [1, 2] })).toBe(true)
    expect(sameChanges({ a: [1, 2] }, { a: [2, 1] })).toBe(false)
    expect(sameChanges({ a: 1 }, { a: 1, b: 2 })).toBe(false)
  })

  test('the stored parse is v2 and carries kept and resets', () => {
    let s: State = { row: freshRow({ naabuRateLimit: 100 }), stored: null }
    s = apply(s, replace(s, { naabuRateLimit: 10, roeClientContactName: 'A' }))
    s = { ...s, row: { ...s.row, naabuRateLimit: 25 } }
    const p = replace(s, { roeClientName: 'N' })
    const stored = apply(s, p).stored as Record<string, unknown>
    expect(stored).toMatchObject({ version: 2, kept: ['naabuRateLimit'], resets: ['roeClientContactName'] })
    expect(stored.applied).toEqual({ roeClientName: 'N' })
  })
})
