'use client'

import { useMemo, useRef, useState } from 'react'
import { ChevronDown, Columns2, Rows3 } from 'lucide-react'
import { diffLines, toSplitRows, type DiffOp, type SplitCell } from '@/lib/plugins/textDiff'
import styles from './TextDiff.module.css'

export interface TextDiffProps {
  before: string
  after: string
  beforeLabel?: string
  afterLabel?: string
  /** Skill text has `{placeholders}` the agent fills in; say so where that text is shown. */
  showPlaceholderLegend?: boolean
}

const PREFIX: Record<DiffOp['type'], string> = { equal: ' ', delete: '-', insert: '+' }

function Cell({ cell }: { cell: SplitCell | null }) {
  if (!cell) return <div className={`${styles.cell} ${styles.blank}`} data-testid="textdiff-cell" data-type="blank" />
  return (
    <div className={`${styles.cell} ${styles[cell.type]}`} data-testid="textdiff-cell" data-type={cell.type}>
      <span className={styles.lineNo} data-testid="textdiff-lineno">
        {cell.line}
      </span>
      <span className={styles.prefix}>{PREFIX[cell.type]}</span>
      <span className={styles.text}>{cell.text}</span>
    </div>
  )
}

/**
 * Before | after of two texts, line by line. Plugin text is only ever a React text child,
 * so markup in it is shown, never interpreted.
 */
export function TextDiff({ before, after, beforeLabel = 'Before', afterLabel = 'After', showPlaceholderLegend }: TextDiffProps) {
  const [unified, setUnified] = useState(false)
  const [current, setCurrent] = useState(-1)
  const rowRefs = useRef<(HTMLDivElement | null)[]>([])
  const lineRefs = useRef<(HTMLDivElement | null)[]>([])

  const diff = useMemo(() => diffLines(before, after), [before, after])
  const rows = useMemo(() => (diff.ok ? toSplitRows(diff.ops) : []), [diff])
  const rowStarts = useMemo(() => rows.flatMap((r, i) => (r.changeStart ? [i] : [])), [rows])
  // The unified view lists diff.ops, not rows. Both views have one start per run of changes,
  // so `current` names the same change in either and survives the toggle.
  const lineStarts = useMemo(
    () =>
      diff.ok
        ? diff.ops.flatMap((op, i) => (op.type !== 'equal' && (i === 0 || diff.ops[i - 1].type === 'equal') ? [i] : []))
        : [],
    [diff],
  )
  const starts = unified ? lineStarts : rowStarts

  const legend = showPlaceholderLegend && (
    <p className={styles.legend}>Text in braces is filled from project settings when the agent runs (for example {'{target}'}).</p>
  )

  if (before === '' && after === '') {
    return <div className={styles.empty}>No text</div>
  }

  if (!diff.ok) {
    return (
      <div className={styles.root}>
        <p className={styles.note}>
          {diff.reason === 'too_large'
            ? 'This text is too large to compare line by line; both versions are shown in full.'
            : 'These versions differ almost everywhere; both are shown in full.'}
        </p>
        {legend}
        <div className={styles.split}>
          <div className={styles.pane}>
            <div className={styles.paneHeader}>{beforeLabel}</div>
            <pre className={styles.plain} data-testid="textdiff-plain-before">{before}</pre>
          </div>
          <div className={styles.divider} />
          <div className={styles.pane}>
            <div className={styles.paneHeader}>{afterLabel}</div>
            <pre className={styles.plain} data-testid="textdiff-plain-after">{after}</pre>
          </div>
        </div>
      </div>
    )
  }

  const goNext = () => {
    if (starts.length === 0) return
    const next = (current + 1) % starts.length
    setCurrent(next)
    const refs = unified ? lineRefs : rowRefs
    refs.current[starts[next]]?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <span className={styles.count}>
          {starts.length === 0
            ? 'No changes'
            : current >= 0
              ? `Change ${current + 1} of ${starts.length}`
              : `${starts.length} ${starts.length === 1 ? 'change' : 'changes'}`}
        </span>
        <button type="button" className="secondaryButton" onClick={goNext} disabled={starts.length === 0}>
          <ChevronDown size={12} aria-hidden /> Next change
        </button>
        <button type="button" className="secondaryButton" onClick={() => setUnified((u) => !u)}>
          {unified ? <Columns2 size={12} aria-hidden /> : <Rows3 size={12} aria-hidden />}
          {unified ? 'Side by side' : 'Unified'}
        </button>
      </div>
      {legend}

      {unified ? (
        <div className={styles.unified}>
          {diff.ops.map((op, i) => (
            <div
              key={i}
              ref={(el) => {
                lineRefs.current[i] = el
              }}
              className={`${styles.cell} ${styles[op.type]}`}
              data-testid="textdiff-unified-line"
              data-type={op.type}
              data-current={current >= 0 && starts[current] === i ? 'true' : undefined}
            >
              <span className={styles.lineNo}>{op.beforeLine ?? ''}</span>
              <span className={styles.lineNo}>{op.afterLine ?? ''}</span>
              <span className={styles.prefix}>{PREFIX[op.type]}</span>
              <span className={styles.text}>{op.text}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.splitTable}>
          <div className={styles.headerRow}>
            <div className={styles.paneHeader}>{beforeLabel}</div>
            <div className={styles.paneHeader}>{afterLabel}</div>
          </div>
          {rows.map((row, i) => (
            <div
              key={i}
              ref={(el) => {
                rowRefs.current[i] = el
              }}
              className={styles.row}
              data-testid="textdiff-row"
              data-current={current >= 0 && starts[current] === i ? 'true' : undefined}
            >
              <Cell cell={row.left} />
              <Cell cell={row.right} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
