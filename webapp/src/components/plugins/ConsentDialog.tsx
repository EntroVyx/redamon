'use client'

import { useState } from 'react'
import { Modal } from '@/components/ui'
import type { PermissionView } from '@/lib/plugins/pageModel'
import styles from './plugins.module.css'

interface ConsentDialogProps {
  isOpen: boolean
  mode: 'install' | 'update'
  pluginName: string
  version: string
  permissions: PermissionView[]
  /** Update only: the permissions the new release adds. */
  newPermissions?: string[]
  /** Update only: the release moves the plugin's data to a new data version. */
  migratesData?: boolean
  /** Reinstall only: approved skill versions the plugin left; the admin decides whether they return. */
  restoreCount?: number
  busy?: boolean
  onConfirm: (choice: { restoreOverrides?: boolean }) => void
  onCancel: () => void
}

/**
 * The consent prompt shown before anything is downloaded (README.PLUGINS.md §6.2): what the
 * plugin's code will see or do, per permission, granted once for every user of this RedAmon.
 */
export function ConsentDialog({
  isOpen,
  mode,
  pluginName,
  version,
  permissions,
  newPermissions = [],
  migratesData = false,
  restoreCount = 0,
  busy = false,
  onConfirm,
  onCancel,
}: ConsentDialogProps) {
  // Mounted when it opens (the page renders it only then), so every prompt starts unticked.
  const [agreed, setAgreed] = useState(false)
  const [restore, setRestore] = useState(true)

  const verb = mode === 'install' ? 'Install' : 'Update'
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={`${verb} ${pluginName}`}
      footer={
        <>
          <button type="button" className="secondaryButton" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primaryButton"
            disabled={!agreed || busy}
            onClick={() => onConfirm({ restoreOverrides: restoreCount > 0 ? restore : undefined })}
          >
            {busy ? `${verb === 'Install' ? 'Installing' : 'Updating'}…` : `${verb} ${version}`}
          </button>
        </>
      }
    >
      <p>
        {pluginName} {version}{' '}
        {permissions.length ? 'asks for these permissions:' : 'asks for no permission beyond keeping its own data.'}
      </p>
      {permissions.length > 0 && (
        <ul className={styles.permissionList}>
          {permissions.map((p) => (
            <li key={p.id}>
              <div className={styles.permissionTitle}>
                <span>{p.title}</span>
                {newPermissions.includes(p.id) && <span className={`chip chipWarning ${styles.newTag}`}>New</span>}
              </div>
              <p className={styles.permissionText}>{p.consent}</p>
            </li>
          ))}
        </ul>
      )}
      {mode === 'update' && migratesData && (
        <div className="alert alertWarning">
          <div className="alertContent">
            <div className="alertMessage">
              This update moves the plugin&apos;s data to a new format. Rolling back later needs this release to ship a way
              back; if it does not, a rollback will be refused.
            </div>
          </div>
        </div>
      )}
      {restoreCount > 0 && (
        <div className={styles.choice} role="radiogroup" aria-label="Approved skill versions">
          <span>
            This plugin left {restoreCount} approved skill version{restoreCount === 1 ? '' : 's'} from an earlier install.
          </span>
          <label>
            <input type="radio" name="restore" checked={restore} onChange={() => setRestore(true)} />
            <span>Restore them (one whose built-in text has changed since comes back for review, not active)</span>
          </label>
          <label>
            <input type="radio" name="restore" checked={!restore} onChange={() => setRestore(false)} />
            <span>Start from the factory text</span>
          </label>
        </div>
      )}
      <p className={styles.notice}>
        Its code runs on this host, in the plugin runner, isolated from RedAmon&apos;s secrets and the internet.
      </p>
      <label className={styles.consentLine}>
        <input type="checkbox" className="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} disabled={busy} />
        <span>I have read what this plugin may do, and I allow it for every user of this RedAmon.</span>
      </label>
    </Modal>
  )
}
