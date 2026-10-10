/**
 * Shared setup for the core review routes' tests: a fake agent skill-parts registry and
 * validator over one skill, plus seed helpers for installs and proposals.
 */
import { createHash } from 'node:crypto'
import type { FakePrisma } from './fakePrisma'
import { propose, type OverrideScope } from '../overrides'

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

/** Factory text of the one skill these tests use. */
export const FACTORY: Record<string, string> = {
  workflow: 'Enumerate the service and record findings.',
  payloads: 'Try the standard payload list {target}.',
}

const partEntry = (partId: string, order: number, kind: string) => ({
  partId,
  constant: `ssrf_prompts.${partId.toUpperCase()}`,
  kind,
  placeholders: kind === 'template' ? ['target'] : [],
  sha256: sha256(FACTORY[partId]),
  chars: FACTORY[partId].length,
  maxChars: 4000,
  order,
  gate: 'always',
  text: FACTORY[partId],
})

export const REGISTRY = {
  skills: [{ id: 'ssrf', maxChars: 4000, parts: [partEntry('workflow', 1, 'plain'), partEntry('payloads', 2, 'template')] }],
}

export const VALID_VERDICT = {
  ok: true,
  parts: { workflow: { errors: [], chars: 10, maxChars: 4000 }, payloads: { errors: [], chars: 10, maxChars: 4000 } },
  skill: { errors: [], chars: 20, maxChars: 4000 },
}

export const OVER_LIMIT_VERDICT = {
  ok: false,
  parts: { workflow: { errors: [], chars: 10, maxChars: 4000 } },
  skill: { errors: ['the whole skill is 5000 characters; at most 4000'], chars: 5000, maxChars: 4000 },
}

export interface AgentState {
  registryStatus: number
  registryBody: unknown
  verdict: unknown
}

export function freshAgent(): AgentState {
  return { registryStatus: 200, registryBody: REGISTRY, verdict: VALID_VERDICT }
}

/** The agentFetch stand-in: serves the registry and the validator from `state`. */
export function agentHandler(state: AgentState) {
  return async (path: string): Promise<Response> => {
    if (path.startsWith('/plugins/skill-parts/validate')) {
      return new Response(JSON.stringify(state.verdict), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (path.startsWith('/plugins/skill-parts')) {
      return new Response(JSON.stringify(state.registryBody), { status: state.registryStatus, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('{}', { status: 404 })
  }
}

export const QUALIFYING = { status: 'ready', enabled: true, grantedPermissions: ['override:skill.text'] }

export function seedWorld(db: FakePrisma) {
  db.seed('pluginInstall', [
    { pluginId: 'skiller', manifest: { id: 'skiller', displayName: 'Skiller' }, ...QUALIFYING },
    { pluginId: 'other', manifest: { id: 'other', displayName: 'Other Plugin' }, ...QUALIFYING },
  ])
  db.seed('user', [
    { id: 'alice', email: 'a@example.com', role: 'standard' },
    { id: 'bob', email: 'b@example.com', role: 'standard' },
  ])
  db.seed('project', [
    { id: 'p-alice', userId: 'alice', name: 'A' },
    { id: 'p-bob', userId: 'bob', name: 'B' },
  ])
}

export const userScope = (id: string): OverrideScope => ({ type: 'user', id })
export const projectScope = (id: string): OverrideScope => ({ type: 'project', id })

/** Proposes `{partId: text}` against the given scope, built on the current factory hashes. */
export async function seedProposal(
  scope: OverrideScope,
  parts: Record<string, string>,
  opts: { pluginId?: string; createdBy?: string; fromRevision?: number; meta?: Record<string, unknown> } = {},
): Promise<string> {
  const { changeSetId } = await propose({
    pluginId: opts.pluginId ?? 'skiller',
    point: 'skill.text',
    scope,
    targetGroup: 'ssrf',
    parts: Object.entries(parts).map(([partId, value]) => ({ targetKey: `ssrf/${partId}`, value, baseSha256: sha256(FACTORY[partId]) })),
    meta: opts.meta as never,
    platformMeta: {
      fromRevision: opts.fromRevision ?? 1,
      baseFactoryText: Object.fromEntries(Object.keys(parts).map((p) => [p, FACTORY[p]])),
    },
    createdBy: opts.createdBy ?? (scope.type === 'user' ? scope.id : 'alice'),
  })
  return changeSetId
}
