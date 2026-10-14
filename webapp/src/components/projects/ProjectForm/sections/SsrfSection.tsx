'use client'

import type { Project } from '@prisma/client'
import { Toggle } from '@/components/ui/Toggle/Toggle'
import { WikiInfoButton } from '@/components/ui/WikiInfoButton'
import { FileImportButton } from '../FileImportButton'
import styles from '../ProjectForm.module.css'

type FormData = Omit<Project, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'user'>

interface SsrfSectionProps {
  data: FormData
  updateField: <K extends keyof FormData>(field: K, value: FormData[K]) => void
}

export function SsrfSection({ data, updateField }: SsrfSectionProps) {
  return (
    <div className={styles.skillSettings}>
      <div className={styles.skillSettingsHead}>
        <p className={styles.sectionDescription}>
          Configure which SSRF sub-workflows to inject into the agent prompt and tune
          probe parameters. Disable sections you don&apos;t want the agent to use for this engagement.
        </p>
        <WikiInfoButton target="https://github.com/samugit83/redamon/wiki/Agent-Skills" title="Open Agent Skills wiki page" />
      </div>

      <h3 className={styles.subSectionTitle}>Sub-workflow injection</h3>

      <div>
        <div className={styles.toggleRow}>
          <div>
            <span className={styles.toggleLabel}>OOB callback workflow (interactsh)</span>
            <p className={styles.toggleDescription}>
              Adds the blind-SSRF / OOB sub-prompt. Sends DNS and HTTP probes to the configured OOB provider.
            </p>
          </div>
          <Toggle
            checked={data.ssrfOobCallbackEnabled ?? true}
            onChange={(checked) => updateField('ssrfOobCallbackEnabled', checked)}
            aria-label="OOB callback workflow (interactsh)"
          />
        </div>

        <div className={styles.toggleRow}>
          <div>
            <span className={styles.toggleLabel}>Cloud metadata pivots</span>
            <p className={styles.toggleDescription}>
              Allows probing 169.254.169.254, metadata.google.internal, and equivalents. Disable for engagements where cloud-metadata access is forbidden.
            </p>
          </div>
          <Toggle
            checked={data.ssrfCloudMetadataEnabled ?? true}
            onChange={(checked) => updateField('ssrfCloudMetadataEnabled', checked)}
            aria-label="Cloud metadata pivots"
          />
        </div>

        <div className={styles.toggleRow}>
          <div>
            <span className={styles.toggleLabel}>Gopher / RCE-chain payloads</span>
            <p className={styles.toggleDescription}>
              Adds gopher://, dict://, file:// and Redis / FastCGI / Docker RCE chain sub-prompts. Disable when RoE forbids RCE escalation.
            </p>
          </div>
          <Toggle
            checked={data.ssrfGopherEnabled ?? true}
            onChange={(checked) => updateField('ssrfGopherEnabled', checked)}
            aria-label="Gopher / RCE-chain payloads"
          />
        </div>

        <div className={styles.toggleRow}>
          <div>
            <span className={styles.toggleLabel}>DNS rebinding bypasses</span>
            <p className={styles.toggleDescription}>
              Adds bypasses via 1u.ms, nip.io, rbndr.us. Disable when external DNS-rebind services are off-limits.
            </p>
          </div>
          <Toggle
            checked={data.ssrfDnsRebindingEnabled ?? true}
            onChange={(checked) => updateField('ssrfDnsRebindingEnabled', checked)}
            aria-label="DNS rebinding bypasses"
          />
        </div>

        <div className={styles.toggleRow}>
          <div>
            <span className={styles.toggleLabel}>Advanced payload reference + HackerOne precedents</span>
            <p className={styles.toggleDescription}>
              Injects URL parser confusion payloads, encoding variants, and a HackerOne precedent table (~3 KB extra). Disable for a leaner prompt.
            </p>
          </div>
          <Toggle
            checked={data.ssrfPayloadReferenceEnabled ?? true}
            onChange={(checked) => updateField('ssrfPayloadReferenceEnabled', checked)}
            aria-label="Advanced payload reference + HackerOne precedents"
          />
        </div>
      </div>

      <h3 className={styles.subSectionTitle}>Probe parameters</h3>

      <div className={styles.fieldRow}>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Request Timeout (seconds)</label>
          <input
            type="number"
            className="textInput"
            value={data.ssrfRequestTimeout ?? 10}
            onChange={(e) => updateField('ssrfRequestTimeout', parseInt(e.target.value) || 10)}
            min={1}
            max={120}
          />
          <span className={styles.fieldHint}>
            curl --max-time / --connect-timeout for each SSRF probe. Lower values speed up port-scan loops but may miss slow internal services.
          </span>
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>OOB Provider</label>
          <input
            type="text"
            className="textInput"
            value={data.ssrfOobProvider ?? 'oast.fun'}
            onChange={(e) => updateField('ssrfOobProvider', e.target.value)}
            placeholder="oast.fun"
          />
          <span className={styles.fieldHint}>
            interactsh-client server. Use a self-hosted instance if oast.fun is blocked.
          </span>
        </div>
      </div>

      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>Port-scan Ports</label>
        <div className={styles.fileImportWrap}>
          <input
            type="text"
            className="textInput"
            value={data.ssrfPortScanPorts ?? ''}
            onChange={(e) => updateField('ssrfPortScanPorts', e.target.value)}
            placeholder="22,80,443,2375,3306,5432,6379,8080,8500,9200,27017"
          />
          <FileImportButton
            fieldName="ports"
            validator={(t) => /^\d+$/.test(t)}
            onImport={(values) => updateField('ssrfPortScanPorts', values.join(','))}
          />
        </div>
        <span className={styles.fieldHint}>
          Comma-separated ports to probe via SSRF. Trim for quieter scans, extend for thorough coverage.
        </span>
      </div>

      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>Internal CIDR Ranges</label>
        <div className={styles.fileImportWrap}>
          <input
            type="text"
            className="textInput"
            value={data.ssrfInternalRanges ?? ''}
            onChange={(e) => updateField('ssrfInternalRanges', e.target.value)}
            placeholder="127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16"
          />
          <FileImportButton
            fieldName="CIDR ranges"
            onImport={(values) => updateField('ssrfInternalRanges', values.join(','))}
          />
        </div>
        <span className={styles.fieldHint}>
          Comma-separated CIDR blocks the agent treats as internal. Adjust for orgs using non-standard internal addressing (e.g., 100.64.0.0/10 carrier-grade NAT).
        </span>
      </div>

      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>Cloud Providers in Scope</label>
        <div className={styles.fileImportWrap}>
          <input
            type="text"
            className="textInput"
            value={data.ssrfCloudProviders ?? ''}
            onChange={(e) => updateField('ssrfCloudProviders', e.target.value)}
            placeholder="aws,gcp,azure,digitalocean,alibaba"
          />
          <FileImportButton
            fieldName="cloud providers"
            onImport={(values) => updateField('ssrfCloudProviders', values.join(','))}
          />
        </div>
        <span className={styles.fieldHint}>
          Comma-separated cloud providers to include in the metadata-pivots section. Filters which provider endpoint tables ship in the prompt. Ignored when cloud metadata is disabled.
        </span>
      </div>

      <h3 className={styles.subSectionTitle}>Site-specific internal targets (optional)</h3>

      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>Custom Internal Targets</label>
        <div className={styles.fileImportWrap}>
          <textarea
            className={`textarea ${styles.monoTextarea}`}
            rows={4}
            value={data.ssrfCustomInternalTargets ?? ''}
            onChange={(e) => updateField('ssrfCustomInternalTargets', e.target.value)}
            placeholder={'admin.internal.example.com\n10.20.30.40:8500\njumphost.corp.local'}
          />
          <FileImportButton
            variant="textarea"
            fieldName="internal targets"
            onImport={(values) => updateField('ssrfCustomInternalTargets', values.join('\n'))}
          />
        </div>
        <span className={styles.fieldHint}>
          One hostname or IP[:port] per line. Injected into the prompt so the agent prioritizes these alongside the generic loopback / RFC1918 sweep.
        </span>
      </div>
    </div>
  )
}
