import type { ReviewModel } from '@/lib/plugins/reviewModel'
import type { UserSkillReviewModel } from '@/lib/plugins/userSkillReviewModel'
import type { VersionsModel } from '@/lib/plugins/versionsModel'
import type { UserSkillVersionsModel } from '@/lib/plugins/userSkillVersionsModel'

/** The browser side of the core override routes (design §6). */
export class OverrideApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'OverrideApiError'
  }
}

async function answer(res: Response): Promise<unknown> {
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; code?: string } & Record<string, unknown>
    throw new OverrideApiError(b.code ?? `http_${res.status}`, b.error ?? `HTTP ${res.status}`, res.status, b)
  }
  return body
}

const base = (changeSetId: string) => `/api/plugins/overrides/change-sets/${encodeURIComponent(changeSetId)}`

export async function fetchReviewModel(changeSetId: string, projectId?: string | null): Promise<ReviewModel | UserSkillReviewModel> {
  const qs = projectId ? `?${new URLSearchParams({ projectId })}` : ''
  return answer(await fetch(`${base(changeSetId)}${qs}`, { cache: 'no-store' })) as Promise<ReviewModel | UserSkillReviewModel>
}

export interface SaveUserSkillInput {
  scopeOwnerId: string | null
  name: string
  description: string | null
  projectId: string | null
  enableNew: boolean
  disableSource: boolean
  acknowledgedRiskLines: number
}

/** Save a user-skill proposal as a new skill (the approve route's user-skill branch). */
export async function saveUserSkillVersion(
  changeSetId: string,
  input: SaveUserSkillInput,
): Promise<{ skillId: string; name: string; version: number }> {
  const res = await fetch(`${base(changeSetId)}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return answer(res) as Promise<{ skillId: string; name: string; version: number }>
}

const post = (path: string, scopeOwnerId: string | null) =>
  fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scopeOwnerId ? { scopeOwnerId } : {}),
  })

export async function approveChangeSet(changeSetId: string, scopeOwnerId: string | null): Promise<{ revision: number }> {
  return answer(await post(`${base(changeSetId)}/approve`, scopeOwnerId)) as Promise<{ revision: number }>
}

export async function rejectChangeSet(changeSetId: string, scopeOwnerId: string | null): Promise<void> {
  await answer(await post(`${base(changeSetId)}/reject`, scopeOwnerId))
}

export async function deleteChangeSet(changeSetId: string): Promise<void> {
  await answer(await fetch(base(changeSetId), { method: 'DELETE' }))
}

export async function fetchVersions(group: string, projectId: string | null): Promise<VersionsModel> {
  const qs = new URLSearchParams({ point: 'skill.text', group })
  if (projectId) qs.set('projectId', projectId)
  return answer(await fetch(`/api/plugins/overrides/versions?${qs.toString()}`, { cache: 'no-store' })) as Promise<VersionsModel>
}

export async function fetchUserSkillVersions(skillId: string, projectId: string | null): Promise<UserSkillVersionsModel> {
  const qs = new URLSearchParams({ point: 'user_skill.text', group: skillId })
  if (projectId) qs.set('projectId', projectId)
  return answer(await fetch(`/api/plugins/overrides/versions?${qs.toString()}`, { cache: 'no-store' })) as Promise<UserSkillVersionsModel>
}

/** Deletes one of the user's own skills (with its waiting proposals and its toggles). */
export async function deleteUserSkill(userId: string, skillId: string): Promise<void> {
  await answer(await fetch(`/api/users/${encodeURIComponent(userId)}/attack-skills/${encodeURIComponent(skillId)}`, { method: 'DELETE' }))
}

export interface ResetInput {
  group: string
  scopeType: 'user' | 'project'
  scopeOwnerId?: string | null
  projectId?: string | null
}

export async function resetSkill(input: ResetInput): Promise<{ cleared: boolean }> {
  const res = await fetch('/api/plugins/overrides/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      point: 'skill.text',
      group: input.group,
      scopeType: input.scopeType,
      ...(input.scopeOwnerId ? { scopeOwnerId: input.scopeOwnerId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    }),
  })
  return answer(res) as Promise<{ cleared: boolean }>
}
