import { resolveForProject, type ResolvedPart } from './overrides'
import { pluginsEnabled } from './switch'

/**
 * The approved skill-text overrides the agent receives for a project in its settings
 * payload (`skillTextOverrides`), or undefined while the plugin platform is off.
 * Computed from the database alone, so the agent's settings fetch never waits on
 * plugin code or the runner.
 */
export async function computeSkillTextOverrides(
  projectId: string,
): Promise<Record<string, ResolvedPart> | undefined> {
  if (!pluginsEnabled()) return undefined
  return resolveForProject(projectId)
}
