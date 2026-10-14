'use client'

import type { Project } from '@prisma/client'
import { WikiInfoButton } from '@/components/ui/WikiInfoButton'
import styles from '../ProjectForm.module.css'

type FormData = Omit<Project, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'user'>

interface PhishingSectionProps {
  data: FormData
  updateField: <K extends keyof FormData>(field: K, value: FormData[K]) => void
}

export function PhishingSection({ data, updateField }: PhishingSectionProps) {
  return (
    <div className={styles.skillSettings}>
      <div className={styles.skillSettingsHead}>
        <p className={styles.sectionDescription}>
          Configure SMTP settings for social engineering simulation email delivery. The agent uses these when sending
          payloads or documents via email. Leave empty to be asked at runtime.
        </p>
        <WikiInfoButton target="https://github.com/samugit83/redamon/wiki/Project-Settings-Reference#social-engineering-simulation" title="Open Social Engineering wiki section" />
      </div>

      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>SMTP Configuration (optional)</label>
        <textarea
          className={`textarea ${styles.monoTextarea}`}
          value={data.phishingSmtpConfig ?? ''}
          onChange={(e) => updateField('phishingSmtpConfig', e.target.value)}
          placeholder={`SMTP_HOST: smtp.gmail.com\nSMTP_PORT: 587\nSMTP_USER: pentest@gmail.com\nSMTP_PASS: abcd efgh ijkl mnop\nSMTP_FROM: it-support@company.com\nUSE_TLS: true`}
          rows={6}
        />
        <span className={styles.fieldHint}>
          Free-text SMTP settings injected into the agent prompt for social engineering email delivery.
          The agent reads this as-is when the social engineering simulation skill is active.
        </span>
      </div>
    </div>
  )
}
