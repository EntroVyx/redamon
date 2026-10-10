import { pluginFeatureId } from '@/lib/llmFeatures'
import type { FeatureModelGateApi } from '@/components/shared/FeatureModelGate'
import type { ChatSessionActionContribution } from '@/lib/plugins/contributions'
import { PluginActionError, postPluginAction, readActionAnswer, type ActionContext } from './host/actionClient'

/** A running async plugin action, as the job modal needs it. */
export interface PluginJob {
  jobId: string
  pluginId: string
  displayName: string
  label: string
}

export interface PluginActionToast {
  success: (message: string) => void
  error: (message: string) => void
  info: (message: string) => void
}

/**
 * What a gear-menu click reaches out to. The review and versions modals are built in later
 * steps; here they are injected handlers (step 6.4 passes placeholders, 6.5/6.6 the real
 * modals), so the click flow is testable on its own.
 */
export interface PluginActionHandlers {
  onReviewProposal: (changeSetId: string) => void
  onCoreScreen: (screen: string, context: ActionContext) => void
  onJob: (job: PluginJob) => void
  toast: PluginActionToast
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Runs one chat-session action (design §6.7). A `coreScreen` item opens a core screen. An
 * action item: if it calls a model, ask for one first (cancel aborts); POST it with the
 * session context; an async answer opens the job modal; a sync result with a
 * `reviewProposal` opens the review; any other result shows its message.
 */
export async function runPluginAction(opts: {
  plugin: { pluginId: string; displayName: string }
  item: ChatSessionActionContribution
  context: ActionContext
  gate: Pick<FeatureModelGateApi, 'ensureFeatureModel'>
  handlers: PluginActionHandlers
}): Promise<void> {
  const { plugin, item, context, gate, handlers } = opts

  if (item.coreScreen) {
    handlers.onCoreScreen(item.coreScreen, context)
    return
  }
  if (!item.action) return

  if (item.llm) {
    const model = await gate.ensureFeatureModel(pluginFeatureId(plugin.pluginId), { label: plugin.displayName })
    if (!model) return
  }

  try {
    const answer = await readActionAnswer(await postPluginAction(plugin.pluginId, item.action, { context }))
    if (answer.kind === 'job') {
      handlers.onJob({ jobId: answer.jobId, pluginId: plugin.pluginId, displayName: plugin.displayName, label: item.label })
      return
    }
    handleResult(answer.result, handlers)
  } catch (e) {
    handlers.toast.error(e instanceof PluginActionError ? e.message : 'The plugin action could not be run.')
  }
}

/** A finished result: a change set to review, or a message to show. */
export function handleResult(result: Record<string, unknown>, handlers: Pick<PluginActionHandlers, 'onReviewProposal' | 'toast'>): void {
  const rp = result.reviewProposal
  if (isObj(rp) && typeof rp.changeSetId === 'string') {
    handlers.onReviewProposal(rp.changeSetId)
    return
  }
  if (typeof result.message === 'string' && result.message) handlers.toast.info(result.message)
  else handlers.toast.success('Done')
}
