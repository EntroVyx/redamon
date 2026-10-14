import type { RiskFlag } from '@/lib/plugins/riskFlags'

/** Plain-words labels for the risk flags listed above the diff tabs (design §6, RV-32). */
export const RISK_COPY: Record<RiskFlag, string> = {
  exfiltration: 'sends data out',
  url_or_host: 'names a URL or host',
  guardrail_bypass: 'tells the agent to drop a scope, RoE or confirmation guard',
}

export function riskCopy(flags: RiskFlag[]): string {
  return flags.map((f) => RISK_COPY[f]).join('; ')
}
