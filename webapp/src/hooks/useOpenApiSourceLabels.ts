'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  documentUrlHash,
  parseOpenApiSourceStatus,
  rowStatusLabel,
  type OpenApiSourceRow,
} from '@/lib/openapiSourceStatus'

/**
 * One label per configured OpenAPI document: its last fetch status while its
 * URL is the one fetched, "Not fetched yet" after an edit or before any run,
 * or null when it cannot be told (status not loaded, or a browser that cannot
 * hash on a plain-HTTP page).
 */
export function useOpenApiSourceLabels(statusEntries: unknown, rows: OpenApiSourceRow[]): (string | null)[] {
  const urlsKey = rows.map(r => r.url ?? '').join('\n')
  const [hashes, setHashes] = useState<(string | null)[] | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all(urlsKey.split('\n').map(url => documentUrlHash(url)))
      .then(result => { if (!cancelled) setHashes(result) })
      .catch(() => { if (!cancelled) setHashes(null) })
    return () => { cancelled = true }
  }, [urlsKey])

  const statuses = useMemo(
    () => (Array.isArray(statusEntries) ? parseOpenApiSourceStatus(statusEntries) : null),
    [statusEntries],
  )
  return rows.map((row, i) => rowStatusLabel(row, statuses, hashes ? hashes[i] : null))
}
