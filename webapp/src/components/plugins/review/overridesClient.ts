import type { ReviewModel } from '@/lib/plugins/reviewModel'

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
