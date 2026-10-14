import { NextRequest, NextResponse } from 'next/server'
import { requireEffectiveUser } from '@/lib/access'
import { writeAudit } from '@/lib/audit'
import { readFeatureModel, featureModelErrorResponse } from '@/lib/featureModels'
import { callFeatureAgent } from '@/lib/featureAgentCall'
import { crossOriginResponse, sameOrigin } from '@/lib/plugins/sameOrigin'
import { buildParseProposal, proposalIsImplausible, MAX_PROPOSED_CHANGES } from '@/lib/reconSettings/roeParse'
import { REGISTRY_DIGEST } from '@/lib/reconSettings/registryDigest.generated'
import { actingAdminId } from '@/lib/roe/actor'
import { agentEnforcementWarning } from '@/lib/roe/agentWarning'
import { extractRoeText, ExtractError } from '@/lib/roe/extractText'
import { readRoeUpload } from '@/lib/roe/upload'
import { MAX_MODEL_CHARS } from '@/lib/roe/limits'

// Under undici's 300 s default, and over the agent's own 270 s cap on the model
// call, so a slow model reaches the person as a coded timeout.
const AGENT_TIMEOUT_MS = 285_000

/**
 * The form's present values, so the proposal is a diff rather than a list.
 *
 * Optional: without it every parsed field reads as a change, which is correct
 * for a new project and merely noisier for an existing one.
 */
function readCurrentValues(formData: FormData): Record<string, unknown> {
  const raw = formData.get('current')
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function logOutcome(outcome: string, fields: Record<string, unknown>) {
  // Names, sizes and counts only: never the document text or a contact field.
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`)
  console.info(`[roe-parse] outcome=${outcome} ${parts.join(' ')}`)
}

// POST /api/roe/parse - Upload RoE document, extract text, forward to agent for LLM parsing
export async function POST(request: NextRequest) {
  const started = Date.now()
  try {
    if (!sameOrigin(request)) return crossOriginResponse()

    // The caller's own "RoE parsing" model on their own keys. Checked before the
    // upload is read: without a user there is nobody whose keys may be spent.
    const eff = await requireEffectiveUser()
    if (eff instanceof NextResponse) return eff
    const model = await readFeatureModel(eff.userId, 'roe_parse')
    if (!model) return featureModelErrorResponse('model_required', 'roe_parse')

    const upload = await readRoeUpload(request)
    if (upload instanceof NextResponse) return upload
    const { formData, file, kind, bytes } = upload

    let doc
    try {
      doc = await extractRoeText(bytes, kind)
    } catch (err) {
      if (err instanceof ExtractError) {
        logOutcome(err.code, { bytes: bytes.length, kind, ms: Date.now() - started })
        return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
      }
      throw err
    }

    const audit = async (outcome: string, counts: Record<string, number> = {}) => {
      logOutcome(outcome, {
        bytes: bytes.length, pages: doc.pages, kind, model, ms: Date.now() - started,
        ...counts,
      })
      await writeAudit({
        actorId: eff.userId,
        action: 'roe.parse',
        targetType: 'create',
        after: {
          documentName: file.name,
          bytesSha256: doc.bytesSha256,
          bytes: bytes.length,
          pages: doc.pages,
          model,
          outcome,
          counts,
          actingAdminId: await actingAdminId(eff),
        },
      })
    }

    // The model is the one saved in the user's settings, never a form field: a
    // client cannot pick a model the user never chose.
    const agent = await callFeatureAgent({
      featureId: 'roe_parse',
      path: '/roe/parse',
      model,
      body: { text: doc.text, model, user_id: eff.userId },
      timeoutMs: AGENT_TIMEOUT_MS,
    })
    if (!agent.ok) {
      await audit(agent.code ?? 'agent_error')
      return agent.response
    }

    const parsed = agent.body as { fields?: unknown; unknownKeys?: unknown; registryDigest?: unknown }

    // The agent bakes its own copy of the registry, so it compares its prompt
    // with itself and never sees that it is stale. This side holds the current
    // registry: an agent built from another one parsed against a catalogue the
    // validators below no longer describe.
    if (parsed?.registryDigest !== REGISTRY_DIGEST) {
      await audit('agent_registry_outdated')
      return NextResponse.json(
        {
          error:
            'The agent was built from a different settings registry than this webapp, so it parsed ' +
            'the document against an outdated field list. Nothing was applied. Rebuild the agent ' +
            'image: docker compose build agent && docker compose up -d agent.',
          code: 'agent_registry_outdated',
        },
        { status: 503 },
      )
    }

    // The agent returns what the MODEL said. This turns it into a PROPOSAL: every
    // value re-validated against the same registry bounds an MCP write goes
    // through, a scope column refused rather than applied, and a rejected value
    // reported rather than dropped. Nothing here writes; the form shows the diff
    // and a person confirms it.
    //
    // Re-validating is not belt and braces. The document is a third party's text,
    // an LLM reading it is not a sanitiser, and after the parser gained the whole
    // pipeline the difference between "validated" and "trusted" is the difference
    // between a configuration change and a configuration attack.
    const fields = (parsed?.fields ?? {}) as Record<string, unknown>
    const current = readCurrentValues(formData)
    const proposal = buildParseProposal(fields, current)
    const unknownKeys = Array.isArray(parsed?.unknownKeys) ? parsed.unknownKeys.filter(k => typeof k === 'string') : []
    const counts = {
      changes: proposal.changes.length,
      rejected: proposal.rejected.length,
      ignored: proposal.ignored.length,
      unknown: unknownKeys.length,
    }

    // A document that would change more settings than any real one ever has is
    // a failed parse, not a demanding policy. Refusing beats asking somebody to
    // review hundreds of rows they did not ask for.
    if (proposalIsImplausible(proposal.changes.length)) {
      await audit('implausible', counts)
      return NextResponse.json(
        {
          error:
            `The model proposed ${proposal.changes.length} setting changes from this document, ` +
            `which is more than any Rules of Engagement document should make (limit ${MAX_PROPOSED_CHANGES}). ` +
            `Nothing has been changed. This is almost always the model answering with its whole field ` +
            `list rather than reading the document; try again, or try a different model.`,
          proposedCount: proposal.changes.length,
          limit: MAX_PROPOSED_CHANGES,
        },
        { status: 422 }
      )
    }

    const modelTruncated = doc.text.length > MAX_MODEL_CHARS
    const warnings: string[] = []
    if (doc.truncated || modelTruncated) {
      warnings.push(
        `The document is longer than the model reads: only its first ${MAX_MODEL_CHARS.toLocaleString('en-US')} ` +
        `characters were parsed. Check that nothing after that point needed to be applied.`
      )
    }
    const resulting = { ...current, ...Object.fromEntries(proposal.changes.map(c => [c.key, c.after])) }
    const enforcement = agentEnforcementWarning(proposal.changes.map(c => c.key), resulting)
    if (enforcement) warnings.push(enforcement)

    await audit('ok', counts)

    return NextResponse.json({
      ...proposal,
      // Kept separate from the proposal: it is the document, not a setting a
      // person reviews, and the form stores it alongside whatever it confirms.
      roeRawText: doc.text,
      modelUsed: model,
      unknownKeys,
      registryDigest: REGISTRY_DIGEST,
      bytesSha256: doc.bytesSha256,
      textSha256: doc.textSha256,
      pages: doc.pages,
      truncated: doc.truncated || modelTruncated,
      warnings,
    })
  } catch (error) {
    // The document never reaches this process as anything but bytes and the
    // extractor's text, so an error here is infrastructure, not the document.
    console.error('RoE parse error:', error)
    return NextResponse.json({ error: 'Failed to parse the RoE document.' }, { status: 500 })
  }
}
