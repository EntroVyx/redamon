'use client'

import { useCallback, useEffect, useState } from 'react'
import { errorMessage, paramsKey } from './bindings'
import { useHost, type Params } from './hostContext'

type Source = { action: string; params?: Record<string, unknown> } | undefined

/**
 * The params a source sends, as a JSON string: its own params overridden by the screen's
 * inputs. A string is a stable dependency, so a source reloads when the params change and
 * not on every render.
 */
function useParamsJson(source: Source): string {
  const { inputs } = useHost()
  return paramsKey({ ...(source?.params ?? {}), ...inputs })
}

export type ObjectSource = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; data: Params }

/** A page's `source`: one call, its result bound by field name. No source: ready, empty. */
export function useObjectSource(source: Source): ObjectSource {
  const { runAction } = useHost()
  const action = source?.action ?? ''
  const paramsJson = useParamsJson(source)
  const requestKey = `${action}:${paramsJson}`
  const [loaded, setLoaded] = useState<{ key: string; state: ObjectSource } | null>(null)

  useEffect(() => {
    if (!action) return
    let live = true
    const key = `${action}:${paramsJson}`
    runAction(action, JSON.parse(paramsJson) as Params).then(
      (data) => live && setLoaded({ key, state: { status: 'ready', data } }),
      (e) => live && setLoaded({ key, state: { status: 'error', error: errorMessage(e) } }),
    )
    return () => {
      live = false
    }
  }, [action, paramsJson, runAction])

  if (!action) return { status: 'ready', data: {} }
  return loaded && loaded.key === requestKey ? loaded.state : { status: 'loading' }
}

export interface PagedSource {
  status: 'loading' | 'error' | 'ready'
  items: Params[]
  error: string | null
  hasMore: boolean
  loadingMore: boolean
  moreError: string | null
  loadMore: () => void
  reload: () => void
}

const isObj = (v: unknown): v is Params => !!v && typeof v === 'object' && !Array.isArray(v)

const NOT_A_LIST = 'The plugin answered without a list of items, so this cannot be shown.'

class NotAListError extends Error {}

interface Loaded {
  key: string
  status: 'ready' | 'error'
  items: Params[]
  next: string | null
  error: string | null
  loadingMore: boolean
  moreError: string | null
}

const failure = (e: unknown) => (e instanceof NotAListError ? NOT_A_LIST : errorMessage(e))

/**
 * A list or table `source` (TD-28): the action answers `{items, next?}`. "Load more" calls it
 * again with the same params plus `cursor: next` and appends. Every answer is filed under the
 * request it belongs to, so a page that arrives after a reload or a params change is dropped.
 */
export function usePagedSource(source: { action: string; params?: Record<string, unknown> }): PagedSource {
  const { runAction } = useHost()
  const action = source.action
  const paramsJson = useParamsJson(source)
  const [reloads, setReloads] = useState(0)
  const requestKey = `${action}:${paramsJson}:${reloads}`
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  const page = useCallback(
    async (cursor: string | null) => {
      const params = JSON.parse(paramsJson) as Params
      const result = await runAction(action, cursor ? { ...params, cursor } : params)
      if (!isObj(result) || !Array.isArray(result.items)) throw new NotAListError(NOT_A_LIST)
      return {
        items: result.items.filter(isObj),
        next: typeof result.next === 'string' && result.next ? result.next : null,
      }
    },
    [runAction, action, paramsJson],
  )

  useEffect(() => {
    let live = true
    const key = requestKey
    const base = { key, loadingMore: false, moreError: null }
    page(null).then(
      (p) => live && setLoaded({ ...base, status: 'ready', items: p.items, next: p.next, error: null }),
      (e) => live && setLoaded({ ...base, status: 'error', items: [], next: null, error: failure(e) }),
    )
    return () => {
      live = false
    }
  }, [requestKey, page])

  const current = loaded && loaded.key === requestKey ? loaded : null

  const loadMore = useCallback(() => {
    if (!current || !current.next || current.loadingMore) return
    const { key, next } = current
    const update = (fn: (l: Loaded) => Loaded) => setLoaded((prev) => (prev && prev.key === key ? fn(prev) : prev))
    update((l) => ({ ...l, loadingMore: true, moreError: null }))
    page(next).then(
      (p) => update((l) => ({ ...l, items: [...l.items, ...p.items], next: p.next, loadingMore: false })),
      (e) => update((l) => ({ ...l, loadingMore: false, moreError: failure(e) })),
    )
  }, [current, page])

  const reload = useCallback(() => setReloads((n) => n + 1), [])

  return {
    status: current ? current.status : 'loading',
    items: current?.items ?? [],
    error: current?.error ?? null,
    hasMore: !!current?.next,
    loadingMore: current?.loadingMore ?? false,
    moreError: current?.moreError ?? null,
    loadMore,
    reload,
  }
}
