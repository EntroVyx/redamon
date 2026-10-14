'use client'

import { Component, useMemo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { parseScreen } from '@/lib/plugins/schemas/screen'
import { HostContext, type HostScope, type Params, type ScreenHost } from './hostContext'
import { ScreenNodeView } from './ScreenNodeView'
import styles from './host.module.css'

const SHOWN_PROBLEMS = 3

function ScreenError({ displayName, details }: { displayName: string; details?: string[] }) {
  return (
    <div className={styles.screenError} role="alert">
      <AlertTriangle size={16} aria-hidden />
      <div>
        <div>The plugin {displayName} sent a screen this version of RedAmon cannot draw.</div>
        {details && details.length > 0 && (
          <ul className={styles.problems}>
            {details.slice(0, SHOWN_PROBLEMS).map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** Drawing errors the validation could not foresee still end in the error state, not a blank page. */
class ScreenBoundary extends Component<{ displayName: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error('[plugins] a plugin screen failed to draw:', error)
  }

  render() {
    return this.state.failed ? <ScreenError displayName={this.props.displayName} /> : this.props.children
  }
}

/**
 * Draws a plugin screen from its JSON description (README.PLUGINS.md §7.5). The description
 * is validated again here, whatever was checked at install: the host draws only what the
 * schema allows, from core primitives, and never runs plugin code.
 */
export function ScreenRenderer({ host, screen, inputs }: { host: ScreenHost; screen: unknown; inputs?: Params }) {
  const parsed = useMemo(() => parseScreen(screen), [screen])
  const scopeInputs = useMemo(() => inputs ?? {}, [inputs])
  const scope = useMemo<HostScope>(
    () => ({
      ...host,
      inputs: scopeInputs,
      renderNode: (node, data, key) => <ScreenNodeView key={key} node={node} data={data} />,
    }),
    [host, scopeInputs],
  )

  if (!parsed.ok) return <ScreenError displayName={host.displayName} details={parsed.errors} />
  return (
    <HostContext.Provider value={scope}>
      <ScreenBoundary displayName={host.displayName}>
        <div className={styles.screen}>
          <ScreenNodeView node={parsed.value} data={scopeInputs} />
        </div>
      </ScreenBoundary>
    </HostContext.Provider>
  )
}
