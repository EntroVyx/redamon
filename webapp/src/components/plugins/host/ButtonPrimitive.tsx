'use client'

import type { ScreenNode } from '@/lib/plugins/schemas/screen'
import { useAlertModal } from '@/components/ui'
import { resultMessage } from './bindings'
import { useHost } from './hostContext'
import { ErrorBox, Message } from './StatusLine'
import { useCall } from './useCall'
import styles from './host.module.css'

type ButtonNode = Extract<ScreenNode, { type: 'button' }>

const TONE_CLASS = {
  primary: 'primaryButton',
  secondary: 'secondaryButton',
  danger: `secondaryButton ${styles.danger}`,
} as const

export function ButtonPrimitive({ node }: { node: ButtonNode }) {
  const { runAction, openScreen, inputs, displayName } = useHost()
  const { confirm, dangerConfirm } = useAlertModal()
  const call = useCall()

  const click = async () => {
    if (node.confirm) {
      // The question is the plugin's text, so the title says who is asking.
      const ask = node.tone === 'danger' ? dangerConfirm : confirm
      if (!(await ask(node.confirm, `${displayName} (plugin)`))) return
    }
    const params = { ...inputs, ...(node.params ?? {}) }
    if (node.screen) {
      openScreen(node.screen, params)
      return
    }
    const action = node.action!
    const r = await call.run(() => runAction(action, params))
    if (r.ok) call.setMessage(resultMessage(r.value, 'Done'))
  }

  return (
    <div className={styles.block}>
      <div>
        <button type="button" className={TONE_CLASS[node.tone ?? 'secondary']} onClick={click} disabled={call.busy}>
          {node.label}
        </button>
      </div>
      {call.error && <ErrorBox message={call.error} />}
      {call.message && <Message message={call.message} />}
    </div>
  )
}
