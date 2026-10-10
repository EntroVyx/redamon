'use client'

import { useCallback, useState, type ReactNode } from 'react'
import { useToast } from '@/components/ui'
import { useFeatureModelGate } from '@/components/shared/FeatureModelGate'
import type { ChatSessionActionContribution } from '@/lib/plugins/contributions'
import type { ActionContext } from './host/actionClient'
import { JobProgressModal } from './JobProgressModal'
import { runPluginAction, type PluginJob } from './runPluginAction'

interface Plugin {
  pluginId: string
  displayName: string
}

interface LastRun {
  plugin: Plugin
  item: ChatSessionActionContribution
  context: ActionContext
}

/**
 * The gear-menu action flow and the job modal it opens (design §6.7). The review and
 * core-screen handlers are injected so the modals that draw them can be wired in later steps
 * without touching this flow. `run` is what PhaseIndicatorBar calls on a click.
 */
export function usePluginChatActions({
  onReviewProposal,
  onCoreScreen,
}: {
  onReviewProposal: (changeSetId: string) => void
  onCoreScreen: (screen: string, context: ActionContext) => void
}): { run: (plugin: Plugin, item: ChatSessionActionContribution, context: ActionContext) => void; modals: ReactNode } {
  const toast = useToast()
  const gate = useFeatureModelGate()
  const [job, setJob] = useState<PluginJob | null>(null)
  // The last action run, kept in state (not a ref) so `retry` can be passed to the job modal
  // without reading a ref during render.
  const [lastRun, setLastRun] = useState<LastRun | null>(null)

  const run = useCallback(
    (plugin: Plugin, item: ChatSessionActionContribution, context: ActionContext) => {
      setLastRun({ plugin, item, context })
      void runPluginAction({
        plugin,
        item,
        context,
        gate,
        handlers: { onReviewProposal, onCoreScreen, onJob: setJob, toast },
      })
    },
    [gate, onReviewProposal, onCoreScreen, toast],
  )

  const retry = useCallback(() => {
    if (lastRun) run(lastRun.plugin, lastRun.item, lastRun.context)
  }, [lastRun, run])

  const modals = job ? (
    <JobProgressModal job={job} onClose={() => setJob(null)} onReviewProposal={onReviewProposal} gate={gate} onRetry={retry} />
  ) : null

  return { run, modals }
}
