'use client'

import { useEffect, type RefObject } from 'react'

/**
 * Publishes where `ref`'s element sits as `--drawer-top` / `--drawer-bottom` on <html>, which
 * fixed-position drawers (the overlay `Drawer`, `ReconLogsDrawer`) read to pin themselves to
 * it. They are removed when the component unmounts: left behind, every overlay drawer opened
 * on another page inherits them, and the last measurement of a removed element is an empty
 * box, which makes that drawer 0 px tall.
 */
export function useDrawerOffsets(ref: RefObject<HTMLElement | null>, { trackScroll = false } = {}) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement.style
    const update = () => {
      if (!el.isConnected) return
      const rect = el.getBoundingClientRect()
      root.setProperty('--drawer-top', `${rect.top}px`)
      root.setProperty('--drawer-bottom', `${window.innerHeight - rect.bottom}px`)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener('resize', update)
    if (trackScroll) window.addEventListener('scroll', update, true)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
      if (trackScroll) window.removeEventListener('scroll', update, true)
      root.removeProperty('--drawer-top')
      root.removeProperty('--drawer-bottom')
    }
  }, [ref, trackScroll])
}
