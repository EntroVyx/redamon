'use client'

import type { Params } from './hostContext'
import styles from './host.module.css'

export interface RowAction {
  label: string
  screen?: string
  action?: string
  pass: string[]
}

export function RowActions({
  actions,
  row,
  disabled,
  onAction,
}: {
  actions: RowAction[]
  row: Params
  disabled: boolean
  onAction: (action: RowAction, row: Params) => void
}) {
  return (
    <div className={styles.rowActions}>
      {actions.map((a) => (
        <button key={a.label} type="button" className="secondaryButton" disabled={disabled} onClick={() => onAction(a, row)}>
          {a.label}
        </button>
      ))}
    </div>
  )
}
