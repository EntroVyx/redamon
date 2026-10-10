/**
 * ScreenRenderer draws a plugin screen from its JSON description with the fixed primitives
 * (design §6; README.PLUGINS.md §7.5). It validates again before drawing, never crashes on a
 * bad description or bad data, shows loading / empty / error for every call, passes row
 * actions only their listed fields, and pages list/table sources with `{items, next}` (TD-28).
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import { AlertProvider } from '@/components/ui'
import { ScreenRenderer } from './ScreenRenderer'
import { PluginActionError } from './actionClient'
import type { ScreenHost } from './hostContext'

afterEach(() => cleanup())

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function draw(desc: unknown, opts: Partial<ScreenHost> & { inputs?: Record<string, unknown> } = {}) {
  const host: ScreenHost = {
    pluginId: 'echo',
    displayName: 'Echo',
    runAction: opts.runAction ?? vi.fn(async () => ({})),
    openScreen: opts.openScreen ?? vi.fn(),
  }
  render(
    <AlertProvider>
      <ScreenRenderer host={host} screen={desc} inputs={opts.inputs} />
    </AlertProvider>,
  )
  return host
}

describe('validation', () => {
  test('an invalid description shows an error that names the plugin', () => {
    draw({ type: 'bogus' })
    expect(screen.getByRole('alert').textContent).toMatch(/Echo/)
    expect(screen.getByRole('alert').textContent).toMatch(/cannot draw/i)
  })

  test('a non-object, and a page with an unknown key, are refused the same way', () => {
    draw('not a screen')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    cleanup()
    draw({ type: 'page', children: [], onLoad: 'alert(1)' })
    expect(screen.getByRole('alert').textContent).toMatch(/cannot draw/i)
  })
})

describe('page', () => {
  test('loading, then children bound to the source result by field name', async () => {
    const d = deferred<Record<string, unknown>>()
    const runAction = vi.fn(() => d.promise)
    draw(
      {
        type: 'page',
        title: 'Item',
        source: { action: 'get_item', params: { id: 'a' } },
        children: [{ type: 'badge', content: { field: 'status' } }],
      },
      { runAction },
    )
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
    d.resolve({ status: 'ready' })
    expect(await screen.findByText('ready')).toBeInTheDocument()
    expect(runAction).toHaveBeenCalledWith('get_item', { id: 'a' })
  })

  test('a failing source shows its error', async () => {
    draw(
      { type: 'page', source: { action: 'get_item' }, children: [] },
      { runAction: vi.fn(async () => Promise.reject(new PluginActionError('x', 'Item not found'))) },
    )
    expect((await screen.findByRole('alert')).textContent).toContain('Item not found')
  })

  test('screen inputs reach the source params and the bindings', async () => {
    const runAction = vi.fn(async () => ({ name: 'From source' }))
    draw(
      {
        type: 'page',
        source: { action: 'get_item', params: { id: 'default' } },
        children: [
          { type: 'badge', content: { field: 'id' } },
          { type: 'badge', content: { field: 'name' } },
        ],
      },
      { runAction, inputs: { id: 'row-7' } },
    )
    expect(await screen.findByText('From source')).toBeInTheDocument()
    expect(screen.getByText('row-7')).toBeInTheDocument()
    expect(runAction).toHaveBeenCalledWith('get_item', { id: 'row-7' })
  })
})

describe('list', () => {
  const list = {
    type: 'list',
    source: { action: 'list_items' },
    itemTitle: 'name',
    itemSubtitle: 'note',
    emptyText: 'Nothing saved yet',
    rowActions: [
      { label: 'Open', screen: 'ui/detail.json', pass: ['id'] },
      { label: 'Delete', action: 'delete_item', pass: ['id'] },
    ],
  }

  test('loading, then items with title and subtitle', async () => {
    const d = deferred<Record<string, unknown>>()
    draw(list, { runAction: vi.fn(() => d.promise) })
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
    d.resolve({ items: [{ id: '1', name: 'First', note: 'a note', secret: 's' }] })
    expect(await screen.findByText('First')).toBeInTheDocument()
    expect(screen.getByText('a note')).toBeInTheDocument()
  })

  test('empty: the empty text', async () => {
    draw(list, { runAction: vi.fn(async () => ({ items: [] })) })
    expect(await screen.findByText('Nothing saved yet')).toBeInTheDocument()
  })

  test('a result without an items array is an error', async () => {
    draw(list, { runAction: vi.fn(async () => ({ rows: [] })) })
    expect((await screen.findByRole('alert')).textContent).toMatch(/list of items/i)
  })

  test('row actions get only the listed fields: a screen opens, an action runs and the list reloads', async () => {
    const runAction = vi.fn(async (action: string) =>
      action === 'list_items' ? { items: [{ id: '1', name: 'First', secret: 's' }] } : { message: 'Deleted' },
    )
    const openScreen = vi.fn()
    draw(list, { runAction, openScreen })
    await screen.findByText('First')
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(openScreen).toHaveBeenCalledWith('ui/detail.json', { id: '1' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Deleted')).toBeInTheDocument()
    expect(runAction).toHaveBeenCalledWith('delete_item', { id: '1' })
    expect(runAction.mock.calls.filter((c) => c[0] === 'list_items')).toHaveLength(2)
  })

  test('a failing row action shows its error and keeps the rows', async () => {
    const runAction = vi.fn(async (action: string) => {
      if (action === 'list_items') return { items: [{ id: '1', name: 'First' }] }
      throw new PluginActionError('denied', 'Not allowed')
    })
    draw(list, { runAction })
    await screen.findByText('First')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Not allowed')
    expect(screen.getByText('First')).toBeInTheDocument()
  })
})

describe('table and paging (TD-28)', () => {
  const table = {
    type: 'table',
    source: { action: 'list_items', params: { kind: 'all' } },
    columns: [
      { field: 'name', label: 'Name' },
      { field: 'count', label: 'Count', format: 'number' },
      { field: 'at', label: 'When', format: 'date' },
    ],
    emptyText: 'No rows',
  }

  test('three pages: Load more twice, previous next sent as cursor, rows appended in order, button gone at the end', async () => {
    const runAction = vi.fn(async (_a: string, params: Record<string, unknown>) => {
      if (!params.cursor) return { items: [{ name: 'r1' }, { name: 'r2' }], next: 'c1' }
      if (params.cursor === 'c1') return { items: [{ name: 'r3' }], next: 'c2' }
      return { items: [{ name: 'r4' }] }
    })
    draw(table, { runAction })
    await screen.findByText('r2')
    fireEvent.click(screen.getByRole('button', { name: /load more/i }))
    await screen.findByText('r3')
    fireEvent.click(screen.getByRole('button', { name: /load more/i }))
    await screen.findByText('r4')
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
    expect(runAction.mock.calls.map((c) => c[1])).toEqual([
      { kind: 'all' },
      { kind: 'all', cursor: 'c1' },
      { kind: 'all', cursor: 'c2' },
    ])
    const names = screen.getAllByTestId('screen-table-row').map((r) => within(r).getAllByRole('cell')[0].textContent)
    expect(names).toEqual(['r1', 'r2', 'r3', 'r4'])
  })

  test('a single page has no Load more', async () => {
    draw(table, { runAction: vi.fn(async () => ({ items: [{ name: 'only' }] })) })
    await screen.findByText('only')
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
  })

  test('formats: numbers and dates are formatted, other values shown as text', async () => {
    draw(table, { runAction: vi.fn(async () => ({ items: [{ name: 'x', count: 12345, at: '2026-01-02T03:04:05Z' }] })) })
    await screen.findByText('x')
    const cells = within(screen.getByTestId('screen-table-row')).getAllByRole('cell')
    expect(cells[1].textContent).toBe((12345).toLocaleString())
    expect(cells[2].textContent).toContain('2026')
    expect(cells[2].textContent).not.toBe('2026-01-02T03:04:05Z')
  })

  test('empty and error states', async () => {
    draw(table, { runAction: vi.fn(async () => ({ items: [] })) })
    expect(await screen.findByText('No rows')).toBeInTheDocument()
    cleanup()
    draw(table, { runAction: vi.fn(async () => ({ nope: true })) })
    expect((await screen.findByRole('alert')).textContent).toMatch(/list of items/i)
  })

  test('a failed Load more keeps the rows and lets you retry', async () => {
    let fail = true
    const runAction = vi.fn(async (_a: string, params: Record<string, unknown>) => {
      if (!params.cursor) return { items: [{ name: 'r1' }], next: 'c1' }
      if (fail) {
        fail = false
        throw new PluginActionError('x', 'Try again later')
      }
      return { items: [{ name: 'r2' }] }
    })
    draw(table, { runAction })
    await screen.findByText('r1')
    fireEvent.click(screen.getByRole('button', { name: /load more/i }))
    expect((await screen.findByRole('alert')).textContent).toContain('Try again later')
    expect(screen.getByText('r1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /load more/i }))
    expect(await screen.findByText('r2')).toBeInTheDocument()
  })

  test('plugin text with markup in a cell is shown as text, never as elements', async () => {
    draw(table, {
      runAction: vi.fn(async () => ({ items: [{ name: '<img src=x onerror="window.__pwned=1"><script>1</script>' }] })),
    })
    await screen.findByText(/<img src=x/)
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
  })

  test('an object value in a cell is not dumped', async () => {
    draw(table, { runAction: vi.fn(async () => ({ items: [{ name: { nested: 'x' } }] })) })
    await waitFor(() => expect(screen.getAllByTestId('screen-table-row')).toHaveLength(1))
    expect(screen.queryByText(/nested/)).toBeNull()
  })
})

describe('form', () => {
  const form = {
    type: 'form',
    title: 'New item',
    fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true, maxLength: 5 },
      { name: 'size', label: 'Size', kind: 'number' },
      { name: 'kind', label: 'Kind', kind: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], default: 'b' },
      { name: 'urgent', label: 'Urgent', kind: 'checkbox' },
      { name: 'notes', label: 'Notes', kind: 'textarea' },
    ],
    submit: { action: 'save_item', label: 'Save' },
  }

  test('required and length are checked before anything is sent', async () => {
    const runAction = vi.fn(async () => ({}))
    draw(form, { runAction })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/name is required/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'too long' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/at most 5/i)).toBeInTheDocument()
    expect(runAction).not.toHaveBeenCalled()
  })

  test('a valid form sends typed values and shows the result message', async () => {
    const runAction = vi.fn(async () => ({ message: 'Saved item' }))
    draw(form, { runAction })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'abc' } })
    fireEvent.change(screen.getByLabelText('Size'), { target: { value: '7' } })
    fireEvent.click(screen.getByLabelText('Urgent'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved item')).toBeInTheDocument()
    expect(runAction).toHaveBeenCalledWith('save_item', { name: 'abc', size: 7, kind: 'b', urgent: true, notes: '' })
  })

  test('a number field rejects text', async () => {
    const runAction = vi.fn(async () => ({}))
    draw(form, { runAction })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'abc' } })
    fireEvent.change(screen.getByLabelText('Size'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/must be a number/i)).toBeInTheDocument()
    expect(runAction).not.toHaveBeenCalled()
  })

  test('a failed submit shows the error; a resultScreen opens with the result', async () => {
    draw(form, { runAction: vi.fn(async () => Promise.reject(new PluginActionError('x', 'Could not save'))) })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not save')
    cleanup()
    const openScreen = vi.fn()
    draw({ ...form, resultScreen: 'ui/detail.json' }, { runAction: vi.fn(async () => ({ id: 'n1' })), openScreen })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(openScreen).toHaveBeenCalledWith('ui/detail.json', { id: 'n1' }))
  })
})

describe('button, select, markdown, textDiff, badge, emptyState', () => {
  test('an action button sends its params and shows the result; confirm cancel sends nothing', async () => {
    const runAction = vi.fn(async () => ({ message: 'Done it' }))
    draw({ type: 'button', label: 'Run', action: 'go', params: { n: 1 } }, { runAction })
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(await screen.findByText('Done it')).toBeInTheDocument()
    expect(runAction).toHaveBeenCalledWith('go', { n: 1 })
    cleanup()
    const run2 = vi.fn(async () => ({}))
    draw({ type: 'button', label: 'Wipe', action: 'wipe', confirm: 'Really wipe?', tone: 'danger' }, { runAction: run2 })
    fireEvent.click(screen.getByRole('button', { name: 'Wipe' }))
    expect(await screen.findByText('Really wipe?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('Really wipe?')).toBeNull())
    expect(run2).not.toHaveBeenCalled()
  })

  test('a failing button shows its error; a screen button opens the screen', async () => {
    draw({ type: 'button', label: 'Run', action: 'go' }, { runAction: vi.fn(async () => Promise.reject(new PluginActionError('x', 'Nope'))) })
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Nope')
    cleanup()
    const openScreen = vi.fn()
    draw({ type: 'button', label: 'More', screen: 'ui/more.json', params: { tab: 'a' } }, { openScreen })
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(openScreen).toHaveBeenCalledWith('ui/more.json', { tab: 'a' })
  })

  test('select shows its options with the default chosen', () => {
    draw({ type: 'select', name: 'k', label: 'Kind', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], default: 'b' })
    expect((screen.getByLabelText('Kind') as HTMLSelectElement).value).toBe('b')
  })

  test('markdown goes through SafeMarkdown: no image, links to the confirmation page', () => {
    draw({ type: 'markdown', content: { text: '![x](https://example.com/a.png) [docs](https://example.com)' } })
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByRole('link', { name: 'docs' }).getAttribute('href')).toMatch(/^\/plugins\/external-link\?url=/)
  })

  test('textDiff draws the bound before and after', async () => {
    draw(
      {
        type: 'page',
        source: { action: 'get' },
        children: [{ type: 'textDiff', title: 'Change', before: { field: 'old' }, after: { field: 'new' } }],
      },
      { runAction: vi.fn(async () => ({ old: 'a\nb', new: 'a\nc' })) },
    )
    expect(await screen.findByText('Change')).toBeInTheDocument()
    expect(screen.getAllByTestId('textdiff-row')).toHaveLength(2)
  })

  test('badge shows markup as text; an empty bound badge draws nothing', () => {
    draw({
      type: 'page',
      children: [
        { type: 'badge', content: { text: '<script>window.__pwned=1</script>' } },
        { type: 'badge', content: { field: 'missing' } },
      ],
    })
    expect(screen.getByText('<script>window.__pwned=1</script>')).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
    expect(screen.getAllByTestId('screen-badge')).toHaveLength(1)
  })

  test('emptyState shows its title and text', () => {
    draw({ type: 'emptyState', title: 'Nothing here', text: 'Run the action first.' })
    expect(screen.getByText('Nothing here')).toBeInTheDocument()
    expect(screen.getByText('Run the action first.')).toBeInTheDocument()
  })
})
