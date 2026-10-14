import prisma from '@/lib/prisma'
import type { OverrideScope } from './overrides'

/**
 * Who may act on a change set (OQ-08, X9). The effective user must own its scope — a user
 * scope they ARE, a project scope they own by a STRICT owner check (`project.userId`), never
 * `requireProjectAccess`, which only logs under ACCESS_ENFORCE=0. An admin acting as the owner
 * passes because the effective user is the owner; the audit records the real session user.
 *
 * A user-scope write also carries `scopeOwnerId` in its body, which must equal the effective
 * user: the act-as cookie is site-wide, so a second tab could have switched it between the
 * page load and the click (RV-33). This is the extra body check callers apply on top.
 */
export async function ownsScope(scope: OverrideScope, effectiveUserId: string): Promise<boolean> {
  if (scope.type === 'user') return scope.id === effectiveUserId
  if (typeof scope.id !== 'string' || !scope.id) return false
  const project = await prisma.project.findUnique({ where: { id: scope.id }, select: { userId: true } })
  return !!project && project.userId === effectiveUserId
}

/** For a user-scope write: the body's scopeOwnerId must be the effective user and the owner. */
export function bodyOwnerMatches(scope: OverrideScope, effectiveUserId: string, scopeOwnerId: unknown): boolean {
  if (scope.type !== 'user') return true
  return typeof scopeOwnerId === 'string' && scopeOwnerId === effectiveUserId && scopeOwnerId === scope.id
}
