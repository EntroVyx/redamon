/**
 * The rules a RoE can set that the agent does not yet enforce on their own.
 *
 * Every agent-side RoE check is gated on the derived "RoE enabled" flag, which
 * only a rate ceiling, an excluded host or a scanning window turns on. So a
 * document that forbids tools, caps the phase or turns the allow flags off,
 * and sets none of those three, configures rules the agent silently ignores.
 * Until the agent's gate counts them, the review and the RoE page say so.
 */
import { deriveRoeEnabled } from '@/lib/engagement'
import { engagementLimitFields } from '@/lib/reconSettings/registry'

export const AGENT_ENFORCEMENT_WARNING =
  'The agent will not enforce these rules until a rate ceiling, an excluded host or a scanning window is set.'

const AGENT_PERMISSION_PREFIXES = ['roeForbidden', 'roeAllow', 'roeMaxSeverityPhase']

/** The engagement-limit keys the agent reads as permissions. */
export function agentPermissionKeys(): string[] {
  return engagementLimitFields()
    .map(f => f.key)
    .filter(k => AGENT_PERMISSION_PREFIXES.some(p => k.startsWith(p)))
}

/**
 * The warning, when `setByDocument` names an agent permission key and the
 * resulting project values leave the RoE gate off; otherwise null.
 */
export function agentEnforcementWarning(
  setByDocument: Iterable<string>,
  resulting: Record<string, unknown>,
): string | null {
  const permissions = new Set(agentPermissionKeys())
  const touches = [...setByDocument].some(k => permissions.has(k))
  if (!touches) return null
  return deriveRoeEnabled(resulting as Parameters<typeof deriveRoeEnabled>[0]) ? null : AGENT_ENFORCEMENT_WARNING
}
