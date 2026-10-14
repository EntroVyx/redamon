'use client'

/**
 * The project's current RoE document: what it is, when it applied, and the
 * documents it superseded.
 */
import { useState } from 'react'
import { Download, FileText, History, Trash2 } from 'lucide-react'
import { Modal } from '@/components/ui/Modal/Modal'
import { downloadRoeFile } from './roeClient'

interface Revision {
  id: string
  documentName: string
  appliedAt: string | null
  supersededAt: string
  reason: string
}

export interface RoeCurrentDocumentProps {
  projectId: string
  documentName: string
  appliedAt: string | null
  onRemove: () => void
  removing?: boolean
}

export function RoeCurrentDocument({ projectId, documentName, appliedAt, onRemove, removing }: RoeCurrentDocumentProps) {
  const [error, setError] = useState<string | null>(null)
  const [revisions, setRevisions] = useState<Revision[] | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  const openHistory = async () => {
    setHistoryOpen(true)
    setRevisions(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/roe/revisions`)
      const body = res.ok ? await res.json() : { revisions: [] }
      setRevisions(Array.isArray(body.revisions) ? body.revisions : [])
    } catch {
      setRevisions([])
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <FileText size={15} />
        <strong style={{ overflowWrap: 'anywhere' }}>{documentName}</strong>
        {appliedAt && (
          <span style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>
            applied {new Date(appliedAt).toLocaleString()}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="secondaryButton"
          onClick={async () => setError(await downloadRoeFile(`/api/projects/${projectId}/roe/download`, documentName))}
        >
          <Download size={14} /> Download
        </button>
        <button type="button" className="secondaryButton" onClick={openHistory}>
          <History size={14} /> History
        </button>
        <button type="button" className="secondaryButton" onClick={onRemove} disabled={removing}>
          <Trash2 size={14} /> {removing ? 'Preparing…' : 'Remove RoE'}
        </button>
      </div>
      {error && <span role="alert" style={{ color: 'var(--color-error)', fontSize: '0.8rem' }}>{error}</span>}

      <Modal isOpen={historyOpen} onClose={() => setHistoryOpen(false)} title="Superseded RoE documents" size="default">
        {revisions === null ? (
          <p>Loading…</p>
        ) : revisions.length === 0 ? (
          <p>No earlier document. A replaced or removed document is kept here (the newest ten).</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {revisions.map(r => (
              <li key={r.id}>
                <strong>{r.documentName}</strong>{' '}
                <span style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>
                  {r.reason} {new Date(r.supersededAt).toLocaleString()}
                  {r.appliedAt ? ` · applied ${new Date(r.appliedAt).toLocaleString()}` : ''}
                </span>{' '}
                <button
                  type="button"
                  className="secondaryButton"
                  style={{ padding: '2px 8px' }}
                  onClick={async () => setError(await downloadRoeFile(
                    `/api/projects/${projectId}/roe/revisions/${r.id}/download`, r.documentName))}
                >
                  <Download size={12} /> Download
                </button>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  )
}
