'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PluginsPage } from '@/lib/plugins/pageModel'

const TRANSIENT = new Set(['installing', 'updating', 'uninstalling'])

/** GET /api/plugins: the Plugins page model; polled while an operation runs. */
export function usePluginsPage() {
  return useQuery<PluginsPage>({
    queryKey: ['plugins', 'page'],
    queryFn: async () => {
      const res = await fetch('/api/plugins', { cache: 'no-store' })
      if (!res.ok) throw new Error(`Plugins: HTTP ${res.status}`)
      return res.json()
    },
    refetchInterval: (q) => (q.state.data?.plugins.some((p) => TRANSIENT.has(p.state)) ? 3_000 : false),
  })
}

export class PluginApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: string[],
  ) {
    super(message)
    this.name = 'PluginApiError'
  }
}

async function answer(res: Response): Promise<unknown> {
  let body: { error?: string; code?: string; details?: string[] } | null = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) {
    throw new PluginApiError(body?.error ?? `HTTP ${res.status}`, body?.code ?? 'error', res.status, body?.details)
  }
  return body
}

export async function pluginPost(path: string, body: unknown): Promise<unknown> {
  return answer(await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
}

export async function pluginUpload(path: string, form: FormData): Promise<unknown> {
  return answer(await fetch(path, { method: 'POST', body: form }))
}

/** A lifecycle call; the page model is reloaded whatever the outcome. */
export function usePluginAction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (a: { path: string; body?: unknown; form?: FormData }) =>
      a.form ? pluginUpload(a.path, a.form) : pluginPost(a.path, a.body ?? {}),
    onSettled: () => qc.invalidateQueries({ queryKey: ['plugins'] }),
  })
}
