'use client'

import { useCallback, useState, type ReactNode } from 'react'
import { useToast } from '@/components/ui'
import { useFeatureModelGate } from '@/components/shared/FeatureModelGate'
import type { ChatSessionActionContribution } from '@/lib/plugins/contributions'
import type { ActionContext } from './host/actionClient'
import { JobProgressModal } from './JobProgressModal'
import { runPluginAction, type PluginJob } from './runPluginAction'
import { SessionSkillPicker, type SessionPick } from './SessionSkillPicker'

interface Plugin {
  pluginId: string
  displayName: string
}

interface LastRun {
  plugin: Plugin
  item: ChatSessionActionContribution
  context: ActionContext
  /** Replayed by Retry, so it runs on the same skill without asking again. */
  pick?: SessionPick | null
}

interface PickerRequest {
  plugin: Plugin
  context: ActionContext
  resolve: (pick: SessionPick | null) => void
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
  const [picker, setPicker] = useState<PickerRequest | null>(null)

  const pickSessionSkill = useCallback(
    (plugin: Plugin, context: ActionContext) =>
      new Promise<SessionPick | null>((resolve) =>
        setPicker((open) => {
          // A second click while a picker is open replaces it: the first one ends as a cancel.
          open?.resolve(null)
          return { plugin, context, resolve }
        }),
      ),
    [],
  )

  const run = useCallback(
    (plugin: Plugin, item: ChatSessionActionContribution, context: ActionContext, pick?: SessionPick | null) => {
      setLastRun({ plugin, item, context, pick })
      void runPluginAction({
        plugin,
        item,
        context,
        gate,
        pick,
        handlers: {
          onReviewProposal,
          onCoreScreen,
          onJob: setJob,
          pickSessionSkill,
          onPicked: (picked) => setLastRun({ plugin, item, context, pick: picked }),
          toast,
        },
      })
    },
    [gate, onReviewProposal, onCoreScreen, toast, pickSessionSkill],
  )

  const retry = useCallback(() => {
    if (lastRun) run(lastRun.plugin, lastRun.item, lastRun.context, lastRun.pick)
  }, [lastRun, run])

  const closePicker = (pick: SessionPick | null) => {
    picker?.resolve(pick)
    setPicker(null)
  }

  const modals = (
    <>
      {picker && (
        <SessionSkillPicker
          pluginId={picker.plugin.pluginId}
          pluginName={picker.plugin.displayName}
          context={picker.context}
          onCancel={() => closePicker(null)}
          onStart={(pick) => closePicker(pick)}
        />
      )}
      {job && (
        <JobProgressModal job={job} onClose={() => setJob(null)} onReviewProposal={onReviewProposal} gate={gate} onRetry={retry} />
      )}
    </>
  )

  return { run, modals }
}
