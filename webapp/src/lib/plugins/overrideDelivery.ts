import { resolveForProject, type ResolvedPart } from './overrides'

/**
 * The approved skill-text overrides the agent receives for a project in its settings
 * payload (`skillTextOverrides`). Computed from the database alone, so the agent's
 * settings fetch never waits on plugin code or the runner.
 */
export async function computeSkillTextOverrides(projectId: string): Promise<Record<string, ResolvedPart>> {
  return resolveForProject(projectId)
}
