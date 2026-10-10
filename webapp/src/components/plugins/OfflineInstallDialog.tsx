'use client'

import { useRef, useState, type ChangeEvent } from 'react'
import { Modal } from '@/components/ui'
import { PERMISSION_TEXT, isPluginPermission } from '@/lib/plugins/permissions'
import styles from './plugins.module.css'

interface Found {
  pluginId: string
  displayName: string
  version: string
  permissions: string[]
  dataVersion?: number
}

export interface InstalledPlugin {
  version: string
  dataVersion: number
  grantedPermissions: string[]
}

interface OfflineInstallDialogProps {
  isOpen: boolean
  busy?: boolean
  /** The installed plugins: an archive of one of them is an update, worded as one. */
  installed?: Record<string, InstalledPlugin>
  /** The server asked: approved skill versions the plugin left, to restore or not. */
  restoreCount?: number
  onSubmit: (form: FormData) => void
  onCancel: () => void
}

async function sha256Hex(file: File): Promise<string> {
  // Copied into this realm's typed array: jsdom (the tests) hands out ArrayBuffers WebCrypto refuses.
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(new Uint8Array(await file.arrayBuffer())))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Install from file (README.PLUGINS.md §9.7): an archive with a catalog and signature that
 * cover it. The browser only reads the catalog to show the release's permissions for
 * consent; the server checks everything again exactly as for a download.
 */
export function OfflineInstallDialog({ isOpen, busy = false, installed = {}, restoreCount = 0, onSubmit, onCancel }: OfflineInstallDialogProps) {
  // Mounted when it opens, so it starts empty each time.
  const [archive, setArchive] = useState<File | null>(null)
  const [catalog, setCatalog] = useState<File | null>(null)
  const [signature, setSignature] = useState<File | null>(null)
  const [found, setFound] = useState<Found | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [agreed, setAgreed] = useState(false)
  const [restore, setRestore] = useState(true)
  const latest = useRef(0)

  /** Finds the release the catalog pins for this archive, to show its permissions. */
  const inspect = async (a: File | null, c: File | null) => {
    const turn = ++latest.current
    setFound(null)
    setProblem(null)
    setAgreed(false)
    if (!a || !c) return
    let next: Found | null = null
    let why: string | null = null
    try {
      const doc = JSON.parse(await c.text()) as {
        plugins?: {
          id: string
          displayName?: string
          releases?: { version: string; sha256: string; permissions?: string[]; dataVersion?: number }[]
        }[]
      }
      const sha = await sha256Hex(a)
      for (const p of doc.plugins ?? []) {
        const r = p.releases?.find((x) => x.sha256 === sha)
        if (r) {
          next = { pluginId: p.id, displayName: p.displayName ?? p.id, version: r.version, permissions: r.permissions ?? [], dataVersion: r.dataVersion }
        }
      }
      if (!next) why = 'This catalog does not list this archive.'
    } catch {
      why = 'The catalog file is not a plugin catalog.'
    }
    if (turn !== latest.current) return
    setFound(next)
    setProblem(why)
  }

  const submit = () => {
    if (!archive || !catalog || !signature || !found) return
    const form = new FormData()
    form.set('archive', archive)
    form.set('catalog', catalog)
    form.set('signature', signature)
    form.set('acceptedPermissions', JSON.stringify(found.permissions))
    if (restoreCount > 0) form.set('restoreOverrides', String(restore))
    onSubmit(form)
  }

  // The server installs, or updates an installed plugin: the prompt says which, as ConsentDialog does.
  const current = found ? installed[found.pluginId] : undefined
  const verb = current ? 'Update' : 'Install'
  const newPermissions = current ? (found?.permissions ?? []).filter((p) => !current.grantedPermissions.includes(p)) : []
  const migratesData = !!current && found?.dataVersion !== undefined && found.dataVersion !== current.dataVersion

  const picked = (e: ChangeEvent<HTMLInputElement>) => e.target.files?.[0] ?? null
  const onArchive = (e: ChangeEvent<HTMLInputElement>) => {
    const f = picked(e)
    setArchive(f)
    void inspect(f, catalog)
  }
  const onCatalog = (e: ChangeEvent<HTMLInputElement>) => {
    const f = picked(e)
    setCatalog(f)
    void inspect(archive, f)
  }
  const onSignature = (e: ChangeEvent<HTMLInputElement>) => setSignature(picked(e))

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title="Install a plugin from files"
      footer={
        <>
          <button type="button" className="secondaryButton" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primaryButton" disabled={!found || !signature || !agreed || busy} onClick={submit}>
            {busy ? `${verb === 'Install' ? 'Installing' : 'Updating'}…` : found ? `${verb} ${found.displayName} ${found.version}` : 'Install'}
          </button>
        </>
      }
    >
      <p className={styles.notice}>
        The same checks as a download apply: the catalog&apos;s signature must come from a trusted key, and the archive must be
        the one it lists.
      </p>
      <label className={styles.fileRow}>
        <span>Plugin archive (.tar.gz)</span>
        <input type="file" accept=".gz,.tgz,application/gzip" onChange={onArchive} disabled={busy} />
      </label>
      <label className={styles.fileRow}>
        <span>Catalog (catalog.json)</span>
        <input type="file" accept=".json,application/json" onChange={onCatalog} disabled={busy} />
      </label>
      <label className={styles.fileRow}>
        <span>Signature (catalog.json.sig)</span>
        <input type="file" accept=".sig" onChange={onSignature} disabled={busy} />
      </label>
      {problem && <div className={styles.error}>{problem}</div>}
      {found && (
        <>
          {current && (
            <p>
              This updates {found.displayName} from {current.version} to {found.version}.
            </p>
          )}
          <p>
            {found.displayName} {found.version}{' '}
            {found.permissions.length ? 'asks for these permissions:' : 'asks for no permission beyond keeping its own data.'}
          </p>
          <ul className={styles.permissionList}>
            {found.permissions.map((p) => (
              <li key={p}>
                <div className={styles.permissionTitle}>
                  <span>{isPluginPermission(p) ? PERMISSION_TEXT[p].title : p}</span>
                  {newPermissions.includes(p) && <span className={`chip chipWarning ${styles.newTag}`}>New</span>}
                </div>
                <p className={styles.permissionText}>{isPluginPermission(p) ? PERMISSION_TEXT[p].consent : 'Unknown to this RedAmon.'}</p>
              </li>
            ))}
          </ul>
          {migratesData && (
            <div className="alert alertWarning">
              <div className="alertContent">
                <div className="alertMessage">
                  This update moves the plugin&apos;s data to a new format. Rolling back later needs this release to ship a
                  way back; if it does not, a rollback will be refused.
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
                <input type="radio" name="offline-restore" checked={restore} onChange={() => setRestore(true)} />
                <span>Restore them (one whose built-in text has changed since comes back for review, not active)</span>
              </label>
              <label>
                <input type="radio" name="offline-restore" checked={!restore} onChange={() => setRestore(false)} />
                <span>Start from the factory text</span>
              </label>
            </div>
          )}
          <label className={styles.consentLine}>
            <input type="checkbox" className="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>I have read what this plugin may do, and I allow it for every user of this RedAmon.</span>
          </label>
        </>
      )}
    </Modal>
  )
}
