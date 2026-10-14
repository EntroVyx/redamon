'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Download, GitBranch, Inbox, Loader2, Pencil, Search, ShieldOff, Swords, Trash2, Upload } from 'lucide-react'
import { Modal } from '@/components/ui/Modal/Modal'
import { useAlertModal, useToast, WikiInfoButton } from '@/components/ui'
import { OverrideReviewModal } from '@/components/plugins/review/OverrideReviewModal'
import { DESCRIPTION_MAX_CHARS, MAX_SKILLS_PER_USER, NAME_MAX_CHARS } from '@/lib/userSkills'
import { postUserSkillsChanged, useUserSkillsChanged } from '@/lib/userSkillsChannel'
import { nameCheckMessage, useSkillNameCheck } from './useSkillNameCheck'
import styles from './Settings.module.css'
import own from './AgentSkillsTab.module.css'

/** A row of GET /api/users/[id]/attack-skills. */
export interface UserSkillRow {
  id: string
  name: string
  description?: string | null
  createdAt: string
  version?: number | null
  lineageRootId?: string | null
  derivedFromName?: string | null
  originPluginId?: string | null
  quarantinedAt?: string | null
  quarantineReason?: string | null
  pendingChangeSetIds?: string[]
  duplicateName?: boolean
}

const QUARANTINE_TEXT: Record<string, string> = {
  plugin_version_revoked:
    'The plugin version that proposed this skill was revoked by the plugin catalog, so it was turned off in every project.',
  derived_from_revoked:
    'It was saved from a skill whose plugin version the plugin catalog revoked, so it carries that text on and was turned off in every project.',
}

function downloadText(name: string, content: string) {
  const blob = new Blob([content], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}.md`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Global Settings → Agent Skills: the user's own skills (upload, rename, describe,
 * download, delete, community import), the versions saved from a plugin's proposals with
 * their lineage, the proposals waiting for review, and the quarantine a revoked plugin
 * version puts on what it proposed.
 */
export function AgentSkillsTab({ userId }: { userId: string | null | undefined }) {
  const { alertError, alert: showAlert, confirm: showConfirm, dangerConfirm } = useAlertModal()
  const toast = useToast()
  const [skills, setSkills] = useState<UserSkillRow[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [importing, setImporting] = useState(false)
  const [upload, setUpload] = useState<{ content: string; name: string; description: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [edit, setEdit] = useState<{ id: string; name: string; description: string } | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [reviewChangeSetId, setReviewChangeSetId] = useState<string | null>(null)

  const fetchSkills = useCallback(async () => {
    if (!userId) return
    try {
      const resp = await fetch(`/api/users/${userId}/attack-skills`)
      if (resp.ok) setSkills(await resp.json())
    } catch (err) {
      console.error('Failed to fetch attack skills:', err)
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => { fetchSkills() }, [fetchSkills])
  useUserSkillsChanged(() => { fetchSkills() })

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return skills
    return skills.filter((s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q))
  }, [skills, query])

  const uploadCheck = useSkillNameCheck(userId, upload?.name ?? '', { enabled: !!upload && !!upload.name.trim() })
  const editCheck = useSkillNameCheck(userId, edit?.name ?? '', { exceptId: edit?.id, enabled: !!edit && !!edit.name.trim() })

  const onFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !userId) return
    const reader = new FileReader()
    reader.onload = () => {
      setUploadError(null)
      setUpload({ content: reader.result as string, name: file.name.replace(/\.md$/i, '').slice(0, NAME_MAX_CHARS), description: '' })
    }
    reader.readAsText(file)
    e.target.value = ''
  }, [userId])

  const confirmUpload = useCallback(async () => {
    if (!userId || !upload || !upload.name.trim()) return
    setUploading(true)
    try {
      const resp = await fetch(`/api/users/${userId}/attack-skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: upload.name, description: upload.description.trim() || null, content: upload.content }),
      })
      const body = await resp.json().catch(() => ({}))
      if (resp.ok) {
        setUpload(null)
        // This tab's own listener reads the list again, and so does every other open window.
        postUserSkillsChanged({})
        toast.success('Attack skill uploaded')
      } else if (body.code === 'name_taken') {
        setUploadError(body.error)
        if (typeof body.suggestion === 'string') setUpload((u) => (u ? { ...u, name: body.suggestion } : u))
      } else {
        alertError(body.error || 'Failed to upload skill')
      }
    } catch (err) {
      console.error('Failed to upload skill:', err)
      toast.error('Failed to upload skill')
    } finally {
      setUploading(false)
    }
  }, [userId, upload, fetchSkills, toast, alertError])

  const download = useCallback(async (skill: UserSkillRow) => {
    if (!userId) return
    try {
      const resp = await fetch(`/api/users/${userId}/attack-skills/${skill.id}`)
      if (resp.ok) downloadText(skill.name, (await resp.json()).content)
    } catch (err) {
      console.error('Failed to download skill:', err)
    }
  }, [userId])

  const remove = useCallback(async (skill: UserSkillRow) => {
    if (!userId) return
    const waiting = skill.pendingChangeSetIds?.length ?? 0
    const message = 'Delete this skill? It will be removed from all projects.' +
      (waiting ? ` Its ${waiting} proposal${waiting === 1 ? '' : 's'} waiting for review ${waiting === 1 ? 'is' : 'are'} deleted too.` : '')
    if (!(await showConfirm(message))) return
    try {
      const resp = await fetch(`/api/users/${userId}/attack-skills/${skill.id}`, { method: 'DELETE' })
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        alertError(body.error || 'Failed to delete skill')
        return
      }
      postUserSkillsChanged({})
      toast.success('Attack skill deleted')
    } catch (err) {
      console.error('Failed to delete skill:', err)
      toast.error('Failed to delete skill')
    }
  }, [userId, fetchSkills, showConfirm, alertError, toast])

  const release = useCallback(async (skill: UserSkillRow) => {
    if (!userId) return
    const ok = await dangerConfirm(
      `Release "${skill.name}"? Read its text first (Download): a plugin version the catalog revoked proposed it. ` +
      'Once released it can be turned on in your projects again.',
      'Release a quarantined skill',
      { confirmLabel: 'I have read it, release' },
    )
    if (!ok) return
    try {
      const resp = await fetch(`/api/users/${userId}/attack-skills/${skill.id}/release`, { method: 'POST' })
      const body = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        alertError(body.error || 'Failed to release the skill')
        return
      }
      postUserSkillsChanged({})
      toast.success('Skill released; turn it on in a project to use it')
    } catch {
      toast.error('Failed to release the skill')
    }
  }, [userId, dangerConfirm, alertError, fetchSkills, toast])

  const openEdit = useCallback((skill: UserSkillRow) => {
    setEditError(null)
    setEdit({ id: skill.id, name: skill.name, description: skill.description ?? '' })
  }, [])

  const saveEdit = useCallback(async () => {
    if (!userId || !edit) return
    setEditSaving(true)
    try {
      const resp = await fetch(`/api/users/${userId}/attack-skills/${edit.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: edit.name, description: edit.description.trim() || null }),
      })
      const body = await resp.json().catch(() => ({}))
      if (resp.ok) {
        setEdit(null)
        postUserSkillsChanged({})
        toast.success('Skill updated')
      } else if (body.code === 'name_taken' || body.code === 'name_invalid' || body.code === 'name_too_long') {
        setEditError(body.error)
      } else {
        alertError(body.error || 'Failed to update the skill')
      }
    } catch (err) {
      console.error('Failed to update skill:', err)
      toast.error('Failed to update the skill')
    } finally {
      setEditSaving(false)
    }
  }, [userId, edit, fetchSkills, toast, alertError])

  const importCommunity = useCallback(async () => {
    if (!userId) return
    setImporting(true)
    try {
      const resp = await fetch(`/api/users/${userId}/attack-skills/import-community`, { method: 'POST' })
      const data = await resp.json()
      if (resp.ok) {
        postUserSkillsChanged({})
        showAlert(importSummary(data))
      } else {
        alertError(data.error || 'Failed to import community skills')
      }
    } catch (err) {
      console.error('Failed to import community skills:', err)
    } finally {
      setImporting(false)
    }
  }, [userId, fetchSkills, showAlert, alertError])

  const atLimit = skills.length >= MAX_SKILLS_PER_USER

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
          <Swords size={16} /> Agent Skills
          <WikiInfoButton target="https://github.com/samugit83/redamon/wiki/Agent-Skills" title="Open Agent Skills wiki page" />
        </h2>
        <div className={own.headerActions}>
          <button className="secondaryButton" onClick={importCommunity} disabled={importing || atLimit}>
            {importing ? <Loader2 size={14} className={styles.spin} /> : <Download size={14} />}
            Import from Community
          </button>
          <label
            className="primaryButton"
            style={{ cursor: atLimit ? 'not-allowed' : 'pointer', opacity: atLimit ? 0.6 : 1 }}
            title={atLimit ? `You have ${MAX_SKILLS_PER_USER} skills, the maximum. Delete one first.` : undefined}
          >
            <Upload size={14} /> Upload Skill
            <input type="file" accept=".md" style={{ display: 'none' }} onChange={onFile} disabled={atLimit} />
          </label>
        </div>
      </div>
      <p className={styles.sectionHint}>
        Upload .md files defining custom attack skill workflows. Skills become available as toggles in all project settings.
        {' '}Browse <a href="https://github.com/samugit83/redamon/wiki/Agent-Skills#community-skills" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-primary)', textDecoration: 'underline' }}>community skills</a> for ready-to-use templates.
      </p>

      <div className={own.toolbar}>
        <label className={own.search}>
          <Search size={14} aria-hidden />
          <input
            className="textInput"
            type="search"
            placeholder="Search by name or description"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search your skills"
          />
        </label>
        <span className={own.count} data-testid="skill-count">{skills.length} of {MAX_SKILLS_PER_USER}</span>
      </div>

      {loading ? (
        <div className={styles.emptyState}><Loader2 size={16} className={styles.spin} /> Loading...</div>
      ) : skills.length === 0 ? (
        <div className={styles.emptyState}>No custom skills uploaded yet. Upload a .md file to get started.</div>
      ) : visible.length === 0 ? (
        <div className={styles.emptyState}>No skill matches “{query}”.</div>
      ) : (
        <div className={styles.providerList}>
          {visible.map((skill) => {
            const waiting = skill.pendingChangeSetIds?.length ?? 0
            return (
              <div key={skill.id} className={`${styles.providerCard} ${own.card}`} data-testid={`user-skill-${skill.id}`}>
                <span className={styles.providerIcon}><Swords size={16} /></span>
                <div className={styles.providerInfo}>
                  <div className={`${styles.providerName} ${own.nameRow}`}>
                    <span className={own.name}>{skill.name}</span>
                    {skill.version != null && (
                      <span className={own.badge} title={skill.derivedFromName ? `Saved as a new version of ${skill.derivedFromName}` : undefined}>
                        <GitBranch size={11} aria-hidden /> v{skill.version}{skill.derivedFromName ? ` · from ${skill.derivedFromName}` : ''}
                      </span>
                    )}
                    {waiting > 0 && (
                      <button type="button" className={own.chip} onClick={() => setReviewChangeSetId(skill.pendingChangeSetIds![0])}>
                        <Inbox size={11} aria-hidden /> {waiting} proposal{waiting === 1 ? '' : 's'}
                      </button>
                    )}
                    {skill.duplicateName && (
                      <span className={own.warn}><AlertTriangle size={11} aria-hidden /> Same name as another skill — rename one</span>
                    )}
                  </div>
                  <div className={styles.providerMeta}>
                    {skill.description || <span style={{ opacity: 0.5, fontStyle: 'italic' }}>No description</span>}
                  </div>
                  <div className={styles.providerMeta}>
                    Uploaded {new Date(skill.createdAt).toLocaleDateString()}
                  </div>
                  {skill.quarantinedAt && (
                    <div className={own.quarantine} role="status">
                      <ShieldOff size={14} aria-hidden />
                      <div>
                        <strong>Quarantined.</strong>{' '}
                        {QUARANTINE_TEXT[skill.quarantineReason ?? ''] ?? 'It was turned off in every project.'}
                        {' '}Read it before you release it.
                        <div className={own.quarantineActions}>
                          <button type="button" className="secondaryButton" onClick={() => download(skill)}><Download size={13} /> Read (download)</button>
                          <button type="button" className="secondaryButton" onClick={() => release(skill)}>Release</button>
                          <button type="button" className="secondaryButton" onClick={() => remove(skill)}><Trash2 size={13} /> Delete</button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <div className={styles.providerActions}>
                  <button className="iconButton" title="Edit name and description" onClick={() => openEdit(skill)}>
                    <Pencil size={14} />
                  </button>
                  <button className="iconButton" title="Download" onClick={() => download(skill)}>
                    <Download size={14} />
                  </button>
                  <button className="iconButton" title="Delete" onClick={() => remove(skill)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Modal
        isOpen={!!upload}
        onClose={() => setUpload(null)}
        title="Upload Attack Skill"
        size="small"
        footer={
          <>
            <button className="secondaryButton" onClick={() => setUpload(null)}>Cancel</button>
            <button
              className="primaryButton"
              disabled={!upload?.name.trim() || uploading || uploadCheck.state === 'taken' || uploadCheck.state === 'invalid'}
              onClick={confirmUpload}
            >
              {uploading ? <Loader2 size={14} className={styles.spin} /> : <Upload size={14} />}
              Upload
            </button>
          </>
        }
      >
        <div className="formGroup">
          <label className="formLabel" htmlFor="skill-upload-name">Skill Name</label>
          <input
            id="skill-upload-name"
            className="textInput"
            type="text"
            value={upload?.name ?? ''}
            onChange={(e) => { setUploadError(null); setUpload((u) => (u ? { ...u, name: e.target.value } : u)) }}
            placeholder="e.g. SQL Injection Workflow"
            maxLength={NAME_MAX_CHARS}
            autoFocus
          />
          <span className="formHint" role={uploadError || nameCheckMessage(uploadCheck) ? 'alert' : undefined}>
            {uploadError || nameCheckMessage(uploadCheck) || 'This name appears in project settings and classification badges.'}
          </span>
        </div>
        <div className="formGroup" style={{ marginTop: '12px' }}>
          <label className="formLabel" htmlFor="skill-upload-description">Description</label>
          <textarea
            id="skill-upload-description"
            className="textInput"
            rows={3}
            value={upload?.description ?? ''}
            onChange={(e) => setUpload((u) => (u ? { ...u, description: e.target.value } : u))}
            placeholder="e.g. SQL injection testing against web app parameters using sqlmap"
            maxLength={DESCRIPTION_MAX_CHARS}
          />
          <span className="formHint">
            Helps the agent understand when to use this skill. Without a description, the first 500 characters of the markdown are used instead - a good description improves classification accuracy.
          </span>
        </div>
      </Modal>

      <Modal
        isOpen={!!edit}
        onClose={() => setEdit(null)}
        title="Edit Skill"
        size="small"
        footer={
          <>
            <button className="secondaryButton" onClick={() => setEdit(null)}>Cancel</button>
            <button
              className="primaryButton"
              disabled={editSaving || !edit?.name.trim() || editCheck.state === 'taken' || editCheck.state === 'invalid'}
              onClick={saveEdit}
            >
              {editSaving ? <Loader2 size={14} className={styles.spin} /> : <Pencil size={14} />}
              Save
            </button>
          </>
        }
      >
        <div className="formGroup">
          <label className="formLabel" htmlFor="skill-edit-name">Name</label>
          <input
            id="skill-edit-name"
            className="textInput"
            type="text"
            value={edit?.name ?? ''}
            onChange={(e) => { setEditError(null); setEdit((x) => (x ? { ...x, name: e.target.value } : x)) }}
            maxLength={NAME_MAX_CHARS}
            autoFocus
          />
          <span className="formHint" role={editError || nameCheckMessage(editCheck) ? 'alert' : undefined}>
            {editError || nameCheckMessage(editCheck) || 'Names are unique among your skills, ignoring case and spacing.'}
          </span>
        </div>
        <div className="formGroup" style={{ marginTop: '12px' }}>
          <label className="formLabel" htmlFor="skill-edit-description">Description</label>
          <textarea
            id="skill-edit-description"
            className="textInput"
            rows={3}
            value={edit?.description ?? ''}
            onChange={(e) => setEdit((x) => (x ? { ...x, description: e.target.value } : x))}
            placeholder="e.g. SQL injection testing against web app parameters using sqlmap"
            maxLength={DESCRIPTION_MAX_CHARS}
          />
          <span className="formHint">
            Helps the agent understand when to use this skill. Without a description, the first 500 characters of the markdown are used instead - a good description improves classification accuracy.
          </span>
        </div>
      </Modal>

      {reviewChangeSetId && userId && (
        <OverrideReviewModal
          changeSetId={reviewChangeSetId}
          scopeOwnerId={userId}
          onClose={() => { setReviewChangeSetId(null); fetchSkills() }}
          onDecided={() => { setReviewChangeSetId(null); fetchSkills() }}
        />
      )}
    </div>
  )
}

/** The community import's answer, with each reason a skill was skipped said apart. */
export function importSummary(data: {
  imported?: number
  skippedBy?: Partial<Record<'duplicate' | 'limit' | 'fetchFailed' | 'tooLarge' | 'invalid', number>>
  skipped?: number
  message?: string
}): string {
  if (data.message) return data.message
  const by = data.skippedBy ?? {}
  const parts = [
    by.duplicate ? `${by.duplicate} already in your skills` : '',
    by.limit ? `${by.limit} over your ${MAX_SKILLS_PER_USER}-skill limit` : '',
    by.tooLarge ? `${by.tooLarge} too large` : '',
    by.fetchFailed ? `${by.fetchFailed} could not be fetched` : '',
    by.invalid ? `${by.invalid} not valid` : '',
  ].filter(Boolean)
  return `Imported ${data.imported ?? 0} community skill(s)` + (parts.length ? `; skipped ${parts.join(', ')}.` : '.')
}
