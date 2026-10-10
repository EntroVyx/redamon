import type { ReviewModel } from '@/lib/plugins/reviewModel'
import type { VersionsModel } from '@/lib/plugins/versionsModel'

/** The browser side of the core override routes (design §6). */
export class OverrideApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'OverrideApiError'
  }
}

async function answer(res: Response): Promise<unknown> {
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; code?: string }
    throw new OverrideApiError(b.code ?? `http_${res.status}`, b.error ?? `HTTP ${res.status}`, res.status)
  }
  return body
}

const base = (changeSetId: string) => `/api/plugins/overrides/change-sets/${encodeURIComponent(changeSetId)}`

export async function fetchReviewModel(changeSetId: string): Promise<ReviewModel> {
  return answer(await fetch(base(changeSetId), { cache: 'no-store' })) as Promise<ReviewModel>
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
