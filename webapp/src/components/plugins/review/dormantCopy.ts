import type { DormantReason } from '@/lib/plugins/registry'

/**
 * Plain-words copy for why an active version is not reaching the agent (RV-26). Shown in the
 * review modal, the versions modal and the project-settings summary. Every DORMANT_REASONS
 * entry has copy here (a test pins that), so a new reason cannot ship without words.
 */
export const DORMANT_COPY: Record<DormantReason, string> = {
  switch_off: 'the plugin platform is switched off',
  uninstalled: 'the plugin is uninstalled',
  revoked: 'this version of the plugin was revoked',
  disabled: 'the plugin is disabled',
  not_ready: 'the plugin is not ready',
  permission_missing: 'the plugin no longer has the permission to change skill text',
  agent_outdated: 'the agent is too old to apply it',
}

export function dormantCopy(reason: DormantReason): string {
  return DORMANT_COPY[reason]
}
