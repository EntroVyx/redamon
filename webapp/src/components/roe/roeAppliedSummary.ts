/** One line for the toast after a RoE replace or remove saved. */
export function roeAppliedSummary(result: Record<string, unknown>): string {
  const changed = Array.isArray(result.changed) ? result.changed.length : 0
  const paused = Array.isArray(result.pausedSchedules) ? result.pausedSchedules.length : 0
  const queued = Number((result.queuedJobsNeedingReview as { count?: unknown } | undefined)?.count ?? 0)
  const parts = [`${changed} setting${changed === 1 ? '' : 's'} changed. Applies from the next scan.`]
  if (paused > 0) parts.push(`${paused} scheduled scan${paused === 1 ? '' : 's'} paused.`)
  if (queued > 0) parts.push(`${queued} queued scan${queued === 1 ? '' : 's'} wait for re-confirmation.`)
  return parts.join(' ')
}
