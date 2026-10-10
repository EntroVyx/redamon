/**
 * The line diff the review modal and the textDiff primitive draw (design §6 screen host):
 * Myers, O((N+M)·D), refusing more than TEXT_DIFF_MAX_LINES lines per side so a hostile
 * proposal cannot freeze the browser; the caller then shows both texts without highlights.
 */
import { describe, test, expect } from 'vitest'
import { TEXT_DIFF_MAX_EDITS, TEXT_DIFF_MAX_LINES, diffLines, splitLines, toSplitRows, type DiffOp } from './textDiff'

const types = (ops: DiffOp[]) => ops.map((o) => `${o.type[0]}:${o.text}`)

/** Rebuilds both sides from the ops: a diff is only right if it reproduces them. */
function sides(ops: DiffOp[]) {
  return {
    before: ops.filter((o) => o.type !== 'insert').map((o) => o.text),
    after: ops.filter((o) => o.type !== 'delete').map((o) => o.text),
  }
}

/** The minimal number of inserted plus deleted lines, by the textbook LCS table. */
function minimalEdits(a: string[], b: string[]): number {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1])
    }
  }
  return a.length + b.length - 2 * t[0][0]
}

describe('splitLines', () => {
  test('LF, CRLF and CR all split; a final newline ends the last line instead of adding one', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b'])
    expect(splitLines('a\rb')).toEqual(['a', 'b'])
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b'])
  })

  test('empty text has no lines', () => {
    expect(splitLines('')).toEqual([])
  })
})

describe('diffLines on known inputs', () => {
  test('identical texts: every line equal', () => {
    const r = diffLines('one\ntwo', 'one\ntwo')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(types(r.ops)).toEqual(['e:one', 'e:two'])
  })

  test('an inserted line', () => {
    const r = diffLines('a\nc', 'a\nb\nc')
    if (!r.ok) throw new Error('refused')
    expect(types(r.ops)).toEqual(['e:a', 'i:b', 'e:c'])
  })

  test('a deleted line', () => {
    const r = diffLines('a\nb\nc', 'a\nc')
    if (!r.ok) throw new Error('refused')
    expect(types(r.ops)).toEqual(['e:a', 'd:b', 'e:c'])
  })

  test('a changed line is a delete then an insert', () => {
    const r = diffLines('a\nold\nc', 'a\nnew\nc')
    if (!r.ok) throw new Error('refused')
    expect(types(r.ops)).toEqual(['e:a', 'd:old', 'i:new', 'e:c'])
  })

  test('from and to empty text', () => {
    const add = diffLines('', 'x\ny')
    const del = diffLines('x\ny', '')
    const none = diffLines('', '')
    if (!add.ok || !del.ok || !none.ok) throw new Error('refused')
    expect(types(add.ops)).toEqual(['i:x', 'i:y'])
    expect(types(del.ops)).toEqual(['d:x', 'd:y'])
    expect(none.ops).toEqual([])
  })

  test('CRLF against LF of the same text shows no change', () => {
    const r = diffLines('a\r\nb\r\n', 'a\nb\n')
    if (!r.ok) throw new Error('refused')
    expect(r.ops.every((o) => o.type === 'equal')).toBe(true)
  })

  test('line numbers are 1-based and per side', () => {
    const r = diffLines('a\nb', 'a\nx\nb')
    if (!r.ok) throw new Error('refused')
    expect(r.ops).toEqual([
      { type: 'equal', text: 'a', beforeLine: 1, afterLine: 1 },
      { type: 'insert', text: 'x', beforeLine: null, afterLine: 2 },
      { type: 'equal', text: 'b', beforeLine: 2, afterLine: 3 },
    ])
  })
})

describe('diffLines is correct and minimal', () => {
  // Deterministic pseudo-random inputs over a tiny alphabet, so lines repeat and the
  // diff has real choices to make.
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const text = () => Array.from({ length: Math.floor(rand() * 12) }, () => 'abcd'[Math.floor(rand() * 4)])

  test('200 random pairs: the ops rebuild both sides with the fewest edits', () => {
    for (let n = 0; n < 200; n++) {
      const a = text()
      const b = text()
      const r = diffLines(a.join('\n'), b.join('\n'))
      if (!r.ok) throw new Error('refused')
      expect(sides(r.ops)).toEqual({ before: a, after: b })
      expect(r.ops.filter((o) => o.type !== 'equal').length).toBe(minimalEdits(a, b))
    }
  })
})

describe('the size guard', () => {
  test(`more than ${TEXT_DIFF_MAX_LINES} lines on one side is refused`, () => {
    const big = Array.from({ length: TEXT_DIFF_MAX_LINES + 1 }, (_, i) => `l${i}`).join('\n')
    expect(diffLines(big, 'x')).toEqual({ ok: false, reason: 'too_large' })
    expect(diffLines('x', big)).toEqual({ ok: false, reason: 'too_large' })
  })

  test(`two unrelated texts needing more than ${TEXT_DIFF_MAX_EDITS} edits are refused, quickly`, () => {
    const a = Array.from({ length: TEXT_DIFF_MAX_EDITS }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: TEXT_DIFF_MAX_EDITS }, (_, i) => `b${i}`).join('\n')
    const t0 = performance.now()
    expect(diffLines(a, b)).toEqual({ ok: false, reason: 'too_different' })
    expect(performance.now() - t0).toBeLessThan(5_000)
  })

  test(`exactly ${TEXT_DIFF_MAX_EDITS} edits is still diffed`, () => {
    const half = TEXT_DIFF_MAX_EDITS / 2
    const a = Array.from({ length: half }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: half }, (_, i) => `b${i}`).join('\n')
    const r = diffLines(a, b)
    if (!r.ok) throw new Error('refused')
    expect(r.ops.length).toBe(TEXT_DIFF_MAX_EDITS)
  })

  test(`exactly ${TEXT_DIFF_MAX_LINES} lines with one change is diffed`, () => {
    const lines = Array.from({ length: TEXT_DIFF_MAX_LINES }, (_, i) => `l${i}`)
    const changed = [...lines]
    changed[5000] = 'changed'
    const r = diffLines(lines.join('\n'), changed.join('\n'))
    if (!r.ok) throw new Error('refused')
    expect(r.ops.filter((o) => o.type !== 'equal').map((o) => o.text)).toEqual(['l5000', 'changed'])
  })
})

describe('toSplitRows', () => {
  test('pairs a run of deletes with the inserts after it; equal lines sit on both sides', () => {
    const r = diffLines('a\nb\nc\nd', 'a\nB\nC\nX\nd')
    if (!r.ok) throw new Error('refused')
    const rows = toSplitRows(r.ops)
    expect(rows.map((row) => [row.left?.text ?? null, row.right?.text ?? null])).toEqual([
      ['a', 'a'],
      ['b', 'B'],
      ['c', 'C'],
      [null, 'X'],
      ['d', 'd'],
    ])
    expect(rows.map((row) => row.changeStart)).toEqual([false, true, false, false, false])
  })
})
