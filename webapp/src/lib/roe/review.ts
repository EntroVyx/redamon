/**
 * The review of a RoE replace or remove on an existing project: the proposal
 * plus a preview of everything confirming it would do beyond the row, so the
 * person sees it BEFORE they confirm rather than in a toast after.
 *
 * Built from the same functions applyRoe decides with, so the preview and the
 * decision cannot disagree except where the project changed in between, which
 * the row version catches.
 */
import prisma from '@/lib/prisma'
import { fetchBackendDefaults } from '@/lib/reconPresets/server'
import { agentEnforcementWarning } from './agentWarning'
import { MAX_MODEL_CHARS } from './limits'
import {
  NEEDS_AUTHORIZATION_MESSAGE,
  queuedJobsChangedBy,
  roeBlockingWork,
  schedulesToPause,
  thirdPartyCheck,
  type RoeBusy,
  type ScheduleToPause,
  type ThirdPartyCheck,
} from './roeEffects'
import { buildReplaceProposal, changesMap, isWidening, replaceIsImplausible, type ReplaceProposal } from './roeReplace'

export interface ReplacePreviews {
  busy: RoeBusy
  /** Null when the schedules could not be evaluated; confirming would then be refused. */
  schedulesToPause: ScheduleToPause[] | null
  queuedJobsToReconfirm: number
  thirdParty: ThirdPartyCheck
}

export interface ReplaceReview extends ReplaceProposal {
  mode: 'replace' | 'remove'
  projectId: string
  /** The row version the review was built on; confirming sends it back. */
  rowVersion: string
  /** The model output the review was built on; confirming and re-diffing send it back. */
  parsedFields: Record<string, unknown>
  widening: boolean
  implausible: boolean
  currentDocument: { name: string; appliedAt: string | null } | null
  previews: ReplacePreviews
  warnings: string[]
}

export class ReviewUnavailable extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

/** Loads the row and the defaults; throws ReviewUnavailable when either is missing. */
export async function buildReplaceReview(args: {
  projectId: string
  parsedFields: Record<string, unknown>
  mode: 'replace' | 'remove'
  textLength?: number
  extractionTruncated?: boolean
}): Promise<ReplaceReview> {
  const row = await prisma.project.findUnique({ where: { id: args.projectId } }) as (Record<string, unknown> & {
    updatedAt: Date; roeParsedJson: unknown; roeDocumentName: string; roeRawText: string; engagementKind: string
  }) | null
  if (!row) throw new ReviewUnavailable(404, 'not_found', 'The project no longer exists.')

  let defaults: Record<string, unknown>
  try {
    defaults = await fetchBackendDefaults()
  } catch (e) {
    console.error('[roe-review] defaults unavailable:', e)
    throw new ReviewUnavailable(503, 'defaults_unavailable', 'The recon and agent defaults could not be read. Try again.')
  }

  const parsedFields = args.mode === 'remove' ? {} : args.parsedFields
  const proposal = buildReplaceProposal({ parsed: parsedFields, current: row, previous: row.roeParsedJson, defaults })
  const resulting = { ...row, ...changesMap(proposal) }

  const busy = await roeBlockingWork(args.projectId)
  let pause: ScheduleToPause[] | null
  try {
    pause = await schedulesToPause(args.projectId, proposal, resulting)
  } catch (e) {
    console.error('[roe-review] could not evaluate schedules:', e)
    pause = null
  }
  const thirdParty = thirdPartyCheck(row, resulting, proposal)

  const warnings: string[] = []
  if (args.extractionTruncated || (args.textLength ?? 0) > MAX_MODEL_CHARS) {
    warnings.push(
      `The document is longer than the model reads: only its first ${MAX_MODEL_CHARS.toLocaleString('en-US')} ` +
      `characters were parsed. Check that nothing after that point needed to be applied.`
    )
  }
  const enforcement = agentEnforcementWarning(Object.keys(proposal.applied), resulting)
  if (enforcement) warnings.push(enforcement)
  if (thirdParty.needsAuthorization) warnings.push(NEEDS_AUTHORIZATION_MESSAGE)
  if (proposal.droppedFromPrevious.length > 0) {
    console.warn(`[roe-review] ${args.projectId}: stored parse entries not honoured: ${proposal.droppedFromPrevious.join(', ')}`)
  }

  const stored = (row.roeParsedJson && typeof row.roeParsedJson === 'object' ? row.roeParsedJson : {}) as Record<string, unknown>
  const hasDocument = Boolean(row.roeDocumentName || row.roeRawText)
  return {
    ...proposal,
    mode: args.mode,
    projectId: args.projectId,
    rowVersion: row.updatedAt.toISOString(),
    parsedFields,
    widening: isWidening(proposal),
    implausible: args.mode === 'replace' && replaceIsImplausible(proposal),
    currentDocument: hasDocument
      ? { name: row.roeDocumentName || 'roe-document', appliedAt: typeof stored.appliedAt === 'string' ? stored.appliedAt : null }
      : null,
    previews: {
      busy,
      schedulesToPause: pause,
      queuedJobsToReconfirm: await queuedJobsChangedBy(args.projectId, resulting),
      thirdParty,
    },
    warnings,
  }
}
