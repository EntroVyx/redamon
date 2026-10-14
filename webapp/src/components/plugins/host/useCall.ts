'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from './bindings'

/** Busy / error / message state for one-off action calls (buttons, row actions, forms). */
export function useCall() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const value = await fn()
      return { ok: true, value }
    } catch (e) {
      if (live.current) setError(errorMessage(e))
      return { ok: false }
    } finally {
      if (live.current) setBusy(false)
    }
  }, [])

  return { busy, error, message, setMessage, run }
}
