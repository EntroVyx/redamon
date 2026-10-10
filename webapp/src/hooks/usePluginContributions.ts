'use client'

import { useQuery } from '@tanstack/react-query'
import type { PluginContributions } from '@/lib/plugins/contributions'

/**
 * GET /api/plugins/contributions: the UI every enabled plugin contributes, for the gear menu
 * and the Plugins page. A 404 (switch off) is not an error here: the host simply shows no
 * plugin UI, so it resolves to an empty list, as does any answer that is not a list: the
 * menus it feeds are on core pages and must never break them. Cached 60 s; contributions
 * change only on a lifecycle action, which invalidates the ['plugins'] queries.
 */
export function usePluginContributions() {
  return useQuery<PluginContributions[]>({
    queryKey: ['plugins', 'contributions'],
    queryFn: async () => {
      const res = await fetch('/api/plugins/contributions', { cache: 'no-store' })
      if (res.status === 404) return []
      if (!res.ok) throw new Error(`Plugin contributions: HTTP ${res.status}`)
      const body: unknown = await res.json().catch(() => null)
      return Array.isArray(body) ? body : []
    },
    staleTime: 60_000,
  })
}
