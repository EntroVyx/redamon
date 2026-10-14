'use client'

import { useState } from 'react'
import { AlertTriangle, Check, ChevronDown, Info, Plus, Shield } from 'lucide-react'
import { Toggle, WikiInfoButton, useToast } from '@/components/ui'
import type { Project } from '@prisma/client'
import { currentValuesForDiff, type ParseChange } from '@/lib/reconSettings/roeParse'
import { announceProjectWrite } from '@/lib/projectVersion'
import { RoeUploadButton } from '@/components/roe/RoeUploadButton'
import { RoeReviewModal } from '@/components/roe/RoeReviewModal'
import { RoeCurrentDocument } from '@/components/roe/RoeCurrentDocument'
import { reviewRemove } from '@/components/roe/roeClient'
import { clearRoeEntry, setRoeEntry, useRoeEntry, useRoeMounted } from '@/components/roe/roeParseStore'
import { roeAppliedSummary } from '@/components/roe/roeAppliedSummary'
import styles from '../ProjectForm.module.css'

type ProjectFormData = Omit<Project, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'user'>

interface RoeSectionProps {
  data: ProjectFormData
  updateField: <K extends keyof ProjectFormData>(field: K, value: ProjectFormData[K]) => void
  updateMultipleFields: (fields: Partial<ProjectFormData>) => void
  mode: 'create' | 'edit'
  onFileSelected: (file: File | null) => void
  /** The saved project, in edit mode: a confirmed RoE saves at once through its own route. */
  projectId?: string
  /** Merge the row the RoE route returned into the form and its baseline. */
  onServerRowMerged?: (row: Record<string, unknown>, changedKeys: string[]) => void
  /** Form fields edited and not yet saved, so a replace that overwrites one says so. */
  unsavedKeys?: string[]
}

const ENGAGEMENT_TYPES = [
  { value: 'external', label: 'External Penetration Test' },
  { value: 'internal', label: 'Internal Penetration Test' },
  { value: 'web_app', label: 'Web Application Test' },
  { value: 'api', label: 'API Security Test' },
  { value: 'mobile', label: 'Mobile Application Test' },
  { value: 'physical', label: 'Physical Security Test' },
  { value: 'social_engineering', label: 'Social Engineering' },
  { value: 'red_team', label: 'Red Team Engagement' },
]

const DATA_HANDLING_OPTIONS = [
  { value: 'no_access', label: 'No access to sensitive data' },
  { value: 'prove_access_only', label: 'Prove access only (no collection)' },
  { value: 'limited_collection', label: 'Limited collection' },
  { value: 'full_access', label: 'Full access' },
]

const COMPLIANCE_OPTIONS = ['PCI-DSS', 'HIPAA', 'SOC2', 'GDPR', 'ISO27001']

const RECORDED_PERMISSIONS = [
  {
    field: 'roeAllowPhysicalAccess',
    label: 'Allow Physical Access',
    description: 'On-site access to premises and hardware.',
  },
  {
    field: 'roeAllowDataExfiltration',
    label: 'Allow Data Exfiltration',
    description: 'Taking data out of the target, beyond proving access to it.',
  },
  {
    field: 'roeAllowProductionTesting',
    label: 'Allow Production Testing',
    description: 'Live production systems are in scope, not only staging or test.',
  },
] as const

/**
 * The engagement RECORD: who the client is, who to call, what the document said.
 *
 * Not the engagement's LIMITS. Those used to live here too, under the same `roe`
 * prefix and the same heading, and conflating them is what made a master switch
 * that disabled the rate ceiling look like an ordinary checkbox. The limits are
 * ordinary settings now: the rate ceiling, the excluded hosts and the scanning
 * window sit in Target & Modules, and the agent's denylists sit with the agent's
 * other behaviour.
 *
 * What is left here is the contract. A person writes it, a model reads it, and
 * nothing in the pipeline enforces it - which is exactly why the MCP surface
 * never touches it and why it carries third-party personal data.
 */
export function RoeSection({
  data, updateField, updateMultipleFields, mode, onFileSelected, projectId, onServerRowMerged, unsavedKeys,
}: RoeSectionProps) {
  const [isOpen, setIsOpen] = useState(true)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const toast = useToast()

  const readOnly = mode === 'edit'
  // A saved project replaces its RoE through the RoE route; a project being
  // created carries the document with its create request.
  const existing = mode === 'edit' && Boolean(projectId)
  const storeKey = existing ? projectId! : 'create'
  useRoeMounted(storeKey)
  const entry = useRoeEntry(storeKey)
  const stored = (data.roeParsedJson && typeof data.roeParsedJson === 'object' ? data.roeParsedJson : {}) as Record<string, unknown>
  const hasDocument = Boolean(data.roeDocumentName || data.roeRawText)

  // A project being created: the review fills the form, and the file goes with
  // the create. The server rebuilds the stored parse from these confirmed keys
  // and extracts the text itself; nothing here is trusted as sent.
  const applyProposal = (proposal: { changes: ParseChange[] } & Record<string, unknown>) => {
    const updates: Record<string, unknown> = {}
    for (const change of proposal.changes) updates[change.key] = change.after
    updates.roeParsedJson = {
      applied: Object.fromEntries(proposal.changes.map(c => [c.key, c.after])),
      // The pre-document values, so removing or replacing the document later
      // can restore them.
      before: Object.fromEntries(proposal.changes.map(c => [c.key, (data as Record<string, unknown>)[c.key]])),
      rejected: proposal.rejected,
      ignored: proposal.ignored,
      unknownKeys: proposal.unknownKeys,
      modelUsed: proposal.modelUsed,
    }
    updateMultipleFields(updates as Partial<ProjectFormData>)
    clearRoeEntry(storeKey)
  }

  const discard = () => {
    if (!existing) onFileSelected(null)
    clearRoeEntry(storeKey)
  }

  const applied = (result: Record<string, unknown>) => {
    const row = (result.project ?? {}) as Record<string, unknown>
    const changed = Array.isArray(result.changed) ? result.changed as string[] : []
    onServerRowMerged?.(row, changed)
    announceProjectWrite(projectId, row.updatedAt)
    clearRoeEntry(storeKey)
    toast.success(roeAppliedSummary(result), 'Rules of Engagement saved')
  }

  const startRemove = async () => {
    if (!projectId) return
    setRemoveError(null)
    setRemoving(true)
    const review = await reviewRemove(projectId)
    setRemoving(false)
    if (!review.ok) {
      setRemoveError(review.error.error)
      return
    }
    setRoeEntry(storeKey, { status: 'review', review: review.value, file: null, error: null })
  }

  const toggleCompliance = (fw: string) => {
    const current = data.roeComplianceFrameworks || []
    if (current.includes(fw)) {
      updateField('roeComplianceFrameworks', current.filter(c => c !== fw))
    } else {
      updateField('roeComplianceFrameworks', [...current, fw])
    }
  }

  return (
    <>
    <div className={`${styles.section} ${styles.formSkin}`}>
      <div className={styles.sectionHeader} onClick={() => setIsOpen(!isOpen)}>
        <h2 className={styles.sectionTitle}>
          <Shield size={16} />
          Engagement Record
          <WikiInfoButton target="Roe" />
        </h2>
        <ChevronDown
          size={16}
          className={`${styles.sectionIcon} ${isOpen ? styles.sectionIconOpen : ''}`}
        />
      </div>

      {isOpen && (
        <div className={styles.sectionContent}>
          {/* The document: upload on a new project, replace or remove on a saved one. */}
          <div className={styles.subSection}>
            <h3 className={styles.subSectionTitle}>Rules of Engagement document</h3>
            <p className={styles.sectionDescription}>
              Upload a Rules of Engagement document. It is read and turned into a{' '}
              <strong>proposed</strong> set of changes across the whole form: this record, the
              engagement&apos;s limits in Target &amp; Modules, and any tool the document constrains.
              Nothing is applied until you review the diff.
              {existing && ' A new document replaces the current one and undoes what it changed.'}
            </p>
            {existing && hasDocument && (
              <div>
                <RoeCurrentDocument
                  projectId={projectId!}
                  documentName={data.roeDocumentName || 'roe-document'}
                  appliedAt={typeof stored.appliedAt === 'string' ? stored.appliedAt : null}
                  onRemove={startRemove}
                  removing={removing}
                />
                {removeError && <span role="alert" className={styles.inlineError}>{removeError}</span>}
              </div>
            )}
            <RoeUploadButton
              storeKey={storeKey}
              projectId={existing ? projectId : null}
              hasDocument={hasDocument}
              currentForDiff={existing ? undefined : () => currentValuesForDiff(data as never)}
              onFileSelected={file => { if (!existing) onFileSelected(file) }}
            />
          </div>

          {/* Engagement kind: who the target belongs to, and therefore what has
              to be true before a scan may start. Create-time only, for the same
              reason the target is: converting a project afterwards would either
              claim an authority nobody granted or drop a ceiling a person set. */}
          <div className={styles.subSection}>
            <h3 className={styles.subSectionTitle}>Engagement</h3>
            <div className={styles.fieldRow}>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Whose estate is the target?</label>
                <select
                  className="select"
                  value={(data.engagementKind as string) || 'internal'}
                  disabled={readOnly}
                  onChange={(e) => updateField('engagementKind', e.target.value)}
                >
                  <option value="internal">Internal - our own estate</option>
                  <option value="third_party">Third party - somebody else&apos;s</option>
                </select>
                <span className={styles.fieldHint}>
                  Fixed at creation. A third-party engagement cannot start without a non-zero
                  request-rate ceiling AND a record of what authorized it.
                </span>
              </div>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Identity Header</label>
                <input
                  className="textInput"
                  value={(data.engagementIdentityHeader as string) || ''}
                  placeholder="X-Bug-Bounty: your-handle"
                  onChange={(e) => updateField('engagementIdentityHeader', e.target.value)}
                />
                <span className={styles.fieldHint}>
                  Sent with every request so the target&apos;s operators can attribute the traffic
                  to you. Many programs require one. Leave empty to send none.
                </span>
              </div>
            </div>
            {data.engagementKind === 'third_party' && !(data.roeGlobalMaxRps > 0) && (
              <div className={`${styles.callout} ${styles.calloutDanger}`}>
                <AlertTriangle size={14} />
                <span>
                  <strong>No request-rate ceiling.</strong> A third-party engagement needs one, or its
                  scans will be refused. Set it in Target &amp; Modules &rarr; Engagement limits.
                </span>
              </div>
            )}
            <div className={styles.callout}>
              <Info size={14} />
              <span>
                <strong>This record is the contract:</strong> who the client is, who to call, what the
                document said. Nothing here constrains a scan. The limits that do - the rate ceiling,
                the excluded hosts, the scanning window and the agent&apos;s denylists - are ordinary
                settings, editable at any time, in Target &amp; Modules and Agent Behaviour.
              </span>
            </div>
          </div>

          {/* Client & Engagement */}
          <div className={styles.subSection}>
            <h3 className={styles.subSectionTitle}>Client &amp; Engagement</h3>
            <div className={styles.fieldRow}>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Client Name</label>
                <input className="textInput" value={data.roeClientName} readOnly={readOnly}
                  onChange={(e) => updateField('roeClientName', e.target.value)} />
              </div>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Engagement Type</label>
                <select className="select" value={data.roeEngagementType} disabled={readOnly}
                  onChange={(e) => updateField('roeEngagementType', e.target.value)}>
                  {ENGAGEMENT_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className={styles.fieldRow}>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Contact Name</label>
                <input className="textInput" value={data.roeClientContactName} readOnly={readOnly}
                  onChange={(e) => updateField('roeClientContactName', e.target.value)} />
              </div>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Contact Email</label>
                <input className="textInput" type="email" value={data.roeClientContactEmail} readOnly={readOnly}
                  onChange={(e) => updateField('roeClientContactEmail', e.target.value)} />
              </div>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Contact Phone</label>
                <input className="textInput" value={data.roeClientContactPhone} readOnly={readOnly}
                  onChange={(e) => updateField('roeClientContactPhone', e.target.value)} />
              </div>
            </div>
            <div className={styles.fieldRow}>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Emergency Contact</label>
                <input className="textInput" value={data.roeEmergencyContact} readOnly={readOnly}
                  onChange={(e) => updateField('roeEmergencyContact', e.target.value)} />
              </div>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Start Date</label>
                <input className="textInput" type="date" value={data.roeEngagementStartDate} readOnly={readOnly}
                  onChange={(e) => updateField('roeEngagementStartDate', e.target.value)} />
              </div>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>End Date</label>
                <input className="textInput" type="date" value={data.roeEngagementEndDate} readOnly={readOnly}
                  onChange={(e) => updateField('roeEngagementEndDate', e.target.value)} />
              </div>
            </div>
          </div>

          {/* Recorded permissions. These three are RECORD rather than limit: the
              pipeline has no physical capability, production is a statement about
              the estate that no scanner can verify, and exfiltration reaches the
              agent as prompt text. The three that ARE enforced in code live with
              the agent's other behaviour. */}
          <div className={styles.subSection}>
            <h3 className={styles.subSectionTitle}>Recorded Permissions</h3>
            <p className={styles.sectionDescription}>
              Read by the agent as prompt context and printed in the report. The permissions
              enforced in code - availability testing, social engineering, account lockout,
              forbidden tools and categories, the severity cap - are in Agent Behaviour.
            </p>
            {RECORDED_PERMISSIONS.map(p => (
              <div key={p.field} className={styles.toggleRow}>
                <div>
                  <span className={styles.toggleLabel}>{p.label}</span>
                  <p className={styles.toggleDescription}>{p.description}</p>
                </div>
                <Toggle checked={Boolean(data[p.field])} disabled={readOnly} aria-label={p.label}
                  onChange={(checked) => updateField(p.field, checked)} />
              </div>
            ))}
          </div>

          {/* Data Handling */}
          <div className={styles.subSection}>
            <h3 className={styles.subSectionTitle}>Data Handling</h3>
            <div className={styles.fieldRow}>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Sensitive Data Policy</label>
                <select className="select" value={data.roeSensitiveDataHandling} disabled={readOnly}
                  onChange={(e) => updateField('roeSensitiveDataHandling', e.target.value)}>
                  {DATA_HANDLING_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Data Retention (days)</label>
                <input className="textInput" type="number" min={0} max={3650}
                  value={data.roeDataRetentionDays} readOnly={readOnly}
                  onChange={(e) => updateField('roeDataRetentionDays', parseInt(e.target.value) || 90)} />
              </div>
            </div>
            <div className={styles.toggleRow}>
              <span className={styles.toggleLabel}>Require data encryption</span>
              <Toggle checked={data.roeRequireDataEncryption} disabled={readOnly} aria-label="Require data encryption"
                onChange={(checked) => updateField('roeRequireDataEncryption', checked)} />
            </div>
          </div>

          {/* Communication */}
          <div className={styles.subSection}>
            <h3 className={styles.subSectionTitle}>Communication</h3>
            <div className={`${styles.fieldRow} ${styles.fieldRowHalf}`}>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Status Update Frequency</label>
                <select className="select" value={data.roeStatusUpdateFrequency} disabled={readOnly}
                  onChange={(e) => updateField('roeStatusUpdateFrequency', e.target.value)}>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="on_finding">On each finding</option>
                  <option value="none">None</option>
                </select>
              </div>
            </div>
            <div className={styles.toggleRow}>
              <span className={styles.toggleLabel}>Notify client on critical findings</span>
              <Toggle checked={data.roeCriticalFindingNotify} disabled={readOnly} aria-label="Notify client on critical findings"
                onChange={(checked) => updateField('roeCriticalFindingNotify', checked)} />
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>Incident Procedure</label>
              <textarea className="textarea" rows={3} value={data.roeIncidentProcedure} readOnly={readOnly}
                onChange={(e) => updateField('roeIncidentProcedure', e.target.value)}
                placeholder="What to do if testing causes an incident..." />
            </div>
          </div>

          {/* Compliance */}
          <div className={styles.subSection}>
            <h3 className={styles.subSectionTitle}>Compliance &amp; Authorization</h3>
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>Compliance Frameworks</label>
              <div className={styles.chipGroup} role="group" aria-label="Compliance frameworks">
                {COMPLIANCE_OPTIONS.map(fw => {
                  const on = (data.roeComplianceFrameworks || []).includes(fw)
                  return (
                    <button key={fw} type="button" aria-pressed={on} disabled={readOnly}
                      className={`${styles.complianceChip} ${on ? styles.chipOn : ''}`}
                      onClick={() => toggleCompliance(fw)}>
                      {on ? <Check size={12} /> : <Plus size={12} />}
                      {fw}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>Cloud/hosting providers with separate authorization</label>
              <input className="textInput" type="text" readOnly={readOnly}
                value={(data.roeThirdPartyProviders || []).join(', ')}
                onChange={(e) => updateField('roeThirdPartyProviders', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))}
                placeholder="e.g. AWS, Hetzner, Cloudflare" />
            </div>
          </div>

          {/* Notes */}
          <div className={styles.subSection}>
            <h3 className={styles.subSectionTitle}>Notes</h3>
            <textarea className="textarea" rows={4} value={data.roeNotes} readOnly={readOnly}
              onChange={(e) => updateField('roeNotes', e.target.value)}
              placeholder="Additional rules not captured by fields above..." />
          </div>

          {/* Raw RoE Text (always read-only) */}
          {data.roeRawText && (
            <div className={styles.subSection}>
              <h3 className={styles.subSectionTitle}>Extracted Document Text</h3>
              <textarea className={`textarea ${styles.rawDocumentText}`} rows={8} value={data.roeRawText} readOnly />
            </div>
          )}
        </div>
      )}
    </div>

    {/* The parse result is a PROPOSAL, confirmed all or nothing. */}
    {entry.status === 'review' && entry.review && (
      <RoeReviewModal
        review={entry.review}
        target={existing ? 'existing' : 'create'}
        projectId={existing ? projectId : null}
        file={entry.file}
        unsavedKeys={unsavedKeys}
        onClose={discard}
        onApplyToForm={review => applyProposal(review as { changes: ParseChange[] } & Record<string, unknown>)}
        onApplied={applied}
        onReviewChanged={review => setRoeEntry(storeKey, { review })}
      />
    )}
    </>
  )
}
