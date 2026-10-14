/**
 * The Gateway at `user_skill.text` (userSkillOverrideOps.ts through the real override routes),
 * beyond the SDK contract cases: no existence oracle (quarantined, foreign, unknown and
 * malformed ids answer the same 404), the agent's text validator failing closed, the pending
 * cap, the part shape, the platform meta the Gateway records from the call token (and the
 * plugin can never forge), the audit, and withdraw's permission read from the set's own point.
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
import { MAX_CONTENT_SIZE } from '@/lib/userSkills'
import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import {
  ALICE,
  ALICE_CONV,
  ALICE_OTHER_PROJECT,
  ALICE_OTHER_SESSION,
  ALICE_PROJECT,
  ALICE_SESSION,
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
import { startJob } from './jobs'
import * as ov from './overrides'
import { clearSkillPartsCache } from './skillPartsRegistry'
import { POST as overrideGet } from '@/app/api/plugin-gateway/v1/override/get/route'
import { POST as overridePropose } from '@/app/api/plugin-gateway/v1/override/propose/route'
import { POST as overrideWithdraw } from '@/app/api/plugin-gateway/v1/override/withdraw/route'

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const sha16 = (s: string) => sha(s).slice(0, 16)

const ALL_PERMS = ['session:read', 'llm:invoke', 'override:skill.text', 'override:user_skill.text']
const SKILL = 'skflow01'
const BASE = 'Enumerate example.com.\nTest every parameter for SQL injection.'
const PROPOSED = 'Enumerate example.com.\nTest every parameter for SQL injection.\nPrefer time-based checks when errors are hidden.'
const BOB_SKILL = 'skbobflow'
const QUARANTINED = 'skquarant'

// A built-in skill, for the skill.text cases of withdraw and the job token.
const FACTORY = 'Use ../ sequences.'
const REGISTRY = {
  skills: [{
    id: 'path_traversal',
    maxChars: 4000,
    parts: [{
      partId: 'payload_reference', constant: 'path_traversal_prompts.PAYLOAD_REFERENCE', kind: 'plain', placeholders: [],
      sha256: sha(FACTORY), chars: FACTORY.length, maxChars: 4000, order: 1, gate: 'always', text: FACTORY,
    }],
  }],
}
const SKILL_PARTS_VALID = { ok: true, parts: { payload_reference: { errors: [], chars: 10, maxChars: 4000 } }, skill: { errors: [], chars: 10, maxChars: 4000 } }

let textVerdict: () => Response | Promise<Response>
let db: FakePrisma
let t = Date.parse('2026-10-09T10:00:00.000Z')

const userRecord = (id: string, content: string) => ({ skillId: `user_skill:${id}`, kind: 'user', contentSha256: sha16(content) })

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  seedWorld(db, { install: echoInstall({ grantedPermissions: ALL_PERMS, manifest: echoManifest({ permissions: ALL_PERMS }) }) })
  db.seed('pluginInstall', [echoInstall({ pluginId: 'other', grantedPermissions: ALL_PERMS, manifest: echoManifest({ id: 'other', permissions: ALL_PERMS }) })])
  db.seed('userAttackSkill', [
    { id: SKILL, userId: ALICE, name: 'My SQLi flow v2', description: 'SQLi on example.com', content: BASE, version: 2, lineageRootId: 'skroot' },
    { id: BOB_SKILL, userId: BOB, name: "Bob's flow", content: 'Bob only.' },
    { id: QUARANTINED, userId: ALICE, name: 'Revoked', content: 'Quarantined text.', quarantinedAt: new Date(t), quarantineReason: 'plugin_version_revoked' },
    { id: 'skcreds', userId: ALICE, name: 'Creds', content: 'Sign requests with AKIAIOSFODNN7EXAMPLE first.' },
    { id: 'skunused', userId: ALICE, name: 'Unused', content: 'Never ran.' },
  ])
  // Alice's session used her skill, her credential-holding one, the quarantined one, and
  // (an imported session) Bob's skill id.
  db.seed('chatMessage', [SKILL, 'skcreds', QUARANTINED, BOB_SKILL].map((id, i) => ({
    conversationId: ALICE_CONV, sequenceNum: 10 + i, type: 'phase_update', createdAt: new Date(t - 60_000 + i),
    data: { current_phase: 'informational', iteration_count: i + 1, attack_path_type: `user_skill:${id}`, skill_workflow: userRecord(id, 'x') },
  })))
  h.agentCalls = []
  h.audits = []
  textVerdict = () => Response.json({ ok: true, errors: [] })
  h.agent = async (path) => {
    if (path === '/plugins/text/validate') return textVerdict()
    if (path === '/plugins/skill-parts') return Response.json(REGISTRY)
    if (path === '/plugins/skill-parts/validate') return Response.json(SKILL_PARTS_VALID)
    return Response.json({ detail: 'Not Found' }, { status: 404 })
  }
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

const tok = (over: TokenInput = {}) => token({ perms: ALL_PERMS, ...over })
const get = async (targetGroup: unknown = SKILL, over: TokenInput = {}) =>
  answer(await overrideGet(gatewayRequest('override/get', { point: 'user_skill.text', targetGroup }, { token: await tok(over) })))
const propose = async (body: Record<string, unknown>, over: TokenInput = {}) =>
  answer(await overridePropose(gatewayRequest('override/propose', body, { token: await tok(over) })))
const withdraw = async (changeSetId: unknown, over: TokenInput = {}) =>
  answer(await overrideWithdraw(gatewayRequest('override/withdraw', { changeSetId }, { token: await tok(over) })))

const proposal = (extra: Record<string, unknown> = {}) => ({
  point: 'user_skill.text',
  targetGroup: SKILL,
  parts: { body: PROPOSED },
  readSha256: { body: sha(BASE) },
  note: 'Time-based checks found what error-based ones missed.',
  scope: 'user',
  ...extra,
})

const grant = (pluginId: string, grantedPermissions: string[]) =>
  db.pluginInstall.update({ where: { pluginId }, data: { grantedPermissions } })

const NOT_FOUND = { status: 404, body: { error: 'No such skill in this session.', code: 'invalid_target' } }

describe('override/get', () => {
  test('the skill as one plain part, its lineage, and no call to the built-in registry', async () => {
    const r = await get()
    expect(r).toEqual({
      status: 200,
      body: {
        point: 'user_skill.text',
        targetGroup: SKILL,
        displayName: 'My SQLi flow v2',
        description: 'SQLi on example.com',
        parts: [{ partId: 'body', text: BASE, sha256: sha(BASE), chars: BASE.length, maxChars: MAX_CONTENT_SIZE, kind: 'plain', placeholders: [] }],
        active: null,
        pendingCount: 0,
        limits: { skillMaxChars: MAX_CONTENT_SIZE, parts: { body: MAX_CONTENT_SIZE } },
        lineage: { rootName: 'My SQLi flow', version: 2 },
      },
    })
    expect(h.agentCalls.map((c) => c.path)).toEqual([])
  })

  test('lineage of a never-versioned skill comes from its name; a bare name is v1', async () => {
    await db.userAttackSkill.update({ where: { id: SKILL }, data: { version: null, name: 'Recon notes v7' } })
    expect((await get()).body.lineage).toEqual({ rootName: 'Recon notes', version: 7 })
    await db.userAttackSkill.update({ where: { id: SKILL }, data: { name: 'Recon notes' } })
    expect((await get()).body.lineage).toEqual({ rootName: 'Recon notes', version: 1 })
  })

  test('pendingCount counts the user scope proposals waiting on this skill', async () => {
    await propose(proposal())
    await propose(proposal({ parts: { body: PROPOSED + '\nAnother line.' } }))
    expect((await get()).body.pendingCount).toBe(2)
  })

  test('quarantined, foreign, unknown, malformed or absent: the same 404, so no id can be probed', async () => {
    const answers = [
      await get(QUARANTINED),
      await get(BOB_SKILL),
      await get('sknosuchskill'),
      await get('Bad-Id'),
      await get('../x'),
      await get(42),
      await get(null),
      await answer(await overrideGet(gatewayRequest('override/get', { point: 'user_skill.text' }, { token: await tok() }))),
    ]
    for (const a of answers) expect(a).toEqual(NOT_FOUND)
  })

  test('a skill of the user that this session never used: 404', async () => {
    expect(await get('skunused')).toEqual(NOT_FOUND)
    // Used in Alice's session, asked from her other session that never ran it.
    expect(await get(SKILL, { prj: ALICE_OTHER_PROJECT, ses: ALICE_OTHER_SESSION, conv: 'conv-alice-2' })).toEqual(NOT_FOUND)
  })

  test('a session recorded before the agent recorded user skills: its label is enough', async () => {
    await db.chatMessage.deleteMany({})
    db.seed('chatMessage', [{
      conversationId: ALICE_CONV, sequenceNum: 1, type: 'phase_update', createdAt: new Date(t),
      data: { current_phase: 'exploitation', iteration_count: 1, attack_path_type: `user_skill:${SKILL}` },
    }])
    expect((await get()).status).toBe(200)
  })

  test('a check that cannot run is a refusal (404), never a pass', async () => {
    db.chatMessage.findMany = (async () => {
      throw new Error('db down')
    }) as never
    expect(await get()).toEqual(NOT_FOUND)
  })

  test('credential-shaped text: 422 skill_contains_credentials', async () => {
    expect(await get('skcreds')).toMatchObject({ status: 422, body: { code: 'skill_contains_credentials' } })
  })

  test('without override:user_skill.text granted, or granted but not declared: 403 before any read', async () => {
    await grant('echo', ['session:read', 'override:skill.text'])
    expect(await get()).toMatchObject({ status: 403, body: { code: 'permission_denied' } })
    await grant('echo', ALL_PERMS)
    await db.pluginInstall.update({ where: { pluginId: 'echo' }, data: { manifest: echoManifest({ permissions: ['session:read', 'override:skill.text'] }) } })
    expect(await get()).toMatchObject({ status: 403, body: { code: 'permission_denied' } })
  })
})

describe('override/propose', () => {
  test('the answer, the validator call and the stored row', async () => {
    const r = await propose(proposal({ meta: { summary: 'time-based' } }))
    expect(r).toEqual({ status: 200, body: { changeSetId: expect.stringMatching(/^[0-9a-f-]{36}$/), fromRevision: null, proposedRevisionLabel: null } })
    expect(h.agentCalls).toEqual([{ path: '/plugins/text/validate', body: { text: PROPOSED, baseText: BASE, maxChars: MAX_CONTENT_SIZE } }])
    const rows = db.rows('pluginOverride')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      changeSetId: r.body.changeSetId, pluginId: 'echo', extensionPoint: 'user_skill.text', scopeType: 'user', scopeId: ALICE,
      userId: ALICE, projectId: null, targetGroup: SKILL, targetKey: `${SKILL}/body`, value: PROPOSED, baseSha256: sha(BASE),
      status: 'proposed', revision: null, note: 'Time-based checks found what error-based ones missed.', createdBy: ALICE,
    })
    expect(rows[0].meta).toEqual({
      summary: 'time-based',
      baseText: BASE,
      sourceName: 'My SQLi flow v2',
      pluginVersion: '1.0.0',
      conversationId: ALICE_CONV,
      jobId: null,
    })
  })

  test('every platform meta key the plugin sends is dropped; the platform writes its own', async () => {
    const forged = Object.fromEntries(ov.PLATFORM_META_KEYS.map((k) => [k, 'forged']))
    const r = await propose(proposal({ meta: { ...forged, own: 'kept' } }))
    expect(r.status).toBe(200)
    const meta = (await ov.getChangeSet(r.body.changeSetId as string))!.meta as Record<string, unknown>
    expect(meta).toEqual({
      own: 'kept', baseText: BASE, sourceName: 'My SQLi flow v2', pluginVersion: '1.0.0', conversationId: ALICE_CONV, jobId: null,
    })
    for (const k of ['staleReason', 'fromRevision', 'baseFactoryText', 'basedOn', 'adoptedSkillId', 'adoptedName', 'withdrawReason']) {
      expect(meta, k).not.toHaveProperty(k)
    }
  })

  test("pluginVersion is the token's version (the version that proposed it)", async () => {
    await db.pluginInstall.update({ where: { pluginId: 'echo' }, data: { activeVersion: '1.2.0', manifest: echoManifest({ version: '1.2.0', permissions: ALL_PERMS }) } })
    const r = await propose(proposal(), { version: '1.2.0' })
    expect(r.status).toBe(200)
    expect((await ov.getChangeSet(r.body.changeSetId as string))!.meta).toMatchObject({ pluginVersion: '1.2.0' })
    expect(h.audits[0].after).toMatchObject({ pluginVersion: '1.2.0' })
  })

  test("a job's token: jobId is the token's job", async () => {
    const { job } = await startJob({
      pluginId: 'echo', userId: ALICE, actionId: 'sleep',
      context: { projectId: ALICE_PROJECT, sessionId: ALICE_SESSION, conversationId: ALICE_CONV },
      deadline: new Date(t + 3_600_000),
    })
    const r = await propose(proposal(), { kind: 'job', jid: job.jobId })
    expect(r.status).toBe(200)
    expect((await ov.getChangeSet(r.body.changeSetId as string))!.meta).toMatchObject({ jobId: job.jobId, conversationId: ALICE_CONV })
  })

  test('audited plugin.override.propose at user_skill.text; an admin acting is recorded with onBehalfOf', async () => {
    const r = await propose(proposal())
    expect(h.audits).toEqual([{
      actorId: ALICE,
      action: 'plugin.override.propose',
      targetType: 'plugin_change_set',
      targetId: r.body.changeSetId,
      before: undefined,
      after: { point: 'user_skill.text', targetGroup: SKILL, scope: 'user', scopeId: ALICE, parts: ['body'], pluginVersion: '1.0.0', pluginId: 'echo' },
      source: 'api',
    }])
    h.audits = []
    const r2 = await propose(proposal({ parts: { body: PROPOSED + '\nMore.' } }), { act: 'user-admin' })
    expect(h.audits[0]).toMatchObject({ actorId: 'user-admin', targetId: r2.body.changeSetId, after: { onBehalfOf: ALICE } })
  })

  test('quarantined, foreign, unknown or malformed target: the same 404, and nothing is stored or validated', async () => {
    for (const targetGroup of [QUARANTINED, BOB_SKILL, 'sknosuchskill', 'Bad-Id', 'skunused']) {
      expect(await propose(proposal({ targetGroup }))).toEqual(NOT_FOUND)
    }
    expect(db.rows('pluginOverride')).toEqual([])
    expect(h.agentCalls).toEqual([])
    expect(h.audits).toEqual([])
  })

  test('the skill deleted while the proposal was checked: the same 404, and nothing is stored', async () => {
    // The owner deletes the skill between the plugin's checks and the write (its delete takes
    // the scope lock the write waits on).
    textVerdict = () => {
      void db.userAttackSkill.delete({ where: { id: SKILL } })
      return Response.json({ ok: true, errors: [] })
    }
    expect(await propose(proposal())).toEqual(NOT_FOUND)
    expect(db.rows('pluginOverride')).toEqual([])
  })

  test('the skill edited while the proposal was checked: 409 factory_changed, nothing stored', async () => {
    textVerdict = () => {
      void db.userAttackSkill.update({ where: { id: SKILL }, data: { content: BASE + '\nEdited by its owner.' } })
      return Response.json({ ok: true, errors: [] })
    }
    expect(await propose(proposal())).toMatchObject({ status: 409, body: { code: 'factory_changed' } })
    expect(db.rows('pluginOverride')).toEqual([])
  })

  test('credential-shaped text: 422 skill_contains_credentials, nothing stored', async () => {
    const creds = 'Sign requests with AKIAIOSFODNN7EXAMPLE first.'
    const r = await propose(proposal({ targetGroup: 'skcreds', readSha256: { body: sha(creds) } }))
    expect(r).toMatchObject({ status: 422, body: { code: 'skill_contains_credentials' } })
    expect(db.rows('pluginOverride')).toEqual([])
  })

  test.each([
    ['unreachable (the request fails)', () => {
      throw new AgentUnreachableError('down')
    }, 'agent_unreachable'],
    ['without the endpoint (404)', () => Response.json({ detail: 'Not Found' }, { status: 404 }), 'agent_outdated'],
    ['failing (500)', () => Response.json({ detail: 'boom' }, { status: 500 }), 'agent_unreachable'],
    ['answering another shape', () => Response.json({ verdict: 'fine' }), 'agent_outdated'],
  ])('the agent validator %s: 503 %s, nothing stored (fail closed)', async (_n, verdict, code) => {
    textVerdict = verdict as () => Response
    const r = await propose(proposal())
    expect(r).toMatchObject({ status: 503, body: { code } })
    expect(db.rows('pluginOverride')).toEqual([])
    expect(h.audits).toEqual([])
  })

  test('the agent refuses: 422 invalid_proposal with its errors, nothing stored', async () => {
    textVerdict = () => Response.json({ ok: false, errors: ["value contains the heading of the 'SCOPE GUARDRAIL' prompt section", 'hidden character U+200B'] })
    const r = await propose(proposal())
    expect(r).toEqual({
      status: 422,
      body: {
        code: 'invalid_proposal',
        error: `${SKILL}/body: value contains the heading of the 'SCOPE GUARDRAIL' prompt section; ${SKILL}/body: hidden character U+200B`,
        errors: { parts: { body: ["value contains the heading of the 'SCOPE GUARDRAIL' prompt section", 'hidden character U+200B'] }, skill: [] },
      },
    })
    expect(db.rows('pluginOverride')).toEqual([])
  })

  test('a sixth proposal waiting on the same skill: 409 too_many_pending', async () => {
    for (let i = 0; i < ov.MAX_PENDING_CHANGE_SETS; i++) {
      expect((await propose(proposal({ parts: { body: `${PROPOSED}\nvariant ${i}` } }))).status).toBe(200)
    }
    const r = await propose(proposal({ parts: { body: `${PROPOSED}\nvariant 6` } }))
    expect(r).toMatchObject({ status: 409, body: { code: 'too_many_pending' } })
    expect(new Set(db.rows('pluginOverride').map((x) => x.changeSetId)).size).toBe(ov.MAX_PENDING_CHANGE_SETS)
  })

  test.each([
    ['no part', {}],
    ['a second part', { body: PROPOSED, extra: 'x' }],
    ['another part id', { workflow: PROPOSED }],
  ])('parts other than exactly {body} (%s): 422 invalid_proposal', async (_n, parts) => {
    const r = await propose(proposal({ parts }))
    expect(r).toMatchObject({ status: 422, body: { code: 'invalid_proposal' } })
    expect(db.rows('pluginOverride')).toEqual([])
  })

  test.each([
    ['parts not an object', { parts: ['x'] }],
    ['a body that is not text', { parts: { body: 5 } }],
    ['no note', { note: undefined }],
    ['meta not an object', { meta: ['x'] }],
  ])('%s: 400 invalid_proposal', async (_n, extra) => {
    expect(await propose(proposal(extra))).toMatchObject({ status: 400, body: { code: 'invalid_proposal' } })
  })

  test('a text equal to the source: 422, the agent never asked', async () => {
    const r = await propose(proposal({ parts: { body: BASE } }))
    expect(r).toMatchObject({ status: 422, body: { code: 'invalid_proposal' } })
    expect(h.agentCalls).toEqual([])
  })
})

describe('override/withdraw: the permission of the set\'s own point', () => {
  async function userSkillSet(pluginId = 'echo', owner = ALICE) {
    const { changeSetId } = await ov.propose({
      pluginId, point: 'user_skill.text', scope: { type: 'user', id: owner }, targetGroup: SKILL,
      parts: [{ targetKey: `${SKILL}/body`, value: PROPOSED, baseSha256: sha(BASE) }], createdBy: owner,
    })
    return changeSetId
  }
  async function builtinSet() {
    const { changeSetId } = await ov.propose({
      pluginId: 'echo', point: 'skill.text', scope: { type: 'user', id: ALICE }, targetGroup: 'path_traversal',
      parts: [{ targetKey: 'path_traversal/payload_reference', value: 'mine', baseSha256: sha(FACTORY) }], createdBy: ALICE,
    })
    return changeSetId
  }

  test('a user-skill set: withdrawn with override:user_skill.text, audited at its point', async () => {
    const cs = await userSkillSet()
    expect(await withdraw(cs)).toEqual({ status: 200, body: { withdrawn: true } })
    expect((await ov.getChangeSet(cs))!.status).toBe('withdrawn')
    expect(h.audits[0]).toMatchObject({
      action: 'plugin.override.withdraw', targetId: cs,
      after: { point: 'user_skill.text', targetGroup: SKILL, scope: 'user', scopeId: ALICE, pluginId: 'echo' },
    })
  })

  test('a user-skill set needs override:user_skill.text: 403 with only override:skill.text, and it stays proposed', async () => {
    const cs = await userSkillSet()
    await grant('echo', ['session:read', 'override:skill.text'])
    expect(await withdraw(cs)).toMatchObject({ status: 403, body: { code: 'permission_denied' } })
    expect((await ov.getChangeSet(cs))!.status).toBe('proposed')
  })

  test('a skill.text set needs override:skill.text: 403 with only override:user_skill.text', async () => {
    const cs = await builtinSet()
    await grant('echo', ['session:read', 'override:user_skill.text'])
    expect(await withdraw(cs)).toMatchObject({ status: 403, body: { code: 'permission_denied' } })
    await grant('echo', ['session:read', 'override:skill.text'])
    expect((await withdraw(cs)).status).toBe(200)
  })

  test("another plugin's set, another user's set, or an unknown id: 404 before any permission is looked at", async () => {
    const others = await userSkillSet('other')
    const bobs = await userSkillSet('echo', BOB)
    await grant('echo', [])
    for (const id of [others, bobs, '11111111-2222-3333-4444-555555555555', 'not-a-uuid', 42]) {
      expect((await withdraw(id)).body.code).toBe('not_found')
      expect((await withdraw(id)).status).toBe(404)
    }
    expect((await ov.getChangeSet(others))!.status).toBe('proposed')
  })
})

describe('skill.text proposals record the proposer too', () => {
  test("pluginVersion, conversationId and a job token's jobId", async () => {
    await db.pluginInstall.update({ where: { pluginId: 'echo' }, data: { activeVersion: '1.3.0', manifest: echoManifest({ version: '1.3.0', permissions: ALL_PERMS }) } })
    const { job } = await startJob({
      pluginId: 'echo', userId: ALICE, actionId: 'sleep',
      context: { projectId: ALICE_PROJECT, sessionId: ALICE_SESSION, conversationId: ALICE_CONV },
      deadline: new Date(t + 3_600_000),
    })
    const r = await propose(
      { point: 'skill.text', targetGroup: 'path_traversal', parts: { payload_reference: 'Also URL-encode.' }, note: 'n', scope: 'user', meta: { jobId: 'forged', pluginVersion: '0.0.1' } },
      { version: '1.3.0', kind: 'job', jid: job.jobId },
    )
    expect(r.status).toBe(200)
    expect((await ov.getChangeSet(r.body.changeSetId as string))!.meta).toMatchObject({
      pluginVersion: '1.3.0', conversationId: ALICE_CONV, jobId: job.jobId,
    })
  })

  test('outside a session: conversationId null', async () => {
    const r = await propose(
      { point: 'skill.text', targetGroup: 'path_traversal', parts: { payload_reference: 'Also URL-encode.' }, note: 'n', scope: 'user' },
      { prj: undefined, ses: undefined, conv: undefined },
    )
    expect(r.status).toBe(200)
    expect((await ov.getChangeSet(r.body.changeSetId as string))!.meta).toMatchObject({ pluginVersion: '1.0.0', conversationId: null, jobId: null })
  })
})
