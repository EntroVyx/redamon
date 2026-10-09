import { describe, test, expect } from 'vitest'
import { parseScreen, screenReferences, SCREEN_MAX_DEPTH, type ScreenNode } from './schemas/screen'

const table: ScreenNode = {
  type: 'table',
  title: 'Saved items',
  source: { action: 'list_items' },
  columns: [{ field: 'name' }, { field: 'updatedAt', format: 'date' }],
  rowActions: [{ label: 'Open', screen: 'ui/detail.json', pass: ['id'] }],
}

const page = (children: unknown[]): unknown => ({ type: 'page', title: 'Home', children })

function errors(input: unknown): string {
  const r = parseScreen(input)
  if (r.ok) throw new Error('expected the screen to be refused')
  return r.errors.join('\n')
}

describe('valid screens', () => {
  test("the design's table example", () => {
    expect(parseScreen(table).ok).toBe(true)
  })

  test('a page holding every primitive', () => {
    const r = parseScreen(
      page([
        table,
        { type: 'list', source: { action: 'list_items', params: { limit: 10 } }, itemTitle: 'name' },
        {
          type: 'form',
          fields: [
            { name: 'title', label: 'Title', kind: 'text', required: true, maxLength: 80 },
            { name: 'level', label: 'Level', kind: 'select', options: [{ value: 'a', label: 'A' }] },
            { name: 'on', label: 'On', kind: 'checkbox', default: false },
          ],
          submit: { action: 'save_item' },
        },
        { type: 'select', name: 'view', label: 'View', options: [{ value: 'all', label: 'All' }] },
        { type: 'button', label: 'Refresh', action: 'list_items', confirm: 'Sure?', tone: 'primary' },
        { type: 'markdown', content: { text: '# Hello' } },
        { type: 'textDiff', before: { field: 'old' }, after: { field: 'new' } },
        { type: 'badge', content: { text: 'beta' }, tone: 'info' },
        { type: 'emptyState', title: 'Nothing yet' },
      ]),
    )
    expect(r.ok ? [] : r.errors).toEqual([])
  })

  test('a row action passes nothing unless it lists fields', () => {
    const r = parseScreen({ ...table, rowActions: [{ label: 'Open', action: 'save_item' }] })
    expect(r.ok && r.value.type === 'table' && r.value.rowActions?.[0].pass).toEqual([])
  })

  test(`nesting exactly ${SCREEN_MAX_DEPTH} deep`, () => {
    let node: unknown = { type: 'emptyState', title: 'leaf' }
    for (let i = 1; i < SCREEN_MAX_DEPTH; i++) node = page([node])
    expect(parseScreen(node).ok).toBe(true)
  })
})

describe('refused screens', () => {
  test(`nesting ${SCREEN_MAX_DEPTH + 1} deep`, () => {
    let node: unknown = { type: 'emptyState', title: 'leaf' }
    for (let i = 1; i <= SCREEN_MAX_DEPTH; i++) node = page([node])
    expect(errors(node)).toMatch(/nested 7 deep; at most 6/)
  })

  test('an unknown primitive', () => {
    expect(errors({ type: 'iframe', src: 'https://example.com' })).toMatch(/type/)
  })

  test('an unknown key on a primitive', () => {
    expect(errors({ ...table, html: '<b>x</b>' })).toMatch(/Unrecognized key: "html"/)
  })

  test('text over 2,000 characters', () => {
    expect(errors({ type: 'markdown', content: { text: 'x'.repeat(2001) } })).toMatch(/content\.text: Too big/)
  })

  test('a binding with both text and field', () => {
    expect(errors({ type: 'badge', content: { text: 'a', field: 'b' } })).toMatch(/give either text or field/)
  })

  test('a button that both calls an action and opens a screen', () => {
    expect(errors({ type: 'button', label: 'x', action: 'a_b', screen: 'ui/x.json' })).toMatch(
      /calls an action or opens a screen, not both/,
    )
  })

  test('a row action with neither a screen nor an action', () => {
    expect(errors({ ...table, rowActions: [{ label: 'x', pass: [] }] })).toMatch(/opens a screen or calls an action/)
  })

  test('a screen path outside ui/', () => {
    expect(errors({ ...table, rowActions: [{ label: 'x', screen: '../ui/x.json' }] })).toMatch(/under ui\//)
  })

  test('a select form field without options, and options on a text field', () => {
    expect(
      errors({ type: 'form', fields: [{ name: 'a', label: 'A', kind: 'select' }], submit: { action: 'save_item' } }),
    ).toMatch(/fields\.0\.options: options are required for a select field/)
    expect(
      errors({
        type: 'form',
        fields: [{ name: 'a', label: 'A', kind: 'text', options: [{ value: 'x', label: 'X' }] }],
        submit: { action: 'save_item' },
      }),
    ).toMatch(/allowed only there/)
  })

  test('a field name that is not an identifier', () => {
    expect(errors({ ...table, columns: [{ field: 'a.b' }] })).toMatch(/columns\.0\.field/)
  })

  test('more than 200 elements', () => {
    const many = Array.from({ length: 40 }, () => page(Array.from({ length: 5 }, () => ({ type: 'emptyState', title: 'x' }))))
    expect(errors(page(many))).toMatch(/241 elements; at most 200/)
  })
})

describe('screenReferences', () => {
  test('collects every action and screen a description names', () => {
    const node = page([
      table,
      { type: 'form', fields: [{ name: 'a', label: 'A', kind: 'text' }], submit: { action: 'save_item' }, resultScreen: 'ui/done.json' },
      { type: 'button', label: 'Go', screen: 'ui/other.json' },
    ]) as ScreenNode
    expect(screenReferences(node)).toEqual({
      actions: ['list_items', 'save_item'],
      screens: ['ui/detail.json', 'ui/done.json', 'ui/other.json'],
    })
  })
})
