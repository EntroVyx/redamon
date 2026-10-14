'use client'

/**
 * A RoE parse in flight, and its result, outside any component.
 *
 * A parse takes minutes, and the components that start one unmount: the RoE
 * page is only mounted while its tab is active, and the project form unmounts a
 * section when its tab changes. Held in component state, the result of a
 * two-minute model call vanished with a tab switch. Here it survives, keyed by
 * project id (or 'create' for a project being created), and a parse that
 * finishes with nothing mounted to show it says so in a toast.
 *
 * While a parse runs or a review is unconfirmed, leaving the page asks first.
 */
import { useEffect, useSyncExternalStore } from 'react'

export type RoeParseStatus = 'idle' | 'parsing' | 'review' | 'error'

export interface RoeParseEntry {
  status: RoeParseStatus
  startedAt: number | null
  file: File | null
  /** The parse route's answer: a create diff, or a replace / remove review. */
  review: Record<string, unknown> | null
  error: string | null
}

const IDLE: RoeParseEntry = Object.freeze({ status: 'idle', startedAt: null, file: null, review: null, error: null }) as RoeParseEntry

const entries = new Map<string, RoeParseEntry>()
const mounted = new Map<string, number>()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
  syncBeforeUnload()
}

export function getRoeEntry(key: string): RoeParseEntry {
  return entries.get(key) ?? IDLE
}

export function setRoeEntry(key: string, patch: Partial<RoeParseEntry>): void {
  entries.set(key, { ...getRoeEntry(key), ...patch })
  emit()
}

export function clearRoeEntry(key: string): void {
  if (!entries.has(key)) return
  entries.delete(key)
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useRoeEntry(key: string): RoeParseEntry {
  return useSyncExternalStore(subscribe, () => getRoeEntry(key), () => IDLE)
}

/** Marks a view of `key` as mounted, so a finished parse knows someone is looking. */
export function useRoeMounted(key: string): void {
  useEffect(() => {
    mounted.set(key, (mounted.get(key) ?? 0) + 1)
    return () => {
      const n = (mounted.get(key) ?? 1) - 1
      if (n <= 0) mounted.delete(key)
      else mounted.set(key, n)
    }
  }, [key])
}

/** Is a parse running, or a review waiting, for `key`? */
export function roeEntryBusy(entry: RoeParseEntry): boolean {
  return entry.status === 'parsing' || entry.status === 'review'
}

export interface StartRoeParseOptions {
  /** Called when the parse finishes while no view of `key` is mounted. */
  notifyUnmounted?: (outcome: 'review' | 'error') => void
  /** Turns a non-2xx answer into the message to show. */
  readError: (res: Response) => Promise<string>
}

/**
 * Run a parse request and keep its outcome in the store, whoever is mounted.
 * Returns once it settles; callers need not await it.
 */
export async function startRoeParse(
  key: string,
  file: File | null,
  run: () => Promise<Response>,
  opts: StartRoeParseOptions,
): Promise<void> {
  setRoeEntry(key, { status: 'parsing', startedAt: Date.now(), file, review: null, error: null })
  let outcome: 'review' | 'error'
  try {
    const res = await run()
    if (!res.ok) {
      setRoeEntry(key, { status: 'error', error: await opts.readError(res), startedAt: null })
      outcome = 'error'
    } else {
      setRoeEntry(key, { status: 'review', review: await res.json(), startedAt: null })
      outcome = 'review'
    }
  } catch (err) {
    setRoeEntry(key, {
      status: 'error',
      error: err instanceof Error ? err.message : 'The document could not be parsed.',
      startedAt: null,
    })
    outcome = 'error'
  }
  if (!mounted.get(key)) opts.notifyUnmounted?.(outcome)
}

// --- leaving the page -----------------------------------------------------------------

let unloadArmed = false
function onBeforeUnload(e: BeforeUnloadEvent) {
  e.preventDefault()
  e.returnValue = ''
}

function syncBeforeUnload() {
  if (typeof window === 'undefined') return
  const busy = [...entries.values()].some(roeEntryBusy)
  if (busy && !unloadArmed) {
    window.addEventListener('beforeunload', onBeforeUnload)
    unloadArmed = true
  } else if (!busy && unloadArmed) {
    window.removeEventListener('beforeunload', onBeforeUnload)
    unloadArmed = false
  }
}

/** For tests: forget every entry. */
export function resetRoeStore(): void {
  entries.clear()
  mounted.clear()
  emit()
}
