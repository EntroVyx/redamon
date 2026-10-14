/**
 * The RoE parse store outlives the components that start a parse: a model call
 * that takes minutes must not be lost to a tab switch.
 *
 * @vitest-environment jsdom
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

import { getRoeEntry, resetRoeStore, startRoeParse, useRoeEntry, useRoeMounted } from './roeParseStore'

afterEach(() => {
  cleanup()
  resetRoeStore()
})

function Viewer({ storeKey }: { storeKey: string }) {
  useRoeMounted(storeKey)
  const entry = useRoeEntry(storeKey)
  return <span data-testid="status">{entry.status}</span>
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('roeParseStore', () => {
  test('a parse that finishes after its view unmounted keeps its review', async () => {
    let finish!: (r: Response) => void
    const pending = new Promise<Response>(resolve => { finish = resolve })
    const view = render(<Viewer storeKey="p1" />)
    let run!: Promise<void>
    act(() => { run = startRoeParse('p1', null, () => pending, { readError: async () => 'x' }) })
    expect(view.getByTestId('status').textContent).toBe('parsing')
    view.unmount()
    finish(ok({ changes: [{ key: 'roeGlobalMaxRps' }] }))
    await run
    expect(getRoeEntry('p1').status).toBe('review')
    // A view mounted later sees it.
    const again = render(<Viewer storeKey="p1" />)
    expect(again.getByTestId('status').textContent).toBe('review')
  })

  test('the toast fires only when nothing is mounted to show the result', async () => {
    const notify = vi.fn()
    render(<Viewer storeKey="p1" />)
    await act(() => startRoeParse('p1', null, async () => ok({}), { readError: async () => 'x', notifyUnmounted: notify }))
    expect(notify).not.toHaveBeenCalled()
    cleanup()
    await startRoeParse('p1', null, async () => ok({}), { readError: async () => 'x', notifyUnmounted: notify })
    expect(notify).toHaveBeenCalledWith('review')
  })

  test('a failed parse keeps the reason', async () => {
    await startRoeParse('p1', null, async () => new Response('{}', { status: 503 }), { readError: async () => 'agent down' })
    expect(getRoeEntry('p1')).toMatchObject({ status: 'error', error: 'agent down' })
  })

  test('leaving the page asks first while a parse runs or a review waits', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    let finish!: (r: Response) => void
    const run = startRoeParse('p1', null, () => new Promise(resolve => { finish = resolve }), { readError: async () => 'x' })
    expect(add.mock.calls.some(c => c[0] === 'beforeunload')).toBe(true)
    finish(ok({}))
    await run
    expect(getRoeEntry('p1').status).toBe('review')
    expect(remove.mock.calls.some(c => c[0] === 'beforeunload')).toBe(false)
    resetRoeStore()
    expect(remove.mock.calls.some(c => c[0] === 'beforeunload')).toBe(true)
  })
})
