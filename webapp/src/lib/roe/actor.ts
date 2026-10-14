import { getSession, type EffectiveUser } from '@/lib/session'

/**
 * The admin behind a request made while acting as `eff`, or null.
 *
 * `writeAudit` has one actor column, and it records the effective user, so a RoE
 * applied by an admin simulating a user would read as the user's own act. The
 * RoE audits carry the admin in `after` until the audit table grows a real-actor
 * column.
 */
export async function actingAdminId(eff: EffectiveUser): Promise<string | null> {
  try {
    const session = await getSession()
    return session && session.userId !== eff.userId ? session.userId : null
  } catch {
    return null
  }
}
