import { randomUUID } from 'crypto'
import { Prisma, type PluginData } from '@prisma/client'
import prisma from '@/lib/prisma'
import { now } from './clock'
import { runnerHealth } from './runnerClient'
import { isStorableJson, storableText } from './storableText'

/**
 * Async plugin actions as jobs (README.PLUGINS.md §7.7, TD-22). A job is a reserved
 * PluginData row (`__jobs`, keyed by its id, owned by the user who started it, kept 30
 * days), so any webapp copy can serve the poll and nothing lives in memory.
 *
 * - One active job per (plugin, action, user, project, session): the job row is written
 *   first, then a lock row (`__jobs_active`, key `<actionId>:<projectId|->:<sessionId|->`)
 *   with a plain insert that fails on the table's unique index when a job is already
 *   active. The loser deletes its own job row and answers the winner's, which already
 *   exists. A lock whose job ended, vanished or expired is replaced. The project is part of
 *   the key because without a session the same action in another project is another job.
 * - Every status change is a compare-and-swap on the stored status (a JSON path filter), so
 *   a result arriving after a cancel, or twice, changes nothing: a terminal job stays as
 *   it is. Ending a job deletes its lock.
 * - Only the user cancels a job: the cancel route marks the row first, then asks the
 *   runner. A `cancelled` report for a job still active therefore comes from plugin code,
 *   which holds the job's token too, and is recorded as `failed`.
 * - A result Postgres cannot store (U+0000, an unpaired surrogate) ends the job as
 *   `failed: invalid_result` instead of failing the report, which would leave the job
 *   running until its deadline.
 * - A running job past its deadline, or taken by a runner whose boot id has since changed,
 *   reads as failed (`timeout`, `runner_restarted`) instead of waiting (RV-23).
 */
export const JOBS_COLLECTION = '__jobs'
export const JOB_LOCKS_COLLECTION = '__jobs_active'
export const JOB_RESULT_MAX_BYTES = 2 * 1024 * 1024
export const PROGRESS_MESSAGE_MAX_CHARS = 300
export const PROGRESS_FIELDS_MAX = 20
const PROGRESS_FIELD_MAX_CHARS = 200
const JOB_TTL_MS = 30 * 24 * 3600 * 1000
const ERROR_CODE_MAX = 64
const ERROR_MESSAGE_MAX = 2_000
const BOOT_ID_CACHE_MS = 5_000
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]
const ACTIVE: readonly JobStatus[] = ['queued', 'running']
export const isTerminal = (s: JobStatus) => !ACTIVE.includes(s)

export interface JobContext {
  projectId: string | null
  sessionId: string | null
  conversationId: string | null
}

export interface JobError {
  code: string
  message: string
}

export interface JobProgress {
  message: string
  fields: Record<string, string>
}

/**
 * What the person picked before an action started (platform 1.1.0), as the server
 * re-derived it: the job window names the skill, a Retry replays the same pick, and a
 * second start in the same session is told which skill the running job works on.
 */
export interface JobPick {
  kind: 'session.skill'
  point: string
  target: string
  ref: string
  name: string | null
}

export interface Job {
  jobId: string
  pluginId: string
  userId: string
  actionId: string
  status: JobStatus
  context: JobContext
  pick?: JobPick | null
  progress: JobProgress | null
  result: Record<string, unknown> | null
  error: JobError | null
  deadline: string
  bootId: string | null
  createdAt: string
  updatedAt: string
}

type JobValue = Omit<Job, 'jobId' | 'pluginId' | 'userId'>

export class JobReportError extends Error {
  constructor(readonly code: 'invalid_report' | 'invalid_progress', message: string) {
    super(message)
    this.name = 'JobReportError'
  }
}

const jsonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8')
export const isJobId = (id: unknown): id is string => typeof id === 'string' && JOB_ID_RE.test(id)

const valueOf = (j: Job): JobValue => ({
  status: j.status,
  actionId: j.actionId,
  context: j.context,
  pick: j.pick ?? null,
  progress: j.progress,
  result: j.result,
  error: j.error,
  deadline: j.deadline,
  bootId: j.bootId,
  createdAt: j.createdAt,
  updatedAt: j.updatedAt,
})

function toJob(row: PluginData): Job {
  return { ...(row.value as unknown as JobValue), jobId: row.key, pluginId: row.pluginId, userId: row.ownerId }
}

const owner = (pluginId: string, userId: string) => ({
  pluginId,
  namespace: 'live',
  ownerType: 'user',
  ownerId: userId,
})

function jobWhere(pluginId: string | null, userId: string, jobId: string): Prisma.PluginDataWhereInput {
  return {
    ...(pluginId ? { pluginId } : {}),
    // Indexed: without the plugin id the unique index cannot serve a poll.
    userId,
    namespace: 'live',
    ownerType: 'user',
    ownerId: userId,
    collection: JOBS_COLLECTION,
    key: jobId,
  }
}

const lockKey = (actionId: string, context: JobContext) => `${actionId}:${context.projectId ?? '-'}:${context.sessionId ?? '-'}`

async function readJobRow(pluginId: string | null, userId: string, jobId: string): Promise<PluginData | null> {
  if (!isJobId(jobId)) return null
  return prisma.pluginData.findFirst({ where: jobWhere(pluginId, userId, jobId) })
}

async function releaseLock(job: Job) {
  await prisma.pluginData.deleteMany({
    where: {
      ...owner(job.pluginId, job.userId),
      collection: JOB_LOCKS_COLLECTION,
      key: lockKey(job.actionId, job.context),
      value: { path: ['jobId'], equals: job.jobId },
    },
  })
}

/**
 * Changes a job only while it is in one of `from`: one updateMany on the row whose stored
 * status is still the one read. Returns the job as it is afterwards, and whether this call
 * changed it.
 */
async function transition(
  row: PluginData,
  from: readonly JobStatus[],
  patch: (job: Job) => Partial<JobValue>,
): Promise<{ job: Job; changed: boolean }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const job = toJob(row)
    if (!from.includes(job.status)) return { job, changed: false }
    const next: JobValue = { ...valueOf(job), ...patch(job), updatedAt: now().toISOString() }
    const { count } = await prisma.pluginData.updateMany({
      where: { id: row.id, value: { path: ['status'], equals: job.status } },
      data: { value: next as unknown as Prisma.InputJsonValue, sizeBytes: jsonBytes(next) },
    })
    if (count === 1) {
      const updated = { ...job, ...next }
      if (isTerminal(updated.status)) await releaseLock(updated)
      return { job: updated, changed: true }
    }
    const fresh = await prisma.pluginData.findUnique({ where: { id: row.id } })
    if (!fresh) return { job, changed: false }
    row = fresh
  }
  return { job: toJob(row), changed: false }
}

export interface StartJobInput {
  pluginId: string
  userId: string
  actionId: string
  context: JobContext
  deadline: Date
  pick?: JobPick | null
}

/** A new queued job, or the one already active for this action and session. */
export async function startJob(input: StartJobInput): Promise<{ job: Job; created: boolean }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const at = now()
    const jobId = randomUUID()
    const value: JobValue = {
      status: 'queued',
      actionId: input.actionId,
      context: input.context,
      pick: input.pick ?? null,
      progress: null,
      result: null,
      error: null,
      deadline: input.deadline.toISOString(),
      bootId: null,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
    }
    const base = { ...owner(input.pluginId, input.userId), userId: input.userId }
    const row = await prisma.pluginData.create({
      data: {
        ...base,
        collection: JOBS_COLLECTION,
        key: jobId,
        value: value as unknown as Prisma.InputJsonValue,
        sizeBytes: jsonBytes(value),
        expiresAt: new Date(at.getTime() + JOB_TTL_MS),
      },
    })
    const key = lockKey(input.actionId, input.context)
    try {
      await prisma.pluginData.create({
        data: { ...base, collection: JOB_LOCKS_COLLECTION, key, value: { jobId }, sizeBytes: 50, expiresAt: input.deadline },
      })
      return { job: toJob(row), created: true }
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) {
        await prisma.pluginData.deleteMany({ where: { id: row.id } })
        throw e
      }
    }
    // Another job holds the lock: answer it, unless it is over.
    await prisma.pluginData.deleteMany({ where: { id: row.id } })
    const lock = await prisma.pluginData.findFirst({ where: { ...owner(input.pluginId, input.userId), collection: JOB_LOCKS_COLLECTION, key } })
    if (!lock) continue
    const heldBy = (lock.value as { jobId?: unknown } | null)?.jobId
    const existing = typeof heldBy === 'string' ? await readJobRow(input.pluginId, input.userId, heldBy) : null
    const lockExpired = lock.expiresAt !== null && lock.expiresAt <= now()
    if (existing && !isTerminal(toJob(existing).status) && !lockExpired) return { job: toJob(existing), created: false }
    // Only this lock, and only if it still names the job just judged.
    await prisma.pluginData.deleteMany({
      where: typeof heldBy === 'string' ? { id: lock.id, value: { path: ['jobId'], equals: heldBy } } : { id: lock.id },
    })
  }
  throw new Error('Could not start the job: its lock kept changing')
}

/** The runner took the job: queued → running, with the runner's boot id. */
export async function markRunning(job: Job, bootId: string | null): Promise<Job> {
  const row = await readJobRow(job.pluginId, job.userId, job.jobId)
  if (!row) return job
  return (await transition(row, ['queued'], () => ({ status: 'running', bootId }))).job
}

export async function failJob(job: Job, error: JobError): Promise<Job> {
  const row = await readJobRow(job.pluginId, job.userId, job.jobId)
  if (!row) return job
  return (await transition(row, ACTIVE, () => ({ status: 'failed', error }))).job
}

export async function cancelJobRow(job: Job): Promise<{ job: Job; changed: boolean }> {
  const row = await readJobRow(job.pluginId, job.userId, job.jobId)
  if (!row) return { job, changed: false }
  return transition(row, ACTIVE, () => ({ status: 'cancelled', error: { code: 'cancelled', message: 'Cancelled by the user.' } }))
}

/** Whether a job token's job is still queued or running: the Gateway refuses its token after. */
export async function jobIsActive(pluginId: string, userId: string, jobId: string): Promise<boolean> {
  const row = await readJobRow(pluginId, userId, jobId)
  return !!row && !isTerminal(toJob(row).status)
}

/** The job a user owns, of any plugin, or null. */
export async function findUserJob(userId: string, jobId: string): Promise<Job | null> {
  const row = await readJobRow(null, userId, jobId)
  return row ? toJob(row) : null
}

// ---------------------------------------------------------------------------
// The runner's boot id, asked at most every five seconds (polls come every second or two).
// ---------------------------------------------------------------------------

let bootCache: { at: number; bootId: string | null } | null = null

export function clearRunnerBootIdCache(): void {
  bootCache = null
}

async function currentRunnerBootId(opts: { fresh?: boolean } = {}): Promise<string | null> {
  const t = now().getTime()
  if (!opts.fresh && bootCache && t - bootCache.at < BOOT_ID_CACHE_MS) return bootCache.bootId
  let bootId: string | null = null
  try {
    const health = await runnerHealth()
    bootId = typeof health.bootId === 'string' && health.bootId ? health.bootId : null
  } catch {
    bootId = null
  }
  bootCache = { at: t, bootId }
  return bootId
}

/** The job as it really is: an active job past its deadline or orphaned by a restart has failed. */
export async function refreshJob(job: Job): Promise<Job> {
  if (isTerminal(job.status)) return job
  if (now().getTime() > Date.parse(job.deadline)) {
    return failJob(job, { code: 'timeout', message: 'The action did not report a result before its deadline.' })
  }
  if (job.status === 'running' && job.bootId) {
    let current = await currentRunnerBootId()
    // A cached id may be the runner before a restart, and this job the new runner's.
    if (current && current !== job.bootId) current = await currentRunnerBootId({ fresh: true })
    if (current && current !== job.bootId) {
      return failJob(job, { code: 'runner_restarted', message: 'The plugin runner restarted while the action was running.' })
    }
  }
  return job
}

// ---------------------------------------------------------------------------
// What the worker reports, through the Gateway with its job token
// ---------------------------------------------------------------------------

function checkedError(raw: unknown): JobError {
  const e = raw as Record<string, unknown> | null
  if (!e || typeof e !== 'object' || typeof e.code !== 'string' || !e.code || typeof e.message !== 'string') {
    throw new JobReportError('invalid_report', 'error must be {code, message}')
  }
  return { code: storableText(e.code.slice(0, ERROR_CODE_MAX)), message: storableText(e.message.slice(0, ERROR_MESSAGE_MAX)) }
}

export interface CompleteReport {
  status: 'succeeded' | 'failed' | 'cancelled'
  result?: Record<string, unknown>
  error?: JobError
}

/** Checks a `jobs/complete` body; throws JobReportError for a malformed one. */
export function checkedReport(body: Record<string, unknown>): CompleteReport {
  const { status } = body
  if (status === 'succeeded') {
    const result = body.result
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new JobReportError('invalid_report', 'a succeeded job reports a result object')
    }
    return { status, result: result as Record<string, unknown> }
  }
  if (status === 'failed') return { status, error: checkedError(body.error) }
  if (status === 'cancelled') {
    return { status, error: body.error === undefined ? { code: 'cancelled', message: 'The action was cancelled.' } : checkedError(body.error) }
  }
  throw new JobReportError('invalid_report', 'status is succeeded, failed or cancelled')
}

/**
 * Ends a job with what its worker reported. A job already over is left as it is. `lapsed`
 * says why the job's result may no longer be kept (its plugin stopped serving, or its
 * project or session is gone): the job then fails with it, and the result is dropped.
 */
export async function completeJob(
  pluginId: string,
  userId: string,
  jobId: string,
  report: CompleteReport,
  opts: { lapsed?: JobError | null } = {},
): Promise<{ found: boolean; changed: boolean; job: Job | null }> {
  const row = await readJobRow(pluginId, userId, jobId)
  if (!row) return { found: false, changed: false, job: null }
  let patch: Partial<JobValue>
  if (opts.lapsed) {
    patch = { status: 'failed', error: opts.lapsed }
  } else if (report.status === 'succeeded' && !isStorableJson(report.result)) {
    patch = { status: 'failed', error: { code: 'invalid_result', message: 'The result holds text that cannot be stored (U+0000 or an unpaired surrogate).' } }
  } else if (report.status === 'succeeded' && jsonBytes(report.result) > JOB_RESULT_MAX_BYTES) {
    patch = { status: 'failed', error: { code: 'result_too_large', message: `A job result is limited to ${JOB_RESULT_MAX_BYTES} bytes of JSON.` } }
  } else if (report.status === 'succeeded') {
    patch = { status: 'succeeded', result: report.result ?? {} }
  } else {
    patch = { status: 'failed', error: report.error ?? null }
  }
  const { job, changed } = await transition(row, ACTIVE, () => patch)
  return { found: true, changed, job }
}

export function checkedProgress(body: Record<string, unknown>): JobProgress {
  const { message, fields } = body
  if (typeof message !== 'string' || message.length > PROGRESS_MESSAGE_MAX_CHARS) {
    throw new JobReportError('invalid_progress', `message is text of at most ${PROGRESS_MESSAGE_MAX_CHARS} characters`)
  }
  if (fields === undefined || fields === null) return { message, fields: {} }
  if (typeof fields !== 'object' || Array.isArray(fields)) throw new JobReportError('invalid_progress', 'fields is an object of text')
  const entries = Object.entries(fields as Record<string, unknown>)
  if (entries.length > PROGRESS_FIELDS_MAX) throw new JobReportError('invalid_progress', `at most ${PROGRESS_FIELDS_MAX} fields`)
  for (const [k, v] of entries) {
    if (typeof v !== 'string' || k.length > PROGRESS_FIELD_MAX_CHARS || v.length > PROGRESS_FIELD_MAX_CHARS) {
      throw new JobReportError('invalid_progress', `each field is text of at most ${PROGRESS_FIELD_MAX_CHARS} characters`)
    }
  }
  return { message, fields: Object.fromEntries(entries) as Record<string, string> }
}

export async function reportProgress(pluginId: string, userId: string, jobId: string, progress: JobProgress) {
  const row = await readJobRow(pluginId, userId, jobId)
  if (!row) return { found: false, changed: false }
  const { changed } = await transition(row, ACTIVE, () => ({ progress }))
  return { found: true, changed }
}

/** What the UI receives about a job. */
export function jobView(job: Job) {
  return {
    jobId: job.jobId,
    pluginId: job.pluginId,
    actionId: job.actionId,
    status: job.status,
    pick: job.pick ?? null,
    progress: job.progress,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    deadline: job.deadline,
  }
}
