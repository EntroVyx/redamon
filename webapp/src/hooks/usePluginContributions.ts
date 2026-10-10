'use client'

import { useQuery } from '@tanstack/react-query'
import type { PluginContributions } from '@/lib/plugins/contributions'

/**
 * GET /api/plugins/contributions: the UI every enabled plugin contributes, for the gear menu
 * and the Plugins page. A 404 (switch off) is not an error here: the host simply shows no
 * plugin UI, so it resolves to an empty list. Cached 60 s; contributions change only on a
 * lifecycle action, which invalidates the ['plugins'] queries.
 */
export function usePluginContributions() {
  return useQuery<PluginContributions[]>({
    queryKey: ['plugins', 'contributions'],
    queryFn: async () => {
      const res = await fetch('/api/plugins/contributions', { cache: 'no-store' })
      if (res.status === 404) return []
      if (!res.ok) throw new Error(`Plugin contributions: HTTP ${res.status}`)
      return res.json()
    },
    staleTime: 60_000,
  })
}
