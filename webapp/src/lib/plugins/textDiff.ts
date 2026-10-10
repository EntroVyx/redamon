/**
 * Line diff for the review modal and the `textDiff` screen primitive: Myers' greedy
 * algorithm, O((N+M)·D) time. Proposals are plugin-supplied text, so input is capped at
 * TEXT_DIFF_MAX_LINES lines per side; past that the caller shows both texts without
 * highlights rather than freezing the tab.
 *
 * Memory is O(D²): the common prefix and suffix are trimmed first (most proposals touch a
 * few lines), and each step snapshots only the diagonals it can reach, k ∈ [-d-1, d+1].
 * D is capped at TEXT_DIFF_MAX_EDITS (~16 MB of snapshots): two unrelated 20,000-line
 * texts would otherwise need gigabytes. Past the cap the text is a rewrite, and the same
 * no-highlights fallback applies.
 */
export const TEXT_DIFF_MAX_LINES = 20_000
export const TEXT_DIFF_MAX_EDITS = 2_000

export type DiffOpType = 'equal' | 'insert' | 'delete'

export interface DiffOp {
  type: DiffOpType
  text: string
  /** 1-based; null for an inserted line. */
  beforeLine: number | null
  /** 1-based; null for a deleted line. */
  afterLine: number | null
}

export type DiffResult = { ok: true; ops: DiffOp[] } | { ok: false; reason: 'too_large' | 'too_different' }

/**
 * Lines of a text. CRLF and CR count as LF, so a line-ending change alone shows no diff;
 * a final newline ends the last line rather than starting an empty one.
 */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r\n|\r|\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

type Edit = 'equal' | 'insert' | 'delete'

/** The shortest edit script turning `a` into `b`, one entry per line; null past the edit cap. */
function myers(a: string[], b: string[]): Edit[] | null {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return []
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  // trace[d] is v as it stood before step d, over k ∈ [-d-1, d+1]: all backtracking reads.
  const trace: Int32Array[] = []
  let done = -1
  outer: for (let d = 0; d <= Math.min(max, TEXT_DIFF_MAX_EDITS); d++) {
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        done = d
        break outer
      }
    }
  }
  if (done < 0) return null

  const edits: Edit[] = []
  let x = n
  let y = m
  for (let d = done; d >= 0; d--) {
    const snap = trace[d]
    const at = (k: number) => snap[k + d + 1]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      edits.push('equal')
      x--
      y--
    }
    if (d > 0) edits.push(x === prevX ? 'insert' : 'delete')
    x = prevX
    y = prevY
  }
  return edits.reverse()
}

export function diffLines(before: string, after: string): DiffResult {
  const a = splitLines(before)
  const b = splitLines(after)
  if (a.length > TEXT_DIFF_MAX_LINES || b.length > TEXT_DIFF_MAX_LINES) return { ok: false, reason: 'too_large' }

  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++

  const middle = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf))
  if (!middle) return { ok: false, reason: 'too_different' }
  const edits: Edit[] = [...new Array<Edit>(pre).fill('equal'), ...middle, ...new Array<Edit>(suf).fill('equal')]

  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  for (const e of edits) {
    if (e === 'equal') {
      ops.push({ type: 'equal', text: a[i], beforeLine: i + 1, afterLine: j + 1 })
      i++
      j++
    } else if (e === 'delete') {
      ops.push({ type: 'delete', text: a[i], beforeLine: i + 1, afterLine: null })
      i++
    } else {
      ops.push({ type: 'insert', text: b[j], beforeLine: null, afterLine: j + 1 })
      j++
    }
  }
  return { ok: true, ops }
}

export interface SplitCell {
  line: number
  text: string
  type: DiffOpType
}

export interface SplitRow {
  left: SplitCell | null
  right: SplitCell | null
  /** The first row of a run of changes: where "next change" jumps to. */
  changeStart: boolean
}

/**
 * Rows for the side-by-side view: equal lines on both sides; within a run of changes the
 * i-th deleted line sits next to the i-th inserted one, so a changed line reads across.
 */
export function toSplitRows(ops: DiffOp[]): SplitRow[] {
  const rows: SplitRow[] = []
  let i = 0
  while (i < ops.length) {
    const op = ops[i]
    if (op.type === 'equal') {
      rows.push({
        left: { line: op.beforeLine!, text: op.text, type: 'equal' },
        right: { line: op.afterLine!, text: op.text, type: 'equal' },
        changeStart: false,
      })
      i++
      continue
    }
    const dels: DiffOp[] = []
    const ins: DiffOp[] = []
    while (i < ops.length && ops[i].type !== 'equal') {
      if (ops[i].type === 'delete') dels.push(ops[i])
      else ins.push(ops[i])
      i++
    }
    for (let r = 0; r < Math.max(dels.length, ins.length); r++) {
      const d = dels[r]
      const n = ins[r]
      rows.push({
        left: d ? { line: d.beforeLine!, text: d.text, type: 'delete' } : null,
        right: n ? { line: n.afterLine!, text: n.text, type: 'insert' } : null,
        changeStart: r === 0,
      })
    }
  }
  return rows
}
