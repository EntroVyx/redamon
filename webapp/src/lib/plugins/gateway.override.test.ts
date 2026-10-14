/**
 * The Gateway's override operations (`sdk.override.*`, D-45, R-53, TD-19): a plugin reads a
 * skill's factory parts, the version the agent actually runs and the limits, proposes a
 * complete snapshot the agent validates, and withdraws its own pending proposals. The
 * platform, never the plugin, records the factory hashes and texts and the revision the
 * proposal was built on.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'crypto'

const h = vi.hoisted(() => ({
  db: null as unknown as Record<string, unknown>,
  agent: null as unknown as (path: string, init?: RequestInit) => Promise<Response>,
  agentCalls: [] as { path: string; body: unknown }[],
  audits: [] as Record<string, unknown>[],
}))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/agentFetch', () => {
  class AgentUnreachableError extends Error {}
  return {
    AgentUnreachableError,
    agentFetch: (path: string, init?: RequestInit) => {
      h.agentCalls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return h.agent(path, init)
    },
  }
})
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async (e: Record<string, unknown>) => void h.audits.push(e)) }))

import { AgentUnreachableError } from '@/lib/agentFetch'
import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import {
  ALICE,
  ALICE_CONV,
  ALICE_PROJECT,
  BOB,
  CALL_SECRET,
  answer,
  echoInstall,
  echoManifest,
  gatewayRequest,
  seedWorld,
  token,
  type TokenInput,
} from './__testing__/gatewayHarness'
import { setNowForTests } from './clock'
import * as ov from './overrides'
import { clearSkillPartsCache } from './skillPartsRegistry'
import { POST as overrideGet } from '@/app/api/plugin-gateway/v1/override/get/route'
import { POST as overridePropose } from '@/app/api/plugin-gateway/v1/override/propose/route'
import { POST as overrideWithdraw } from '@/app/api/plugin-gateway/v1/override/withdraw/route'

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const FACTORY = { payload_reference: 'Use ../ sequences.', tools: 'Traversal tools {timeout}.' }
const part = (partId: keyof typeof FACTORY, order: number, kind = 'plain') => ({
  partId,
  constant: `path_traversal_prompts.${partId.toUpperCase()}`,
  kind,
  placeholders: kind === 'template' ? ['timeout'] : [],
  sha256: sha(FACTORY[partId]),
  chars: FACTORY[partId].length,
  maxChars: 4000,
  order,
  gate: 'always, when the skill renders',
  text: FACTORY[partId],
})
const REGISTRY = {
  skills: [{ id: 'path_traversal', maxChars: 66, parts: [part('tools', 1, 'template'), part('payload_reference', 5)] }],
}
const VALID = {
  ok: true,
  parts: { payload_reference: { errors: [], chars: 10, maxChars: 4000 } },
  skill: { errors: [], chars: 36, maxChars: 66 },
}
let validateAnswer: () => Response

let db: FakePrisma
let t = Date.parse('2026-10-09T10:00:00.000Z')
beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  seedWorld(db)
  db.seed('pluginInstall', [echoInstall({ pluginId: 'other', manifest: echoManifest({ id: 'other' }) })])
  h.agentCalls = []
  h.audits = []
  validateAnswer = () => Response.json(VALID)
  h.agent = async (path) => (path === '/plugins/skill-parts' ? Response.json(REGISTRY) : validateAnswer())
  clearSkillPartsCache()
  vi.stubEnv('PLUGIN_CALL_TOKEN_SECRET', CALL_SECRET)
  vi.stubEnv('AUTH_SECRET', 'a'.repeat(64))
  t = Date.parse('2026-10-09T10:00:00.000Z')
  setNowForTests(() => new Date(t))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  setNowForTests(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const get = async (body: Record<string, unknown> = { point: 'skill.text', targetGroup: 'path_traversal' }, over: TokenInput = {}) =>
  answer(await overrideGet(gatewayRequest('override/get', body, { token: await token(over) })))
const propose = async (body: Record<string, unknown>, over: TokenInput = {}) =>
  answer(await overridePropose(gatewayRequest('override/propose', body, { token: await token(over) })))
const withdraw = async (changeSetId: unknown, over: TokenInput = {}) =>
  answer(await overrideWithdraw(gatewayRequest('override/withdraw', { changeSetId }, { token: await token(over) })))
const proposal = (parts: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  point: 'skill.text',
  targetGroup: 'path_traversal',
  parts,
  note: 'Encoded traversal worked where plain dots were filtered.',
  scope: 'user',
  ...extra,
})

/** An approved version, as a person would leave it. */
async function approved(scope: ov.OverrideScope, parts: Record<string, string>, pluginId = 'echo') {
  const { changeSetId } = await ov.propose({
    pluginId,
    point: 'skill.text',
    scope,
    targetGroup: 'path_traversal',
    parts: Object.entries(parts).map(([p, value]) => ({ targetKey: `path_traversal/${p}`, value, baseSha256: sha(FACTORY[p as keyof typeof FACTORY]) })),
    createdBy: ALICE,
  })
  t += 1000
  await ov.approve(changeSetId, ALICE, { 'path_traversal/tools': sha(FACTORY.tools), 'path_traversal/payload_reference': sha(FACTORY.payload_reference) })
  return changeSetId
}

describe('override/get', () => {
  test('factory text: the contract shape, no active version', async () => {
    const r = await get()
    expect(r).toEqual({
      status: 200,
      body: {
        point: 'skill.text',
        targetGroup: 'path_traversal',
        displayName: 'Path Traversal / LFI / RFI',
        parts: [
          // kind and placeholders tell a plugin how to edit a part (TD-26): a template keeps
          // its placeholders and doubles new literal braces; a plain part is verbatim.
          { partId: 'tools', text: FACTORY.tools, sha256: sha(FACTORY.tools), chars: 26, maxChars: 4000, kind: 'template', placeholders: ['timeout'] },
          {
            partId: 'payload_reference',
            text: FACTORY.payload_reference,
            sha256: sha(FACTORY.payload_reference),
            chars: 18,
            maxChars: 4000,
            kind: 'plain',
            placeholders: [],
          },
        ],
        active: null,
        pendingCount: 0,
        limits: { skillMaxChars: 66, parts: { tools: 4000, payload_reference: 4000 } },
      },
    })
  })

  test('with a project: the project version when one is active, else the user version', async () => {
    const userSet = await approved({ type: 'user', id: ALICE }, { payload_reference: 'user version' })
    let r = await get()
    expect(r.body.active).toEqual({
      changeSetId: userSet,
      scope: 'user',
      revision: 2,
      decidedAt: '2026-10-09T10:00:01.000Z',
      pluginId: 'echo',
      parts: { payload_reference: 'user version' },
    })
    const projectSet = await approved({ type: 'project', id: ALICE_PROJECT }, { tools: 'project {timeout}' })
    r = await get()
    expect(r.body.active).toMatchObject({ changeSetId: projectSet, scope: 'project', parts: { tools: 'project {timeout}' } })
    r = await get(undefined, { prj: undefined, ses: undefined, conv: undefined })
    expect(r.body.active).toMatchObject({ changeSetId: userSet, scope: 'user' })
  })

  test('a version the agent does not run (its plugin disabled, or stale) is not "active"', async () => {
    await approved({ type: 'user', id: ALICE }, { payload_reference: 'by other' }, 'other')
    await db.pluginInstall.update({ where: { pluginId: 'other' }, data: { enabled: false } })
    expect((await get()).body.active).toBeNull()
    expect((await get(undefined, { prj: undefined, ses: undefined, conv: undefined })).body.active).toBeNull()
    const projectSet = await approved({ type: 'project', id: ALICE_PROJECT }, { tools: 'p {timeout}' })
    await ov.markStale(projectSet, 'factory_changed')
    expect((await get()).body.active).toBeNull()
  })

  test("pendingCount counts the user scope's proposals waiting for a decision, any plugin", async () => {
    await propose(proposal({ payload_reference: 'A' }))
    await propose(proposal({ payload_reference: 'B' }), { sub: ALICE })
    await ov.propose({ pluginId: 'other', point: 'skill.text', scope: { type: 'user', id: ALICE }, targetGroup: 'path_traversal', parts: [{ targetKey: 'path_traversal/tools', value: 'x {timeout}', baseSha256: sha(FACTORY.tools) }], createdBy: ALICE })
    await ov.propose({ pluginId: 'echo', point: 'skill.text', scope: { type: 'user', id: BOB }, targetGroup: 'path_traversal', parts: [{ targetKey: 'path_traversal/tools', value: 'x {timeout}', baseSha256: sha(FACTORY.tools) }], createdBy: BOB })
    expect((await get()).body.pendingCount).toBe(3)
  })

  test('an unknown skill: 404 invalid_target with the contract message', async () => {
    expect(await get({ point: 'skill.text', targetGroup: 'no_such_skill' })).toEqual({
      status: 404,
      body: { error: "unknown skill 'no_such_skill'", code: 'invalid_target' },
    })
  })

  test.each([
    ['an unknown point', { point: 'nav', targetGroup: 'path_traversal' }],
    ['a malformed target group', { point: 'skill.text', targetGroup: '../x' }],
    ['no target group', { point: 'skill.text' }],
  ])('%s: 400 invalid_target', async (_n, body) => {
    const r = await get(body)
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('invalid_target')
  })

  test('without override:skill.text granted: 403', async () => {
    const own = await propose(proposal({ payload_reference: 'mine' }))
    await db.pluginInstall.update({ where: { pluginId: 'echo' }, data: { grantedPermissions: ['session:read'] } })
    expect((await get()).status).toBe(403)
    expect((await propose(proposal({ payload_reference: 'x' }))).status).toBe(403)
    // The withdraw permission is the set's own point's, checked once the set is read.
    expect((await withdraw(own.body.changeSetId as string)).status).toBe(403)
  })

  test('withdraw of an id that is not this plugin\'s: 404 before any permission is looked at', async () => {
    await db.pluginInstall.update({ where: { pluginId: 'echo' }, data: { grantedPermissions: ['session:read'] } })
    expect(await withdraw('11111111-2222-3333-4444-555555555555')).toMatchObject({ status: 404, body: { code: 'not_found' } })
  })

  test('agent unreachable: 503 agent_unreachable; agent without the endpoint: 503 agent_outdated', async () => {
    h.agent = async () => {
      throw new AgentUnreachableError('down')
    }
    expect((await get()).body).toMatchObject({ code: 'agent_unreachable' })
    expect((await get()).status).toBe(503)
    h.agent = async () => Response.json({ detail: 'Not Found' }, { status: 404 })
    const r = await get()
    expect(r).toMatchObject({ status: 503, body: { code: 'agent_outdated' } })
  })
})

describe('override/propose', () => {
  test('the contract answer; the agent validated exactly the snapshot', async () => {
    const r = await propose(proposal({ payload_reference: 'Use ../ sequences.\nAlso try URL-encoded dots.' }, { meta: { sourceSessionId: 'session-1' } }))
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ changeSetId: expect.stringMatching(/^[0-9a-f-]{36}$/), fromRevision: 1, proposedRevisionLabel: 'v2' })
    const validate = h.agentCalls.find((c) => c.path === '/plugins/skill-parts/validate')
    expect(validate?.body).toEqual({ skillId: 'path_traversal', parts: { payload_reference: 'Use ../ sequences.\nAlso try URL-encoded dots.' } })
    const set = await ov.getChangeSet(r.body.changeSetId as string)
    expect(set).toMatchObject({
      pluginId: 'echo',
      status: 'proposed',
      scope: { type: 'user', id: ALICE },
      note: 'Encoded traversal worked where plain dots were filtered.',
      createdBy: ALICE,
      meta: {
        sourceSessionId: 'session-1',
        fromRevision: 1,
        baseFactoryText: { payload_reference: FACTORY.payload_reference },
      },
    })
    expect(set!.parts).toEqual([
      expect.objectContaining({ partId: 'payload_reference', value: 'Use ../ sequences.\nAlso try URL-encoded dots.', baseSha256: sha(FACTORY.payload_reference) }),
    ])
  })

  test('baseSha256, fromRevision and baseFactoryText come from the platform, whatever the plugin sends', async () => {
    await approved({ type: 'user', id: ALICE }, { tools: 'v2 {timeout}' })
    await approved({ type: 'user', id: ALICE }, { tools: 'v3 {timeout}' })
    const r = await propose(
      proposal(
        { payload_reference: 'mine' },
        {
        baseSha256: 'f'.repeat(64),
        meta: {
          fromRevision: 99, baseFactoryText: { payload_reference: 'forged' }, staleReason: 'part_removed',
          pluginVersion: '9.9.9', conversationId: 'forged', jobId: 'forged', adoptedSkillId: 'forged',
          baseText: 'forged', sourceName: 'forged', adoptedName: 'forged', withdrawReason: 'forged',
        },
      },
      ),
    )
    expect(r.body).toMatchObject({ fromRevision: 3, proposedRevisionLabel: 'v4' })
    const set = await ov.getChangeSet(r.body.changeSetId as string)
    // The proposer's version, conversation and job come from the call token, never the body.
    expect(set!.meta).toEqual({
      fromRevision: 3,
      baseFactoryText: { payload_reference: FACTORY.payload_reference },
      pluginVersion: '1.0.0',
      conversationId: ALICE_CONV,
      jobId: null,
    })
    expect(set!.parts[0].baseSha256).toBe(sha(FACTORY.payload_reference))
  })

  test('a part equal to its factory text is not part of the snapshot', async () => {
    const r = await propose(proposal({ tools: FACTORY.tools, payload_reference: 'changed' }))
    expect((await ov.getChangeSet(r.body.changeSetId as string))!.parts.map((p) => p.partId)).toEqual(['payload_reference'])
  })

  test('a proposal that changes nothing: 422 invalid_proposal, nothing stored', async () => {
    const r = await propose(proposal({ tools: FACTORY.tools }))
    expect(r).toMatchObject({ status: 422, body: { code: 'invalid_proposal' } })
    expect(db.rows('pluginOverride')).toHaveLength(0)
  })

  test('an unknown part: 422 with the contract body, the agent not asked', async () => {
    const r = await propose(proposal({ no_such_part: 'x' }, { note: 'x' }))
    expect(r.status).toBe(422)
    expect(r.body).toMatchObject({ error: 'unknown part path_traversal/no_such_part', code: 'invalid_proposal' })
    expect(h.agentCalls.some((c) => c.path === '/plugins/skill-parts/validate')).toBe(false)
  })

  test("an invalid template part: 422 with the agent's errors", async () => {
    validateAnswer = () =>
      Response.json({
        ok: false,
        parts: { tools: { errors: ['placeholder {timeout} is missing'], chars: 5, maxChars: 4000 } },
        skill: { errors: [], chars: 23, maxChars: 66 },
      })
    const r = await propose(proposal({ tools: 'tools' }))
    expect(r.status).toBe(422)
    expect(r.body).toMatchObject({
      code: 'invalid_proposal',
      error: 'path_traversal/tools: placeholder {timeout} is missing',
      errors: { parts: { tools: ['placeholder {timeout} is missing'] }, skill: [] },
    })
    expect(db.rows('pluginOverride')).toHaveLength(0)
  })

  test('parts within their caps but over the whole-skill total: 422 naming the total', async () => {
    validateAnswer = () =>
      Response.json({
        ok: false,
        parts: { payload_reference: { errors: [], chars: 60, maxChars: 4000 } },
        skill: { errors: ['path_traversal: the whole skill would be 86 characters; the limit is 66 (1.5 x its factory 44)'], chars: 86, maxChars: 66 },
      })
    const r = await propose(proposal({ payload_reference: 'y'.repeat(60) }))
    expect(r.status).toBe(422)
    expect(String(r.body.error)).toContain('the whole skill would be 86 characters; the limit is 66')
  })

  test('a sixth pending proposal: 409 with the contract body', async () => {
    for (let i = 0; i < 5; i++) expect((await propose(proposal({ payload_reference: `v${i}` }))).status).toBe(200)
    expect(await propose(proposal({ payload_reference: 'v7' }, { note: 'sixth' }))).toEqual({
      status: 409,
      body: { error: 'There are already 5 proposals waiting for a decision on path_traversal', code: 'too_many_pending' },
    })
  })

  test('scope project inside a project goes to that project; outside one: 400', async () => {
    const r = await propose(proposal({ payload_reference: 'p' }, { scope: 'project' }))
    expect((await ov.getChangeSet(r.body.changeSetId as string))!.scope).toEqual({ type: 'project', id: ALICE_PROJECT })
    const out = await propose(proposal({ payload_reference: 'p' }, { scope: 'project' }), { prj: undefined, ses: undefined, conv: undefined })
    expect(out).toMatchObject({ status: 400, body: { code: 'invalid_proposal' } })
    expect((await propose(proposal({ payload_reference: 'p' }, { scope: 'global' }))).status).toBe(400)
  })

  test.each<[string, Record<string, unknown>]>([
    ['parts that are not an object', { parts: ['x'] }],
    ['no parts', { parts: {} }],
    ['a part that is not text', { parts: { payload_reference: 7 } }],
    ['no note', { note: undefined }],
    ['a note over 4,000 characters', { note: 'n'.repeat(4001) }],
    ['meta that is a list', { meta: [1] }],
  ])('%s: 400 or 422 invalid_proposal, nothing stored', async (_n, extra) => {
    const r = await propose(proposal({ payload_reference: 'x' }, extra))
    expect([400, 422]).toContain(r.status)
    expect(r.body.code).toBe('invalid_proposal')
    expect(db.rows('pluginOverride')).toHaveLength(0)
  })

  test('agent unreachable during propose: 503, nothing stored', async () => {
    validateAnswer = () => {
      throw new AgentUnreachableError('down')
    }
    expect((await propose(proposal({ payload_reference: 'x' }))).body).toMatchObject({ code: 'agent_unreachable' })
    expect(db.rows('pluginOverride')).toHaveLength(0)
  })

  test('audited: plugin.override.propose on the change set; an admin acting as the user is the actor', async () => {
    const r = await propose(proposal({ payload_reference: 'x' }), { act: 'user-admin' })
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: 'plugin.override.propose',
        actorId: 'user-admin',
        targetType: 'plugin_change_set',
        targetId: r.body.changeSetId,
        after: expect.objectContaining({ pluginId: 'echo', targetGroup: 'path_traversal', scope: 'user', scopeId: ALICE, parts: ['payload_reference'], fromRevision: 1, onBehalfOf: ALICE }),
      }),
    ])
  })
})

describe('override/withdraw', () => {
  test('its own pending proposal: {withdrawn: true}, audited', async () => {
    const { body } = await propose(proposal({ payload_reference: 'x' }))
    expect(await withdraw(body.changeSetId)).toEqual({ status: 200, body: { withdrawn: true } })
    expect((await ov.getChangeSet(body.changeSetId as string))!.status).toBe('withdrawn')
    expect(h.audits.map((a) => a.action)).toEqual(['plugin.override.propose', 'plugin.override.withdraw'])
  })

  test('an unknown change set: 404 with the contract body', async () => {
    expect(await withdraw('no-such-set')).toEqual({ status: 404, body: { error: 'No proposal no-such-set of this plugin.', code: 'not_found' } })
  })

  test("another plugin's proposal, another user's, another project's: 404", async () => {
    const { changeSetId: others } = await ov.propose({ pluginId: 'other', point: 'skill.text', scope: { type: 'user', id: ALICE }, targetGroup: 'path_traversal', parts: [{ targetKey: 'path_traversal/tools', value: 'x {timeout}', baseSha256: sha(FACTORY.tools) }], createdBy: ALICE })
    expect((await withdraw(others)).status).toBe(404)
    const bobs = await propose(proposal({ payload_reference: 'bob' }), { sub: BOB, prj: 'project-bob', ses: 'session-bob', conv: 'conv-bob' })
    expect((await withdraw(bobs.body.changeSetId)).status).toBe(404)
    const inProject = await propose(proposal({ payload_reference: 'p' }, { scope: 'project' }))
    expect((await withdraw(inProject.body.changeSetId, { prj: 'project-alice-2', ses: undefined, conv: undefined })).status).toBe(404)
    for (const id of [others, bobs.body.changeSetId, inProject.body.changeSetId]) {
      expect((await ov.getChangeSet(id as string))!.status).toBe('proposed')
    }
  })

  test('a proposal already decided: 409 wrong_state', async () => {
    const { body } = await propose(proposal({ payload_reference: 'x' }))
    await ov.reject(body.changeSetId as string, ALICE)
    expect(await withdraw(body.changeSetId)).toMatchObject({ status: 409, body: { code: 'wrong_state' } })
  })
})
