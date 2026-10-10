'use client'

import { useQuery } from '@tanstack/react-query'

export interface PluginsStatus {
  platformVersion: string
  runner: { reachable: boolean; platformVersion?: string; state?: string; workers?: number; error?: string }
}

/** GET /api/plugins/status: this webapp's platform version and what the plugin runner reports. */
export function usePluginsStatus() {
  return useQuery<PluginsStatus>({
    queryKey: ['plugins', 'status'],
    queryFn: async () => {
      const res = await fetch('/api/plugins/status', { cache: 'no-store' })
      if (!res.ok) throw new Error(`Plugin status: HTTP ${res.status}`)
      return res.json()
    },
    refetchInterval: 30_000,
  })
}
