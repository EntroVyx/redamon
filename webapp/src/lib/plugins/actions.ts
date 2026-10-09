import { NextRequest, NextResponse } from 'next/server'
import type { PluginInstall } from '@prisma/client'
import prisma from '@/lib/prisma'
import { readFeatureModel } from '@/lib/featureModels'
import { readJsonBody } from '@/lib/jsonBody'
import { pluginFeatureId } from '@/lib/llmFeatures'
import { getEffectiveUser, getSession } from '@/lib/session'
import { CallTokenConfigError, mintCallToken } from './callToken'
import { now } from './clock'
import { isValidPluginId } from './ids'
import { failJob, markRunning, startJob, type JobContext } from './jobs'
import * as ov from './overrides'
import { findInstall, hasPermission, servesActions } from './registry'
import { RunnerError, RunnerUnavailableError, runAction } from './runnerClient'
import { crossOriginResponse, sameOrigin } from './sameOrigin'
import { ACTION_ID_RE } from './schemas/common'
import { actionMaxTimeoutSeconds } from './settings'
import { pluginsDisabledResponse, pluginsEnabled } from './switch'

/**
 * A plugin action started from the UI (README.PLUGINS.md §7.7): POST
 * /api/plugins/[pluginId]/actions/[actionId] with `{context: {projectId?, sessionId?},
 * params}`. The webapp decides everything the plugin may reach before the runner sees the
 * call: the effective user, the project and session (strictly theirs, never through the
 * log-only access helpers), the permissions both granted and declared, the timeout; then
 * it mints the call token the plugin's code will hold. A sync action answers its result;
 * an async one becomes a job (jobs.ts) and answers 202 `{jobId}`.
 *
 * A result naming a change set to review (`reviewProposal`) is kept only when that change
 * set exists, is this plugin's and is in the caller's scope: the worker could report any
 * id, and the UI would open the review modal on it (RV-21).
 */
const PARAMS_MAX_BYTES = 64 * 1024
// A job's deadline: its timeout, plus time for the runner's own timeout answer and report.
const JOB_GRACE_SECONDS = 60

type Json = Record<string, unknown>

const refuse = (status: number, code: string, error: string, extra: Json = {}) =>
  NextResponse.json({ error, code, ...extra }, { status })

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

interface ManifestAction {
  id: string
  timeoutSeconds: number
  async?: boolean
  llm?: boolean
}

function declaredAction(plugin: PluginInstall, actionId: string): ManifestAction | null {
  const actions = isObj(plugin.manifest) ? plugin.manifest.actions : null
  if (!Array.isArray(actions)) return null
  const a = actions.find((x) => isObj(x) && x.id === actionId) as ManifestAction | undefined
  return a && Number.isInteger(a.timeoutSeconds) && a.timeoutSeconds > 0 ? a : null
}

function grantedAndDeclared(plugin: PluginInstall): string[] {
  const declared = isObj(plugin.manifest) && Array.isArray(plugin.manifest.permissions) ? plugin.manifest.permissions : []
  return declared.filter((p): p is string => typeof p === 'string' && hasPermission(plugin, p))
}

export async function checkReviewProposal(
  result: Json,
  who: { pluginId: string; userId: string; projectId: string | null },
): Promise<Json> {
  if (!('reviewProposal' in result)) return result
  const rp = result.reviewProposal
  const rest = { ...result }
  delete rest.reviewProposal
  if (isObj(rp) && typeof rp.changeSetId === 'string' && typeof rp.extensionPoint === 'string') {
    const set = await ov.getChangeSet(rp.changeSetId)
    const inScope = !!set && (set.scope.type === 'user' ? set.scope.id === who.userId : set.scope.id === who.projectId)
    if (set && inScope && set.pluginId === who.pluginId && set.point === rp.extensionPoint) {
      return { ...rest, reviewProposal: { extensionPoint: rp.extensionPoint, changeSetId: rp.changeSetId } }
    }
  }
  console.warn(`[plugins] dropped a reviewProposal from plugin=${who.pluginId}: not its change set in the caller's scope`)
  return rest
}

function runnerFailure(e: unknown, extra: Json = {}): NextResponse | null {
  if (e instanceof RunnerUnavailableError) {
    return refuse(503, 'runner_unavailable', 'The plugin runner is not available right now; try again shortly.', extra)
  }
  if (e instanceof RunnerError) {
    // The plugin is installed here but the runner has not started it yet (it reloads
    // within a minute of an install).
    if (e.status === 404 && e.code === 'unknown_plugin') {
      return refuse(503, 'plugin_not_running', 'The plugin runner has not started this plugin yet; try again in a minute.', extra)
    }
    return refuse(e.status, e.code, e.message, extra)
  }
  return null
}

async function strictContext(raw: unknown, userId: string): Promise<JobContext | NextResponse> {
  if (raw === undefined || raw === null) return { projectId: null, sessionId: null, conversationId: null }
  if (!isObj(raw)) return refuse(400, 'invalid_context', 'context must be an object')
  const { projectId, sessionId } = raw
  const optionalText = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.length > 0 && v.length <= 128)
  if (!optionalText(projectId) || !optionalText(sessionId)) {
    return refuse(400, 'invalid_context', 'context.projectId and context.sessionId are ids')
  }
  const notFound = refuse(404, 'not_found', 'Not found')
  let conversationId: string | null = null
  if (projectId) {
    const project = await prisma.project.findUnique({ where: { id: projectId as string }, select: { userId: true } })
    if (!project || project.userId !== userId) return notFound
  }
  if (sessionId) {
    if (!projectId) return notFound
    const conv = await prisma.conversation.findUnique({
      where: { sessionId: sessionId as string },
      select: { id: true, userId: true, projectId: true },
    })
    if (!conv || conv.userId !== userId || conv.projectId !== projectId) return notFound
    conversationId = conv.id
  }
  return { projectId: (projectId as string) ?? null, sessionId: (sessionId as string) ?? null, conversationId }
}

export async function handleAction(request: NextRequest, pluginId: string, actionId: string): Promise<NextResponse> {
  const started = Date.now()
  const res = await act(request, pluginId, actionId)
  console.log(`[plugins] action plugin=${isValidPluginId(pluginId) ? pluginId : '-'} action=${ACTION_ID_RE.test(actionId) ? actionId : '-'} status=${res.status} ms=${Date.now() - started}`)
  return res
}

async function act(request: NextRequest, pluginId: string, actionId: string): Promise<NextResponse> {
  if (!pluginsEnabled()) return pluginsDisabledResponse()
  if (!sameOrigin(request)) return crossOriginResponse()
  const parsed = await readJsonBody(request)
  if (parsed instanceof NextResponse) return parsed
  const body = parsed.body
  const eff = await getEffectiveUser()
  if (!eff) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!isValidPluginId(pluginId) || !ACTION_ID_RE.test(actionId)) return refuse(404, 'not_found', 'No such plugin action.')
  const plugin = await findInstall(pluginId)
  if (!plugin || ['available', 'installing', 'uninstalling'].includes(plugin.status)) {
    return refuse(404, 'not_found', 'No such plugin action.')
  }
  if (plugin.revokedReason == null && plugin.enabled && plugin.status === 'updating') {
    return refuse(409, 'plugin_updating', 'This plugin is being updated; try again in a moment.')
  }
  if (!servesActions(plugin) || !plugin.activeVersion) {
    return refuse(409, 'plugin_unavailable', 'This plugin is disabled or not ready.')
  }
  const action = declaredAction(plugin, actionId)
  if (!action) return refuse(404, 'unknown_action', `Plugin ${pluginId} declares no action ${actionId}.`)

  const params = body.params === undefined ? {} : body.params
  if (!isObj(params)) return refuse(400, 'invalid_params', 'params must be an object')
  if (Buffer.byteLength(JSON.stringify(params), 'utf8') > PARAMS_MAX_BYTES) {
    return refuse(413, 'params_too_large', `params are limited to ${PARAMS_MAX_BYTES} bytes of JSON`)
  }
  const context = await strictContext(body.context, eff.userId)
  if (context instanceof NextResponse) return context

  if (action.llm && !(await readFeatureModel(eff.userId, pluginFeatureId(pluginId)))) {
    return refuse(409, 'model_required', 'Choose a model for this plugin in Models by feature.', { featureId: pluginFeatureId(pluginId) })
  }

  const session = await getSession()
  const actor = session && session.userId !== eff.userId ? session.userId : undefined
  const timeoutSeconds = Math.min(action.timeoutSeconds, actionMaxTimeoutSeconds())
  const tokenBase = {
    pluginId,
    version: plugin.activeVersion,
    sub: eff.userId,
    act: actor,
    prj: context.projectId ?? undefined,
    ses: context.sessionId ?? undefined,
    conv: context.conversationId ?? undefined,
    perms: grantedAndDeclared(plugin),
    timeoutSeconds,
  }
  const ctx: Json = { pluginId, version: plugin.activeVersion, userId: eff.userId }
  if (context.projectId) ctx.projectId = context.projectId
  if (context.sessionId) ctx.sessionId = context.sessionId
  if (context.conversationId) ctx.conversationId = context.conversationId

  try {
    if (!action.async) {
      const { token } = await mintCallToken({ ...tokenBase, kind: 'action' })
      const out = await runAction(pluginId, actionId, { token, params, ctx, timeoutSeconds })
      if (out.kind !== 'result') return refuse(502, 'runner_bad_answer', 'The plugin runner answered a sync action as a job.')
      if (!out.ok) return NextResponse.json({ ok: false, error: out.error })
      const result = await checkReviewProposal(out.result, { pluginId, userId: eff.userId, projectId: context.projectId })
      return NextResponse.json({ ok: true, result })
    }

    const deadline = new Date(now().getTime() + (timeoutSeconds + JOB_GRACE_SECONDS) * 1000)
    const { job, created } = await startJob({ pluginId, userId: eff.userId, actionId, context, deadline })
    if (!created) return NextResponse.json({ jobId: job.jobId, status: job.status, existing: true })
    try {
      const { token } = await mintCallToken({ ...tokenBase, kind: 'job', jid: job.jobId })
      const out = await runAction(pluginId, actionId, {
        token,
        params,
        ctx: { ...ctx, jobId: job.jobId },
        timeoutSeconds,
        async: true,
        jobId: job.jobId,
      })
      if (out.kind !== 'accepted') throw new RunnerError(502, 'runner_bad_answer', 'The plugin runner answered an async action without a job.')
      await markRunning(job, out.bootId)
      return NextResponse.json({ jobId: job.jobId }, { status: 202 })
    } catch (e) {
      const failure = runnerFailure(e, { jobId: job.jobId })
      const code = e instanceof RunnerUnavailableError ? 'runner_unavailable' : e instanceof RunnerError ? e.code : 'start_failed'
      await failJob(job, { code, message: 'The job could not be handed to the plugin runner.' })
      if (failure) return failure
      throw e
    }
  } catch (e) {
    if (e instanceof CallTokenConfigError) {
      console.error(`[plugins] action refused: ${e.message}`)
      return refuse(503, e.code, 'The plugin platform is not configured on this deployment.')
    }
    const failure = runnerFailure(e)
    if (failure) return failure
    throw e
  }
}
