'use client'

import { useCallback, useMemo } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowLeft } from 'lucide-react'
import { PluginBadge } from '@/components/plugins/PluginBadge'
import { PluginIcon } from '@/components/plugins/pluginIcons'
import { createScreenRunAction } from '@/components/plugins/host/actionClient'
import type { Params, ScreenHost } from '@/components/plugins/host/hostContext'
import { ScreenRenderer } from '@/components/plugins/host/ScreenRenderer'
import { stashInputs, useHandoffInputs } from '@/components/plugins/host/screenHandoff'
import { Loading } from '@/components/plugins/host/StatusLine'
import { useFeatureModelGate } from '@/components/shared/FeatureModelGate'
import { screenUrl } from '@/lib/plugins/navPaths'
import type { NavScreen } from '@/lib/plugins/navScreens'
import styles from './page.module.css'

export function PluginNavClient({ nav, handoffKey }: { nav: NavScreen; handoffKey: string | null }) {
  const router = useRouter()
  const gate = useFeatureModelGate()
  const inputs = useHandoffInputs(handoffKey)
  const { pluginId, displayName } = nav

  const runAction = useMemo(
    () => createScreenRunAction({ pluginId, displayName, context: {}, gate }),
    [pluginId, displayName, gate],
  )
  const openScreen = useCallback(
    (screen: string, next: Params) => {
      const key = Object.keys(next).length > 0 ? stashInputs(next) : null
      router.push(screenUrl(pluginId, screen) + (key ? `?k=${key}` : ''))
    },
    [router, pluginId],
  )
  const host = useMemo<ScreenHost>(() => ({ pluginId, displayName, runAction, openScreen }), [pluginId, displayName, runAction, openScreen])

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/plugins" className={styles.back}>
          <ArrowLeft size={14} aria-hidden /> Plugins
        </Link>
        <div className={styles.titleRow}>
          <PluginIcon name={nav.navIcon} size={18} aria-hidden />
          <h1 className={styles.title}>{nav.navLabel}</h1>
          <PluginBadge label={displayName} />
        </div>
      </header>
      {nav.kind === 'unreadable' ? (
        <div className={styles.error} role="alert">
          <AlertTriangle size={16} aria-hidden /> The plugin {displayName} has a screen RedAmon cannot read: {nav.reason}.
        </div>
      ) : inputs === null ? (
        <Loading />
      ) : (
        <ScreenRenderer key={nav.screenPath} host={host} screen={nav.screen} inputs={inputs} />
      )}
    </main>
  )
}
