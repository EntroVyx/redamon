'use client'

import { useState } from 'react'
import { Modal } from '@/components/ui'
import styles from './plugins.module.css'

interface UninstallDialogProps {
  isOpen: boolean
  pluginId: string
  pluginName: string
  busy?: boolean
  onConfirm: (mode: 'keep' | 'purge') => void
  onCancel: () => void
}

/**
 * Uninstall (README.PLUGINS.md §9.6): keeping the data is the default; deleting it is
 * instance-wide, so the export must be downloaded first and the plugin id typed.
 */
export function UninstallDialog({ isOpen, pluginId, pluginName, busy = false, onConfirm, onCancel }: UninstallDialogProps) {
  // Mounted when it opens, so "keep" is selected and nothing is typed each time.
  const [mode, setMode] = useState<'keep' | 'purge'>('keep')
  const [exported, setExported] = useState(false)
  const [typed, setTyped] = useState('')

  const ready = mode === 'keep' || (exported && typed === pluginId)
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={`Uninstall ${pluginName}`}
      footer={
        <>
          <button type="button" className="secondaryButton" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={mode === 'purge' ? `secondaryButton ${styles.danger}` : 'primaryButton'}
            disabled={!ready || busy}
            onClick={() => onConfirm(mode)}
          >
            {mode === 'purge' ? 'Delete everything and uninstall' : 'Uninstall'}
          </button>
        </>
      }
    >
      <p>The plugin&apos;s code is removed from this host. Its contributions disappear for everyone.</p>
      <div className={styles.choice} role="radiogroup" aria-label="Plugin data">
        <label>
          <input type="radio" name="uninstall-mode" checked={mode === 'keep'} onChange={() => setMode('keep')} />
          <span>
            Keep its data: the plugin&apos;s data and approved skill versions stay, unused, and come back if it is installed
            again.
          </span>
        </label>
        <label>
          <input type="radio" name="uninstall-mode" checked={mode === 'purge'} onChange={() => setMode('purge')} />
          <span>Delete all data for every user and project, including approved skill versions. This cannot be undone.</span>
        </label>
      </div>
      {mode === 'purge' && (
        <div className={styles.choice}>
          <a href={`/api/plugins/${pluginId}/export`} download onClick={() => setExported(true)} className="textButton">
            Download the export of its data first
          </a>
          <label className="formLabel" htmlFor="uninstall-confirm">
            Type {pluginId} to confirm
          </label>
          <input
            id="uninstall-confirm"
            className="formInput"
            aria-label={`Type ${pluginId} to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        </div>
      )}
    </Modal>
  )
}
