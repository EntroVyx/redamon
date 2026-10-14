'use client'

import type { Project } from '@prisma/client'
import { Toggle } from '@/components/ui/Toggle/Toggle'
import { WikiInfoButton } from '@/components/ui/WikiInfoButton'
import styles from '../ProjectForm.module.css'

type FormData = Omit<Project, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'user'>

interface DeserializationSectionProps {
  data: FormData
  updateField: <K extends keyof FormData>(field: K, value: FormData[K]) => void
}

// Canonical order: the agent's prompt builder reads the same ids.
const RUNTIMES: { id: string; label: string }[] = [
  { id: 'java', label: 'Java (native)' },
  { id: 'java_typed', label: 'Java JSON / XML / YAML' },
  { id: 'python', label: 'Python' },
  { id: 'php', label: 'PHP' },
  { id: 'node', label: 'Node' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'dotnet', label: '.NET' },
]
const ALL_RUNTIMES = RUNTIMES.map(r => r.id).join(',')

function parseRuntimes(value: string | null | undefined): Set<string> {
  const known = new Set(RUNTIMES.map(r => r.id))
  const picked = (value ?? ALL_RUNTIMES).split(',').map(s => s.trim().toLowerCase()).filter(s => known.has(s))
  return new Set(picked.length ? picked : RUNTIMES.map(r => r.id))
}

export function DeserializationSection({ data, updateField }: DeserializationSectionProps) {
  const oobOn = data.deserializationOobCallbackEnabled ?? true
  const runtimes = parseRuntimes(data.deserializationRuntimes)
  const phpOn = runtimes.has('php')

  const toggleRuntime = (id: string, on: boolean) => {
    const next = new Set(runtimes)
    if (on) next.add(id)
    else next.delete(id)
    updateField('deserializationRuntimes', RUNTIMES.map(r => r.id).filter(r => next.has(r)).join(','))
  }

  return (
    <div className={styles.skillSettings}>
      <div className={styles.skillSettingsHead}>
        <p className={styles.sectionDescription}>
          Choose which sub-workflows the agent prompt carries. A block whose switch is off is left
          out of the prompt, and the agent is told not to use it.
        </p>
        <WikiInfoButton target="https://github.com/samugit83/redamon/wiki/Agent-Skills#insecure-deserialization" title="Open Agent Skills wiki page" />
      </div>

      <h3 className={styles.subSectionTitle}>Confirmation channels</h3>

      <div>
        <div className={styles.toggleRow}>
          <div>
            <span className={styles.toggleLabel}>OOB callback workflow (interactsh)</span>
            <p className={styles.toggleDescription}>
              Adds the out-of-band oracle: the agent registers a domain on the OOB provider and sends a
              harmless object that makes the target look it up. Disable when external callbacks are
              forbidden; the agent then confirms through the timing and error channels only.
            </p>
          </div>
          <Toggle
            checked={oobOn}
            onChange={(checked) => updateField('deserializationOobCallbackEnabled', checked)}
            aria-label="OOB callback workflow (interactsh)"
          />
        </div>
      </div>

      <div className={`${styles.fieldRow} ${styles.fieldRowHalf}`}>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>OOB Provider</label>
          <input
            type="text"
            className="textInput"
            value={data.deserializationOobProvider ?? 'oast.fun'}
            onChange={(e) => updateField('deserializationOobProvider', e.target.value)}
            placeholder="oast.fun"
            disabled={!oobOn}
          />
          <span className={styles.fieldHint}>
            interactsh server. Use a self-hosted instance if oast.fun is blocked. Only used when the
            OOB callback workflow is enabled.
          </span>
        </div>
      </div>

      <div>
        <div className={styles.toggleRow}>
          <div>
            <span className={styles.toggleLabel}>Timing channel</span>
            <p className={styles.toggleDescription}>
              Adds the timing sub-prompt: the agent compares response times to prove the server tried to
              connect while deserializing. It holds a request open on the target until a delay or timeout
              ends; disable on fragile targets. The error channel is always available.
            </p>
          </div>
          <Toggle
            checked={data.deserializationTimingEnabled ?? true}
            onChange={(checked) => updateField('deserializationTimingEnabled', checked)}
            aria-label="Timing channel"
          />
        </div>
      </div>

      <h3 className={styles.subSectionTitle}>Scope</h3>

      <div>
        <div className={styles.toggleRow}>
          <div>
            <span className={styles.toggleLabel}>Find sinks beyond recon candidates</span>
            <p className={styles.toggleDescription}>
              Adds the sweep of every cookie, header, parameter and body for serialized blobs recon never
              flagged, and the format reference. When off, the agent only confirms recon&apos;s candidates.
            </p>
          </div>
          <Toggle
            checked={data.deserializationFindSinksEnabled ?? true}
            onChange={(checked) => updateField('deserializationFindSinksEnabled', checked)}
            aria-label="Find sinks beyond recon candidates"
          />
        </div>
      </div>

      <div className={styles.fieldGroup}>
        <span className={styles.fieldLabel}>Runtimes to cover</span>
        <div className={styles.chipGroup} role="group" aria-label="Runtimes to cover">
          {RUNTIMES.map(r => {
            const on = runtimes.has(r.id)
            return (
              <button
                key={r.id}
                type="button"
                aria-pressed={on}
                className={`${styles.chip} ${on ? styles.chipOn : ''}`}
                disabled={on && runtimes.size === 1}
                onClick={() => toggleRuntime(r.id, !on)}
              >
                {r.label}
              </button>
            )
          })}
        </div>
        <span className={styles.fieldHint}>
          Only the selected runtimes&apos; oracle blocks ship in the prompt. Narrow it only when you
          already know the target stack; a candidate in another runtime gets the error channel only.
        </span>
      </div>

      <h3 className={styles.subSectionTitle}>Impact (off by default)</h3>

      <div>
        <div className={styles.toggleRow}>
          <div>
            <span className={styles.toggleLabel}>Exec gadget step (RCE proof)</span>
            <p className={styles.toggleDescription}>
              After a sink is confirmed, the agent delivers ONE code-execution gadget that runs a command
              on the target and sends its output back over the OOB callback. Needs the OOB callback and the
              move to the exploitation phase. Enable only with explicit RoE permission.
              {!oobOn && ' Disabled while the OOB callback is off.'}
            </p>
          </div>
          <Toggle
            checked={data.deserializationExecGadgetsEnabled ?? false}
            onChange={(checked) => updateField('deserializationExecGadgetsEnabled', checked)}
            disabled={!oobOn}
            aria-label="Exec gadget step (RCE proof)"
          />
        </div>

        <div className={styles.toggleRow}>
          <div>
            <span className={styles.toggleLabel}>PHAR polyglot upload</span>
            <p className={styles.toggleDescription}>
              Adds the PHP PHAR polyglot sub-prompt. UPLOADS a file to the target; enable only with explicit
              RoE permission.
              {!phpOn && ' Disabled while PHP is not among the runtimes.'}
            </p>
          </div>
          <Toggle
            checked={data.deserializationPharEnabled ?? false}
            onChange={(checked) => updateField('deserializationPharEnabled', checked)}
            disabled={!phpOn}
            aria-label="PHAR polyglot upload"
          />
        </div>
      </div>
    </div>
  )
}
