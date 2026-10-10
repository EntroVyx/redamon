/**
 * useDrawerOffsets: while a page is shown it publishes where its content area sits as
 * --drawer-top / --drawer-bottom on <html>, which fixed-position drawers read. When the page
 * goes they go too: left behind, every overlay drawer opened on another page inherits them,
 * and the last measurement of a removed element (an empty box) makes it 0 px tall.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { useRef } from 'react'
import { useDrawerOffsets } from './useDrawerOffsets'

let observers: { callback: () => void; disconnected: boolean }[]
let rect: { top: number; bottom: number }

beforeEach(() => {
  observers = []
  rect = { top: 80, bottom: 700 }
  vi.stubGlobal('ResizeObserver', class {
    entry: { callback: () => void; disconnected: boolean }
    constructor(callback: () => void) {
      this.entry = { callback, disconnected: false }
      observers.push(this.entry)
    }
    observe() {}
    disconnect() {
      this.entry.disconnected = true
    }
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return (this.isConnected ? { top: rect.top, bottom: rect.bottom } : { top: 0, bottom: 0 }) as DOMRect
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('style')
})

function Page({ trackScroll = false }: { trackScroll?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useDrawerOffsets(ref, { trackScroll })
  return <div ref={ref} />
}

const offsets = () => {
  const s = document.documentElement.style
  return { top: s.getPropertyValue('--drawer-top'), bottom: s.getPropertyValue('--drawer-bottom') }
}

describe('useDrawerOffsets', () => {
  test('publishes the content area while the page is shown, and follows resizes', () => {
    render(<Page />)
    expect(offsets()).toEqual({ top: '80px', bottom: `${window.innerHeight - 700}px` })
    rect = { top: 120, bottom: 650 }
    observers[0].callback()
    expect(offsets()).toEqual({ top: '120px', bottom: `${window.innerHeight - 650}px` })
  })

  test('removes both offsets when the page goes, and stops observing', () => {
    const { unmount } = render(<Page />)
    unmount()
    expect(offsets()).toEqual({ top: '', bottom: '' })
    expect(observers[0].disconnected).toBe(true)
  })

  test('a measurement of an element no longer in the page changes nothing', () => {
    const { container } = render(<Page />)
    const el = container.firstElementChild!
    el.remove()
    observers[0].callback()
    expect(offsets()).toEqual({ top: '80px', bottom: `${window.innerHeight - 700}px` })
    container.appendChild(el)
  })

  test('follows scrolling only when asked', () => {
    render(<Page />)
    rect = { top: 40, bottom: 700 }
    window.dispatchEvent(new Event('scroll'))
    expect(offsets().top).toBe('80px')
    cleanup()
    render(<Page trackScroll />)
    rect = { top: 40, bottom: 700 }
    window.dispatchEvent(new Event('scroll'))
    expect(offsets().top).toBe('40px')
  })
})
