import { KNOWN_ATTACK_PATH_CONFIG } from '@/app/graph/components/AIAssistantDrawer/phaseConfig'

/** The three keys of KNOWN_ATTACK_PATH_CONFIG that are phases, not skills. */
const PHASES = new Set(['informational', 'exploitation', 'post_exploitation'])

/**
 * The built-in skills whose text a plugin may override (the 14 of README.PLUGINS.md §7.6),
 * derived from the agent's attack-path config so the list cannot drift from it.
 */
export const BUILTIN_SKILLS: { id: string; displayName: string }[] = Object.entries(KNOWN_ATTACK_PATH_CONFIG)
  .filter(([id]) => !PHASES.has(id))
  .map(([id, c]) => ({ id, displayName: c.label }))

export const BUILTIN_SKILL_IDS: ReadonlySet<string> = new Set(BUILTIN_SKILLS.map((s) => s.id))

export function isBuiltinSkill(id: unknown): id is string {
  return typeof id === 'string' && BUILTIN_SKILL_IDS.has(id)
}
