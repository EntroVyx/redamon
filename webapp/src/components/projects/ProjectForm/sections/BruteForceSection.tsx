'use client'

import type { Project } from '@prisma/client'
import { Toggle } from '@/components/ui/Toggle/Toggle'
import { WikiInfoButton } from '@/components/ui/WikiInfoButton'
import styles from '../ProjectForm.module.css'

type FormData = Omit<Project, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'user'>

interface HydraSectionProps {
  data: FormData
  updateField: <K extends keyof FormData>(field: K, value: FormData[K]) => void
}

// Hydra's -e flags, stored concatenated in hydraExtraChecks.
const EXTRA_CHECKS = [
  { flag: 'n', label: 'Null/empty password (n)' },
  { flag: 's', label: 'Username as password (s)' },
  { flag: 'r', label: 'Reversed username (r)' },
]

export function HydraSection({ data, updateField }: HydraSectionProps) {
  const extraChecks = (data.hydraExtraChecks ?? 'nsr') as string

  const toggleExtraCheck = (flag: string) => {
    let current = extraChecks
    if (current.includes(flag)) {
      current = current.replace(flag, '')
    } else {
      current += flag
    }
    updateField('hydraExtraChecks', current)
  }

  return (
    <div className={styles.skillSettings}>
      <div className={styles.skillSettingsHead}>
        <p className={styles.sectionDescription}>
          Configure THC Hydra credential testing settings. Hydra supports 50+ protocols
          including SSH, FTP, RDP, SMB, HTTP forms, databases, and more.
        </p>
        <WikiInfoButton target="https://github.com/samugit83/redamon/wiki/Project-Settings-Reference#hydra-credential-testing" title="Open Hydra wiki section" />
      </div>

      {/* Threads + Wait Between Connections */}
      <div className={styles.fieldRow}>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Threads (-t)</label>
          <input
            type="number"
            className="textInput"
            value={data.hydraThreads ?? 16}
            onChange={(e) => updateField('hydraThreads', parseInt(e.target.value) || 16)}
            min={1}
            max={64}
          />
          <span className={styles.fieldHint}>
            Parallel connections per target. SSH max 4, RDP max 1. Default: 16.
          </span>
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Wait Between Connections (-W)</label>
          <input
            type="number"
            className="textInput"
            value={data.hydraWaitBetweenConnections ?? 0}
            onChange={(e) => updateField('hydraWaitBetweenConnections', parseInt(e.target.value) || 0)}
            min={0}
            max={300}
          />
          <span className={styles.fieldHint}>
            Seconds between each connection per task. 0 = no delay.
          </span>
        </div>
      </div>

      {/* Connection Timeout + Max Wordlist Attempts */}
      <div className={styles.fieldRow}>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Connection Timeout (-w)</label>
          <input
            type="number"
            className="textInput"
            value={data.hydraConnectionTimeout ?? 32}
            onChange={(e) => updateField('hydraConnectionTimeout', parseInt(e.target.value) || 32)}
            min={5}
            max={120}
          />
          <span className={styles.fieldHint}>
            Max seconds to wait for a response from the target. Default: 32.
          </span>
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Max Wordlist Attempts</label>
          <input
            type="number"
            className="textInput"
            value={data.hydraMaxWordlistAttempts ?? 3}
            onChange={(e) => updateField('hydraMaxWordlistAttempts', parseInt(e.target.value) || 3)}
            min={1}
            max={10}
          />
          <span className={styles.fieldHint}>
            How many wordlist strategies to try before giving up.
          </span>
        </div>
      </div>

      <div>
        <div className={styles.toggleRow}>
          <div>
            <span className={styles.toggleLabel}>Stop On First Found (-f)</span>
            <p className={styles.toggleDescription}>
              Stop immediately when valid credentials are found.
            </p>
          </div>
          <Toggle
            checked={data.hydraStopOnFirstFound ?? true}
            onChange={(checked) => updateField('hydraStopOnFirstFound', checked)}
            aria-label="Stop On First Found (-f)"
          />
        </div>
        <div className={styles.toggleRow}>
          <div>
            <span className={styles.toggleLabel}>Verbose Output (-V)</span>
            <p className={styles.toggleDescription}>
              Show each login attempt in output for progress tracking.
            </p>
          </div>
          <Toggle
            checked={data.hydraVerbose ?? true}
            onChange={(checked) => updateField('hydraVerbose', checked)}
            aria-label="Verbose Output (-V)"
          />
        </div>
      </div>

      <div className={styles.fieldGroup}>
        <span className={styles.fieldLabel}>Extra Password Checks (-e)</span>
        <div className={styles.chipGroup} role="group" aria-label="Extra Password Checks (-e)">
          {EXTRA_CHECKS.map(check => {
            const on = extraChecks.includes(check.flag)
            return (
              <button
                key={check.flag}
                type="button"
                aria-pressed={on}
                className={`${styles.chip} ${on ? styles.chipOn : ''}`}
                onClick={() => toggleExtraCheck(check.flag)}
              >
                {check.label}
              </button>
            )
          })}
        </div>
        <span className={styles.fieldHint}>
          Additional password variations tried before the wordlist. Common quick wins.
        </span>
      </div>
    </div>
  )
}
