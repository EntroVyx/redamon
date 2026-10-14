'use client'

import { useSyncExternalStore } from 'react'
import type { Params } from './hostContext'

/**
 * Inputs one plugin screen passes to the next travel through sessionStorage under a random
 * key, and the URL carries only the key. The source of the opened screen runs as soon as it
 * loads, so inputs in the URL itself would let a crafted link run a plugin action with
 * chosen params; a key the viewer's own tab never stored resolves to no inputs.
 */
const PREFIX = 'redamon-plugin-screen:'
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NONE: Params = Object.freeze({})
// One object per key, so useSyncExternalStore sees the same snapshot on every read.
const read = new Map<string, Params>()

const isObj = (v: unknown): v is Params => !!v && typeof v === 'object' && !Array.isArray(v)

export function stashInputs(inputs: Params): string | null {
  try {
    const key = crypto.randomUUID()
    sessionStorage.setItem(PREFIX + key, JSON.stringify(inputs))
    return key
  } catch {
    return null
  }
}

export function readInputs(key: string | null): Params {
  if (!key || !KEY_RE.test(key)) return NONE
  const known = read.get(key)
  if (known) return known
  let inputs = NONE
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(PREFIX + key) ?? 'null')
    if (isObj(parsed)) inputs = parsed
  } catch {
    inputs = NONE
  }
  read.set(key, inputs)
  return inputs
}

const subscribe = () => () => {}

/** The inputs for this screen; null while rendering on the server, where sessionStorage is not. */
export function useHandoffInputs(key: string | null): Params | null {
  return useSyncExternalStore(
    subscribe,
    () => readInputs(key),
    () => null,
  )
}
