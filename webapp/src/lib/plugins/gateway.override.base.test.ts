/**
 * The base a proposal is built on (TD-19, RV-25, RV-54; phase 04 review). The platform
 * records each part's factory hash and text, and the revision the proposal starts from, so
 * what a person reviews says truthfully what approving replaces:
 * - `override/get` shows a version as active only while the agent would run it: one built
 *   on a factory text a RedAmon update has since changed is dropped by the agent, and a
 *   plugin that rebuilt on it would carry the old wording past the update unseen;
 * - a plugin may send back the hashes it read (`readSha256`, which the SDK fills in): a
 *   factory changed in between refuses the proposal (409 factory_changed) instead of
 *   stamping old-base text with the new hash;
 * - `meta.fromRevision` is the revision of the proposal's own scope that the plugin was
 *   shown. A plugin shown another scope's version, or factory text over a version that is
 *   not running, built on no revision of its scope: `fromRevision` is then the factory's,
 *   so the review warns that approving replaces the scope's active version, and
 *   `meta.basedOn` names what it was shown.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'crypto'

const h = vi.hoisted(() => ({
  db: null as unknown as Record<string, unknown>,
  agent: null as unknown as (path: string, init?: RequestInit) => Promise<Response>,
}))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/agentFetch', () => {
  class AgentUnreachableError extends Error {}
  return { AgentUnreachableError, agentFetch: (path: string, init?: RequestInit) => h.agent(path, init) }
})
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async () => {}) }))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { ALICE, ALICE_PROJECT, CALL_SECRET, answer, gatewayRequest, seedWorld, token, type TokenInput } from './__testing__/gatewayHarness'
import { setNowForTests } from './clock'
import * as ov from './overrides'
import { clearSkillPartsCache } from './skillPartsRegistry'
import { POST as overrideGet } from '@/app/api/plugin-gateway/v1/override/get/route'
import { POST as overridePropose } from '@/app/api/plugin-gateway/v1/override/propose/route'

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const ORIGINAL = { payload_reference: 'Use ../ sequences.', tools: 'Traversal tools {timeout}.' }
let factory: Record<string, string> = { ...ORIGINAL }
const part = (partId: string, order: number, kind = 'plain') => ({
  partId,
  constant: `c.${partId}`,
  kind,
  placeholders: kind === 'template' ? ['timeout'] : [],
  sha256: sha(factory[partId]),
  chars: factory[partId].length,
  maxChars: 4000,
  order,
  gate: 'always',
  text: factory[partId],
})
const registry = () => ({ skills: [{ id: 'path_traversal', maxChars: 4000, parts: [part('tools', 1, 'template'), part('payload_reference', 5)] }] })
const VALID = { ok: true, parts: {}, skill: { errors: [], chars: 1, maxChars: 4000 } }

let db: FakePrisma
let t = Date.parse('2026-10-09T10:00:00.000Z')
beforeEach(() => {
  factory = { ...ORIGINAL }
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  seedWorld(db)
  h.agent = async (path) => (path === '/plugins/skill-parts' ? Response.json(registry()) : Response.json(VALID))
  clearSkillPartsCache()
  vi.stubEnv('PLUGINS_ENABLED', 'true')
  vi.stubEnv('PLUGIN_CALL_TOKEN_SECRET', CALL_SECRET)
  vi.stubEnv('AUTH_SECRET', 'a'.repeat(64))
  t = Date.parse('2026-10-09T10:00:00.000Z')
  setNowForTests(() => new Date(t))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  setNowForTests(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const OUTSIDE_A_PROJECT: TokenInput = { prj: undefined, ses: undefined, conv: undefined }
const get = async (over: TokenInput = {}) =>
  answer(await overrideGet(gatewayRequest('override/get', { point: 'skill.text', targetGroup: 'path_traversal' }, { token: await token(over) })))
const propose = async (body: Record<string, unknown>, over: TokenInput = {}) =>
  answer(
    await overridePropose(
      gatewayRequest('override/propose', { point: 'skill.text', targetGroup: 'path_traversal', note: 'n', scope: 'user', ...body }, { token: await token(over) }),
    ),
  )
const meta = async (changeSetId: unknown) => (await ov.getChangeSet(changeSetId as string))!.meta as Record<string, unknown>

/** An approved version built on the current factory text. */
async function approved(scope: ov.OverrideScope, parts: Record<string, string>) {
  const { changeSetId } = await ov.propose({
    pluginId: 'echo',
    point: 'skill.text',
    scope,
    targetGroup: 'path_traversal',
    parts: Object.entries(parts).map(([p, value]) => ({ targetKey: `path_traversal/${p}`, value, baseSha256: sha(factory[p]) })),
    createdBy: ALICE,
  })
  t += 1000
  await ov.approve(changeSetId, ALICE, { 'path_traversal/tools': sha(factory.tools), 'path_traversal/payload_reference': sha(factory.payload_reference) })
  return changeSetId
}

/** A RedAmon update that changes a factory part, seen once the registry cache expires. */
function upstreamFix() {
  factory.payload_reference = 'Use ../ sequences. Stay in scope (upstream fix).'
  t += 5 * 60_000 + 1
}

describe('override/get shows a version only while the agent would run it', () => {
  test.each([
    ['outside a project', OUTSIDE_A_PROJECT],
    ['inside the project', {}],
  ])('%s: a version built on a factory text that has since changed is not active', async (_n, over) => {
    await approved({ type: 'user', id: ALICE }, { payload_reference: 'Use ../ sequences. Also %2e%2e.' })
    expect((await get(over)).body.active).not.toBeNull()
    upstreamFix()
    const r = await get(over)
    expect(r.body.active).toBeNull()
    expect((r.body.parts as { partId: string; text: string }[]).find((p) => p.partId === 'payload_reference')!.text).toContain('upstream fix')
  })
})

describe('the hashes a plugin read are checked against the factory now', () => {
  test('unchanged: the proposal is stored', async () => {
    const read = await get()
    const readSha256 = Object.fromEntries((read.body.parts as { partId: string; sha256: string }[]).map((p) => [p.partId, p.sha256]))
    expect((await propose({ parts: { tools: 'Better tools {timeout}.' }, readSha256 })).status).toBe(200)
  })

  test('changed in between: 409 factory_changed, nothing stored', async () => {
    const read = await get()
    const readSha256 = Object.fromEntries((read.body.parts as { partId: string; sha256: string }[]).map((p) => [p.partId, p.sha256]))
    upstreamFix()
    const r = await propose({ parts: { payload_reference: ORIGINAL.payload_reference + ' Encoded too.' }, readSha256 })
    expect(r).toMatchObject({ status: 409, body: { code: 'factory_changed' } })
    expect(String(r.body.error)).toContain('path_traversal/payload_reference')
    expect(db.rows('pluginOverride')).toEqual([])
  })

  test.each([
    ['not an object', 'abc'],
    ['a hash that is not text', { tools: 7 }],
    ['an unknown part', { nope: 'f'.repeat(64) }],
  ])('readSha256 %s: refused', async (_n, readSha256) => {
    expect((await propose({ parts: { tools: 'Better tools {timeout}.' }, readSha256 })).status).toBeGreaterThanOrEqual(400)
    expect(db.rows('pluginOverride')).toEqual([])
  })
})

describe('fromRevision is the revision of its own scope that the plugin was shown', () => {
  test('shown the project’s version, proposing for the user: built on no user revision', async () => {
    await approved({ type: 'user', id: ALICE }, { payload_reference: 'user v2' })
    const projectSet = await approved({ type: 'project', id: ALICE_PROJECT }, { tools: 'project v2 {timeout}' })
    const shown = (await get()).body.active as { changeSetId: string; parts: Record<string, string> }
    expect(shown.changeSetId).toBe(projectSet)
    const r = await propose({ parts: { ...shown.parts, tools: 'project v2 edited {timeout}' } })
    expect(r.body.fromRevision).toBe(1)
    expect(await meta(r.body.changeSetId)).toMatchObject({ fromRevision: 1, basedOn: { scope: 'project', changeSetId: projectSet, revision: 2 } })
  })

  test('shown factory text over a user version that is not running: built on no user revision', async () => {
    await approved({ type: 'user', id: ALICE }, { payload_reference: 'built on the old factory' })
    upstreamFix()
    const r = await propose({ parts: { tools: 'Better tools {timeout}.' } }, OUTSIDE_A_PROJECT)
    expect(await meta(r.body.changeSetId)).toMatchObject({ fromRevision: 1, basedOn: null })
  })

  test('shown the user’s own active version: fromRevision is it, and no basedOn is recorded', async () => {
    await approved({ type: 'user', id: ALICE }, { payload_reference: 'user v2' })
    const r = await propose({ parts: { payload_reference: 'user v2 edited' } }, OUTSIDE_A_PROJECT)
    expect(r.body.fromRevision).toBe(2)
    expect(await meta(r.body.changeSetId)).not.toHaveProperty('basedOn')
  })
})
