'use client'

import Link from 'next/link'
import { usePluginContributions } from '@/hooks/usePluginContributions'
import { PluginBadge } from './PluginBadge'
import { PluginIcon } from './pluginIcons'
import styles from './PluginNavLinks.module.css'

/** The plugins' own pages, listed on the Plugins page (nav entries never go in the global header). */
export function PluginNavLinks() {
  const { data } = usePluginContributions()
  const withNav = (data ?? []).filter((c) => c.nav)
  if (withNav.length === 0) return null
  return (
    <section className={styles.section} aria-label="Plugin pages">
      {withNav.map((c) => {
        return (
          <div key={c.pluginId} className={styles.entry}>
            <PluginIcon name={c.nav!.icon} size={14} aria-hidden />
            <span className={styles.label}>{c.nav!.label}</span>
            <PluginBadge label={c.displayName} />
            {c.updating && <span className={styles.updating}>updating</span>}
            <Link href={`/plugins/${c.pluginId}`} className="secondaryButton" aria-label={`Open ${c.nav!.label}`}>
              Open
            </Link>
          </div>
        )
      })}
    </section>
  )
}
