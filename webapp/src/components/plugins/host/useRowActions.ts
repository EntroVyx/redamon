'use client'

import { useCallback } from 'react'
import { pick, resultMessage } from './bindings'
import { useHost, type Params } from './hostContext'
import type { RowAction } from './RowActions'
import { useCall } from './useCall'

/**
 * A list's or table's row actions: a screen opens with the row's listed fields; an action
 * runs with them, then the list reloads. The status sits on the list, not the row, because
 * the row may be gone after the reload (a delete).
 */
export function useRowActions(reload: () => void) {
  const { runAction, openScreen } = useHost()
  const call = useCall()
  const onAction = useCallback(
    async (a: RowAction, row: Params) => {
      const passed = pick(row, a.pass)
      if (a.screen) {
        openScreen(a.screen, passed)
        return
      }
      if (!a.action) return
      const action = a.action
      const r = await call.run(() => runAction(action, passed))
      if (r.ok) {
        call.setMessage(resultMessage(r.value, 'Done'))
        reload()
      }
    },
    [call, runAction, openScreen, reload],
  )
  return { onAction, busy: call.busy, error: call.error, message: call.message }
}
