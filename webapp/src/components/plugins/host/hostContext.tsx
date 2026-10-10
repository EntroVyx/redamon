'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { ScreenNode } from '@/lib/plugins/schemas/screen'

export type Params = Record<string, unknown>

/** What the page drawing a plugin screen gives the renderer. */
export interface ScreenHost {
  pluginId: string
  displayName: string
  /** Runs one of the plugin's actions; resolves with its result, rejects with a PluginActionError. */
  runAction: (action: string, params: Params) => Promise<Params>
  /** Opens another screen of the plugin with the given inputs. */
  openScreen: (screen: string, inputs: Params) => void
}

export interface HostScope extends ScreenHost {
  /**
   * The values the screen was opened with: a row action's `pass` fields, or a form's
   * result for its `resultScreen`. They feed every source and form of the screen and its
   * field bindings, which is how a detail screen learns which item to show.
   */
  inputs: Params
  renderNode: (node: ScreenNode, data: Params, key?: number) => ReactNode
}

export const HostContext = createContext<HostScope | null>(null)

export function useHost(): HostScope {
  const host = useContext(HostContext)
  if (!host) throw new Error('A plugin screen primitive was rendered outside ScreenRenderer')
  return host
}
