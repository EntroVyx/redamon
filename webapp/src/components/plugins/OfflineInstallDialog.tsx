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
}

interface OfflineInstallDialogProps {
  isOpen: boolean
  busy?: boolean
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
export function OfflineInstallDialog({ isOpen, busy = false, onSubmit, onCancel }: OfflineInstallDialogProps) {
  // Mounted when it opens, so it starts empty each time.
  const [archive, setArchive] = useState<File | null>(null)
  const [catalog, setCatalog] = useState<File | null>(null)
  const [signature, setSignature] = useState<File | null>(null)
  const [found, setFound] = useState<Found | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [agreed, setAgreed] = useState(false)
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
        plugins?: { id: string; displayName?: string; releases?: { version: string; sha256: string; permissions?: string[] }[] }[]
      }
      const sha = await sha256Hex(a)
      for (const p of doc.plugins ?? []) {
        const r = p.releases?.find((x) => x.sha256 === sha)
        if (r) next = { pluginId: p.id, displayName: p.displayName ?? p.id, version: r.version, permissions: r.permissions ?? [] }
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
    onSubmit(form)
  }

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
            {busy ? 'Installing…' : found ? `Install ${found.displayName} ${found.version}` : 'Install'}
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
          <p>
            {found.displayName} {found.version}{' '}
            {found.permissions.length ? 'asks for these permissions:' : 'asks for no permission beyond keeping its own data.'}
          </p>
          <ul className={styles.permissionList}>
            {found.permissions.map((p) => (
              <li key={p}>
                <div className={styles.permissionTitle}>{isPluginPermission(p) ? PERMISSION_TEXT[p].title : p}</div>
                <p className={styles.permissionText}>{isPluginPermission(p) ? PERMISSION_TEXT[p].consent : 'Unknown to this RedAmon.'}</p>
              </li>
            ))}
          </ul>
          <label className={styles.consentLine}>
            <input type="checkbox" className="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>I have read what this plugin may do, and I allow it for every user of this RedAmon.</span>
          </label>
        </>
      )}
    </Modal>
  )
}
