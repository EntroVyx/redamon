'use client'

import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { Drawer } from '@/components/ui'
import type { PluginDetail } from '@/lib/plugins/pageModel'
import styles from './plugins.module.css'

const LOG_LINES = 200

interface PluginDetailsDrawerProps {
  pluginId: string
  isOpen: boolean
  onClose: () => void
  onRollback: (pluginId: string, toVersion: string) => void
  busy?: boolean
}

const n = (x: number) => x.toLocaleString('en-US')
const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`

/**
 * The admin's view of one plugin (README.PLUGIN_SDK.md §12): what failed last, what is on disk,
 * what it was granted, how much it stores, whether a rollback is possible, an export, and the
 * last lines of its log from the runner's ring buffer.
 */
export function PluginDetailsDrawer({ pluginId, isOpen, onClose, onRollback, busy = false }: PluginDetailsDrawerProps) {
  const detail = useQuery<PluginDetail>({
    queryKey: ['plugins', 'detail', pluginId],
    queryFn: async () => {
      const res = await fetch(`/api/plugins/${pluginId}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    enabled: isOpen,
  })
  const logs = useQuery<{ lines: string[] } | { unavailable: string }>({
    queryKey: ['plugins', 'logs', pluginId],
    queryFn: async () => {
      const res = await fetch(`/api/plugins/${pluginId}/logs?lines=${LOG_LINES}`, { cache: 'no-store' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return { unavailable: body?.error ?? `HTTP ${res.status}` }
      return { lines: Array.isArray(body?.lines) ? body.lines : [] }
    },
    enabled: isOpen,
  })

  const d = detail.data
  const admin = d?.admin
  const installed = d?.plugin.installed
  const rollback = admin?.rollback
  return (
    <Drawer isOpen={isOpen} onClose={onClose} position="right" mode="overlay" width="560px" title={`${d?.plugin.displayName ?? pluginId} details`}>
      {detail.isLoading && <div className="skeleton skeletonCard" />}
      {detail.isError && <div className={styles.error}>The details could not be loaded.</div>}
      {admin && (
        <div className={styles.meta}>
          {admin.lastError && (
            <section>
              <h4>Last error</h4>
              <div className={styles.error}>{admin.lastError}</div>
            </section>
          )}
          <section data-testid="plugin-versions">
            <h4>Versions on disk</h4>
            {admin.versionsOnDisk.length === 0 ? (
              <p className={styles.notice}>None: the code is not on the volume (reconciliation restores it from the catalog).</p>
            ) : (
              <ul>
                {admin.versionsOnDisk.map((v) => (
                  <li key={v}>
                    {v}
                    {v === installed?.version ? ' (active)' : v === installed?.previousVersion ? ' (previous)' : ''}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h4>Granted permissions</h4>
            {admin.grantedPermissions.length === 0 ? (
              <p className={styles.notice}>None.</p>
            ) : (
              <div className={styles.permissions}>
                {admin.grantedPermissions.map((p) => (
                  <span key={p.id} className="chip chipSecondary" title={p.consent}>
                    {p.title}
                  </span>
                ))}
              </div>
            )}
          </section>
          <section data-testid="plugin-data">
            <h4>Data</h4>
            <p>
              {n(admin.data.rows)} of {n(admin.data.maxRows)} rows · {mb(admin.data.bytes)} of {mb(admin.data.maxBytes)}
            </p>
          </section>
          <section data-testid="plugin-overrides">
            <h4>Approved skill versions</h4>
            <p>
              {admin.activeVersions === 0
                ? 'None.'
                : admin.dormantVersions > 0
                  ? `${admin.dormantVersions} approved skill version${admin.dormantVersions === 1 ? '' : 's'}, not applied while the plugin is ${d?.plugin.state.replace('_', ' ')}.`
                  : `${admin.activeVersions} applied.`}
            </p>
          </section>
          <section>
            <h4>Rollback</h4>
            {rollback?.possible && installed?.previousVersion ? (
              <>
                {rollback.migrates && (
                  <p className={styles.notice}>The newer version&apos;s down migration takes the data back first.</p>
                )}
                <button
                  type="button"
                  className="secondaryButton"
                  disabled={busy}
                  onClick={() => onRollback(pluginId, installed.previousVersion!)}
                >
                  Roll back to {installed.previousVersion}
                </button>
              </>
            ) : rollback && !rollback.possible ? (
              <p className={styles.notice}>
                {rollback.reason === 'no_down_migration'
                  ? `Version ${installed?.version} moved the data and ships no way back${rollback.missing?.length ? ` (${rollback.missing.join(', ')})` : ''}.`
                  : rollback.reason === 'platform_incompatible'
                    ? `Version ${installed?.previousVersion} needs a different RedAmon (platform ${rollback.platform ?? 'range'}).`
                    : 'No previous version on disk to roll back to.'}
              </p>
            ) : null}
          </section>
          <section>
            <a className="secondaryButton" href={`/api/plugins/${pluginId}/export`} download>
              Export data
            </a>
          </section>
        </div>
      )}
      <section className={styles.meta}>
        <div className={styles.titleRow}>
          <h4>Log (last {LOG_LINES} lines)</h4>
          <button type="button" className="iconButton" onClick={() => logs.refetch()} title="Refresh the log" aria-label="Refresh the log">
            <RefreshCw size={14} />
          </button>
        </div>
        {logs.data && 'unavailable' in logs.data ? (
          <p className={styles.notice}>The plugin runner is unavailable, so its log cannot be read: {logs.data.unavailable}</p>
        ) : logs.data && logs.data.lines.length === 0 ? (
          <p className={styles.notice}>Nothing logged yet.</p>
        ) : (
          <pre data-testid="plugin-log" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 'var(--text-xs)' }}>
            {logs.data && 'lines' in logs.data ? logs.data.lines.join('\n') : ''}
          </pre>
        )}
      </section>
    </Drawer>
  )
}
