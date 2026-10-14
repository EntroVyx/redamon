/**
 * TextDiff: the before | after view the review modal and the textDiff primitive share.
 * Split view by default with a unified toggle, line numbers, added/removed highlights,
 * "next change", and the no-highlights fallback when the diff is refused.
 */
import { describe, test, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { TextDiff } from './TextDiff'
import { TEXT_DIFF_MAX_LINES } from '@/lib/plugins/textDiff'

afterEach(() => cleanup())

const rows = () => screen.getAllByTestId('textdiff-row')

describe('split view', () => {
  test('equal lines on both sides; a changed line is removed on the left and added on the right', () => {
    render(<TextDiff before={'keep\nold\nend'} after={'keep\nnew\nend'} />)
    const r = rows()
    expect(r).toHaveLength(3)
    const [left, right] = within(r[1]).getAllByTestId('textdiff-cell')
    expect(left).toHaveAttribute('data-type', 'delete')
    expect(left.textContent).toContain('old')
    expect(right).toHaveAttribute('data-type', 'insert')
    expect(right.textContent).toContain('new')
    expect(within(r[0]).getAllByTestId('textdiff-cell')[0]).toHaveAttribute('data-type', 'equal')
  })

  test('line numbers are shown per side', () => {
    render(<TextDiff before={'a\nb'} after={'a\nx\nb'} />)
    const last = within(rows()[2]).getAllByTestId('textdiff-cell')
    expect(within(last[0]).getByTestId('textdiff-lineno').textContent).toBe('2')
    expect(within(last[1]).getByTestId('textdiff-lineno').textContent).toBe('3')
  })

  test('the column headings default to Before and After and can be named', () => {
    const { unmount } = render(<TextDiff before="a" after="b" />)
    expect(screen.getByText('Before')).toBeInTheDocument()
    expect(screen.getByText('After')).toBeInTheDocument()
    unmount()
    render(<TextDiff before="a" after="b" beforeLabel="v2 (active)" afterLabel="v3 (proposed)" />)
    expect(screen.getByText('v2 (active)')).toBeInTheDocument()
    expect(screen.getByText('v3 (proposed)')).toBeInTheDocument()
  })
})

describe('unified view', () => {
  test('the toggle shows one column with - and + lines in order', () => {
    render(<TextDiff before={'a\nold'} after={'a\nnew'} />)
    fireEvent.click(screen.getByRole('button', { name: /unified/i }))
    const lines = screen.getAllByTestId('textdiff-unified-line')
    expect(lines.map((l) => l.getAttribute('data-type'))).toEqual(['equal', 'delete', 'insert'])
    expect(lines[1].textContent).toContain('old')
    fireEvent.click(screen.getByRole('button', { name: /side by side/i }))
    expect(screen.queryAllByTestId('textdiff-unified-line')).toHaveLength(0)
  })
})

describe('next change', () => {
  test('steps through each run of changes and wraps', () => {
    render(<TextDiff before={'a\nb\nc\nd\ne'} after={'a\nB\nc\nd\nE'} />)
    expect(screen.getByText('2 changes')).toBeInTheDocument()
    const next = screen.getByRole('button', { name: /next change/i })
    fireEvent.click(next)
    expect(screen.getByText('Change 1 of 2')).toBeInTheDocument()
    expect(rows()[1]).toHaveAttribute('data-current', 'true')
    fireEvent.click(next)
    expect(screen.getByText('Change 2 of 2')).toBeInTheDocument()
    expect(rows()[4]).toHaveAttribute('data-current', 'true')
    fireEvent.click(next)
    expect(screen.getByText('Change 1 of 2')).toBeInTheDocument()
  })

  test('the unified view scrolls to and marks each run of changes too, and keeps it across the toggle', () => {
    // jsdom has no scrollIntoView; record which element each jump scrolls to.
    const scrolled: Element[] = []
    const proto = Element.prototype as { scrollIntoView?: (arg?: ScrollIntoViewOptions) => void }
    const original = proto.scrollIntoView
    proto.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    try {
      render(<TextDiff before={'a\nb\nc\nd\ne'} after={'a\nB\nc\nd\nE'} />)
      fireEvent.click(screen.getByRole('button', { name: /unified/i }))
      const lines = () => screen.getAllByTestId('textdiff-unified-line')
      const next = screen.getByRole('button', { name: /next change/i })
      fireEvent.click(next)
      expect(screen.getByText('Change 1 of 2')).toBeInTheDocument()
      expect(lines()[1]).toHaveAttribute('data-current', 'true')
      expect(scrolled[scrolled.length - 1]).toBe(lines()[1])
      fireEvent.click(next)
      expect(screen.getByText('Change 2 of 2')).toBeInTheDocument()
      // ops: a, -b, +B, c, d, -e, +E
      expect(lines()[5]).toHaveAttribute('data-current', 'true')
      expect(scrolled[scrolled.length - 1]).toBe(lines()[5])
      fireEvent.click(screen.getByRole('button', { name: /side by side/i }))
      expect(rows()[4]).toHaveAttribute('data-current', 'true')
    } finally {
      if (original) proto.scrollIntoView = original
      else delete proto.scrollIntoView
    }
  })

  test('identical texts say so, and next change is disabled', () => {
    render(<TextDiff before={'same\ntext'} after={'same\ntext'} />)
    expect(screen.getByText('No changes')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /next change/i })).toBeDisabled()
  })
})

describe('fallbacks and states', () => {
  test('too large to compare: both texts shown without highlights, and why', () => {
    const big = Array.from({ length: TEXT_DIFF_MAX_LINES + 1 }, (_, i) => `l${i}`).join('\n')
    render(<TextDiff before={big} after="short" />)
    expect(screen.getByText(/too large to compare line by line/i)).toBeInTheDocument()
    expect(screen.queryAllByTestId('textdiff-row')).toHaveLength(0)
    expect(screen.getByTestId('textdiff-plain-after').textContent).toBe('short')
    expect(screen.getByTestId('textdiff-plain-before').textContent).toContain('l20000')
  })

  test('both empty: an empty state', () => {
    render(<TextDiff before="" after="" />)
    expect(screen.getByText(/no text/i)).toBeInTheDocument()
  })

  test('the placeholder legend appears only when asked for', () => {
    const { unmount } = render(<TextDiff before="a {target}" after="b {target}" />)
    expect(screen.queryByText(/filled from project settings/i)).toBeNull()
    unmount()
    render(<TextDiff before="a {target}" after="b {target}" showPlaceholderLegend />)
    expect(screen.getByText(/text in braces is filled from project settings/i)).toBeInTheDocument()
  })

  test('plugin text with markup is shown as text, never as elements', () => {
    render(<TextDiff before="x" after={'<img src=x onerror="window.__pwned=1"><script>1</script>'} />)
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument()
  })
})
