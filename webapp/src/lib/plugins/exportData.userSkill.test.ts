/**
 * The admin export keeps people's own skill text out (exportData.ts, format version 2): for a
 * `user_skill.text` row the value, the note, the plugin's meta and the platform's copies of
 * the source text and names become `{redacted, sha256, chars}`; which version proposed it,
 * from where, and what it became stay. Built-in (`skill.text`) rows are exported as stored.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'crypto'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown>, audit: [] as Record<string, unknown>[] }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async (e: Record<string, unknown>) => void h.audit.push(e)) }))

import { createFakePrisma, type FakePrisma, type Row } from './__testing__/fakePrisma'
import { setNowForTests } from './clock'
import { EXPORT_VERSION, buildExport, exportPluginData, redactUserSkillRow } from './exportData'

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const red = (s: string) => ({ redacted: true, sha256: sha(s), chars: s.length })
const NOW = new Date('2026-10-10T10:00:00Z')

const VALUE = 'PRIVATE-PROPOSED-TEXT: log in to intranet.example.com and enumerate.'
const NOTE = 'PRIVATE-NOTE: the session showed the login page.'
const BASE_TEXT = 'PRIVATE-BASE-TEXT: my own workflow.'
const SOURCE_NAME = 'PRIVATE-SOURCE-NAME'
const ADOPTED_NAME = 'PRIVATE-ADOPTED-NAME'
const PLUGIN_SUMMARY = 'PRIVATE-PLUGIN-SUMMARY'

let db: FakePrisma

const userSkillRow = (over: Row = {}): Row => ({
  pluginId: 'echo', extensionPoint: 'user_skill.text', scopeType: 'user', scopeId: 'user-alice', userId: 'user-alice',
  targetGroup: 'skflow', targetKey: 'skflow/body', changeSetId: 'cs-user', value: VALUE, baseSha256: 'b'.repeat(64),
  status: 'adopted', createdBy: 'user-alice', note: NOTE,
  meta: {
    summary: PLUGIN_SUMMARY,
    lessons: ['PRIVATE-LESSON'],
    baseText: BASE_TEXT,
    sourceName: SOURCE_NAME,
    adoptedName: ADOPTED_NAME,
    adoptedSkillId: 'sknew',
    pluginVersion: '1.1.0',
    conversationId: 'conv-1',
    jobId: 'job-1',
    withdrawReason: 'revoked',
  },
  ...over,
})

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  h.audit = []
  setNowForTests(() => NOW)
  db.seed('pluginInstall', [{ pluginId: 'echo', status: 'ready', enabled: true, activeVersion: '1.1.0', dataVersion: 1 }])
  db.seed('pluginOverride', [
    userSkillRow(),
    userSkillRow({ changeSetId: 'cs-bare', targetKey: 'skflow/body', status: 'proposed', note: null, meta: null }),
    {
      pluginId: 'echo', extensionPoint: 'skill.text', scopeType: 'user', scopeId: 'user-alice', userId: 'user-alice',
      targetGroup: 'sqli', targetKey: 'sqli/workflow', changeSetId: 'cs-builtin', revision: 2, value: 'Built-in text stays.',
      baseSha256: 'a'.repeat(64), status: 'active', createdBy: 'user-alice', note: 'Built-in note stays.',
      meta: { fromRevision: 1, baseFactoryText: { workflow: 'factory' }, pluginVersion: '1.1.0', summary: 's' },
    },
  ])
})
afterEach(() => {
  setNowForTests(null)
  vi.restoreAllMocks()
})

describe('the export format', () => {
  test('version 2', async () => {
    expect(EXPORT_VERSION).toBe(2)
    expect((await buildExport('echo')).exportVersion).toBe(2)
  })
})

describe('a user_skill.text row', () => {
  test('value, note, the plugin meta and the platform copies of text and names are redacted; the record of what happened stays', async () => {
    const doc = await buildExport('echo')
    const row = doc.overrides.find((r) => r.changeSetId === 'cs-user')!
    expect(row.value).toEqual(red(VALUE))
    expect(row.note).toEqual(red(NOTE))
    expect(row.meta).toEqual({
      summary: red(PLUGIN_SUMMARY),
      lessons: red(JSON.stringify(['PRIVATE-LESSON'])),
      baseText: red(BASE_TEXT),
      sourceName: red(SOURCE_NAME),
      adoptedName: red(ADOPTED_NAME),
      adoptedSkillId: 'sknew',
      pluginVersion: '1.1.0',
      conversationId: 'conv-1',
      jobId: 'job-1',
      withdrawReason: 'revoked',
    })
    // The rest of the row (ids, status, hashes, who) is the record and stays.
    expect(row).toMatchObject({ extensionPoint: 'user_skill.text', status: 'adopted', targetGroup: 'skflow', baseSha256: 'b'.repeat(64), createdBy: 'user-alice' })
  })

  test('no private text anywhere in the downloaded file', async () => {
    const { body } = await exportPluginData('echo', 'user-admin')
    for (const s of [VALUE, NOTE, BASE_TEXT, SOURCE_NAME, ADOPTED_NAME, PLUGIN_SUMMARY, 'PRIVATE-LESSON']) expect(body).not.toContain(s)
    expect(JSON.parse(body).overrides).toHaveLength(3)
  })

  test('a row without a note or meta: the note stays null, the meta null', async () => {
    const row = (await buildExport('echo')).overrides.find((r) => r.changeSetId === 'cs-bare')!
    expect(row.value).toEqual(red(VALUE))
    expect(row.note).toBeNull()
    expect(row.meta).toBeNull()
  })

  test("a job's recorded pick does not carry the skill's name out either (the name is redacted as sourceName above)", async () => {
    // jobs.ts stores the server-derived pick, with the user skill's name, in the job row.
    db.seed('pluginData', [{
      pluginId: 'echo', ownerType: 'user', ownerId: 'user-alice', userId: 'user-alice', collection: '__jobs', key: 'job-1', sizeBytes: 100,
      value: {
        status: 'succeeded', actionId: 'sleep', context: { projectId: 'p1', sessionId: 's1', conversationId: 'conv-1' },
        pick: { kind: 'session.skill', point: 'user_skill.text', target: 'skflow', ref: 'user_skill:skflow', name: SOURCE_NAME },
        progress: null, result: {}, error: null, deadline: NOW.toISOString(), bootId: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      },
    }])
    const { body } = await exportPluginData('echo', 'user-admin')
    expect(body).not.toContain(SOURCE_NAME)
  })

  test("a job on someone's own skill: what the plugin wrote is redacted; status, codes and the change set stay", async () => {
    db.seed('pluginData', [{
      pluginId: 'echo', ownerType: 'user', ownerId: 'user-alice', userId: 'user-alice', collection: '__jobs', key: 'job-2', sizeBytes: 100,
      value: {
        status: 'failed', actionId: 'sleep', context: { projectId: 'p1', sessionId: 's1', conversationId: 'conv-1' },
        pick: { kind: 'session.skill', point: 'user_skill.text', target: 'skflow', ref: 'user_skill:skflow', name: SOURCE_NAME },
        progress: { message: 'Reading the session', fields: { Skill: `${SOURCE_NAME} (your skill)` } },
        result: { status: 'proposed', message: `Proposed a new version of ${SOURCE_NAME}.`, reviewProposal: { extensionPoint: 'user_skill.text', changeSetId: 'cs-7' } },
        error: { code: 'too_many_pending', message: `Too many proposals for ${SOURCE_NAME}.` },
        deadline: NOW.toISOString(), bootId: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      },
    }])
    const { body } = await exportPluginData('echo', 'user-admin')
    expect(body).not.toContain(SOURCE_NAME)
    const job = (JSON.parse(body).data as { key: string; value: Record<string, Record<string, unknown>> }[]).find((d) => d.key === 'job-2')!.value
    expect(job.status).toBe('failed')
    expect(job.error.code).toBe('too_many_pending')
    expect(job.result.status).toBe('proposed')
    expect(job.result.reviewProposal).toEqual({ extensionPoint: 'user_skill.text', changeSetId: 'cs-7' })
    expect(job.pick).toMatchObject({ ref: 'user_skill:skflow', name: expect.objectContaining({ redacted: true }) })
  })

  test("a job on a built-in skill is exported as stored", async () => {
    db.seed('pluginData', [{
      pluginId: 'echo', ownerType: 'user', ownerId: 'user-alice', userId: 'user-alice', collection: '__jobs', key: 'job-3', sizeBytes: 100,
      value: {
        status: 'succeeded', actionId: 'sleep', context: {},
        pick: { kind: 'session.skill', point: 'skill.text', target: 'xss', ref: 'xss', name: 'XSS' },
        progress: { message: 'Reading the session', fields: { Skill: 'XSS (xss)' } }, result: { message: 'Done.' }, error: null,
        deadline: NOW.toISOString(), bootId: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      },
    }])
    const { body } = await exportPluginData('echo', 'user-admin')
    const job = (JSON.parse(body).data as { key: string; value: Record<string, unknown> }[]).find((d) => d.key === 'job-3')!.value
    expect(job.progress).toEqual({ message: 'Reading the session', fields: { Skill: 'XSS (xss)' } })
    expect(job.result).toEqual({ message: 'Done.' })
  })

  const pickless = (key: string, result: Record<string, unknown>) => ({
    pluginId: 'echo', ownerType: 'user', ownerId: 'user-alice', userId: 'user-alice', collection: '__jobs', key, sizeBytes: 100,
    value: {
      status: 'succeeded', actionId: 'sleep', context: { projectId: 'p1', sessionId: 's1', conversationId: 'conv-1' }, pick: null,
      progress: { message: 'Reading the session', fields: { Skill: `${SOURCE_NAME} (your skill)` } }, result, error: null,
      deadline: NOW.toISOString(), bootId: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    },
  })

  test('a job started without a pick by a plugin allowed to read own skills is redacted the same way', async () => {
    await db.pluginInstall.update({ where: { pluginId: 'echo' }, data: { grantedPermissions: ['session:read', 'override:user_skill.text'] } })
    db.seed('pluginData', [pickless('job-4', { message: `Proposed a new version of ${SOURCE_NAME}.` })])
    const { body } = await exportPluginData('echo', 'user-admin')
    expect(body).not.toContain(SOURCE_NAME)
  })

  test('without that permission, a pick-less job is redacted only when it reported a proposal for an own skill', async () => {
    db.seed('pluginData', [
      pickless('job-5', { message: `Proposed a new version of ${SOURCE_NAME}.`, reviewProposal: { extensionPoint: 'user_skill.text', changeSetId: 'cs-9' } }),
      pickless('job-6', { message: 'Done with XSS.' }),
    ])
    const doc = JSON.parse((await exportPluginData('echo', 'user-admin')).body) as { data: { key: string; value: Record<string, unknown> }[] }
    const job = (key: string) => doc.data.find((d) => d.key === key)!.value
    expect(JSON.stringify(job('job-5'))).not.toContain(SOURCE_NAME)
    expect(job('job-6').result).toEqual({ message: 'Done with XSS.' })
  })

  test('redactUserSkillRow does not touch the row it is given', () => {
    const row = userSkillRow() as never
    const copy = structuredClone(row)
    redactUserSkillRow(row)
    expect(row).toEqual(copy)
  })
})

describe('a skill.text row', () => {
  test('exported as stored', async () => {
    const row = (await buildExport('echo')).overrides.find((r) => r.changeSetId === 'cs-builtin')!
    expect(row).toMatchObject({
      value: 'Built-in text stays.',
      note: 'Built-in note stays.',
      meta: { fromRevision: 1, baseFactoryText: { workflow: 'factory' }, pluginVersion: '1.1.0', summary: 's' },
    })
  })
})
