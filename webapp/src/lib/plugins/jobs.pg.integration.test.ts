/**
 * Jobs and transcript paging on a real Postgres: what the in-memory double cannot prove.
 * The one-active-job rule rests on the table's unique index refusing a second lock row
 * under real concurrency (pooled connections), and every job status change on an
 * `updateMany` whose JSON path filter matches the stored status in jsonb. The transcript's
 * keyset cursor must hold for duplicate sequence numbers and equal timestamp(3) values.
 *
 * Needs a DISPOSABLE database with the webapp schema (`prisma db push`) and the constraints of
 * scripts/apply-plugin-constraints.mjs; it empties the plugin tables, chat rows, `users` and
 * `projects`. Run with PLUGINS_PG_TEST_URL=postgresql://... npx vitest run <this file>. Without
 * the variable it is skipped; it refuses a database that holds users and has no marker table.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { vi } from 'vitest'

const URL = process.env.PLUGINS_PG_TEST_URL
const h = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/prisma', async () => {
  const { PrismaClient } = await import('@prisma/client')
  const url = process.env.PLUGINS_PG_TEST_URL
  h.db = url ? new PrismaClient({ datasources: { db: { url } } }) : null
  return { default: h.db }
})

import type { PrismaClient } from '@prisma/client'
import { setNowForTests } from './clock'
import * as jobs from './jobs'
import { readTranscript } from './transcript'

const MARKER = 'plugins_pg_integration_test_marker'
const db = () => h.db as PrismaClient
const CTX = { projectId: 'p1', sessionId: 's1', conversationId: 'c1' }
const start = () =>
  jobs.startJob({ pluginId: 'echo', userId: 'alice', actionId: 'sleep', context: CTX, deadline: new Date(Date.now() + 3_600_000) })
const rows = (collection: string) => db().pluginData.findMany({ where: { collection } })

describe.skipIf(!URL)('jobs and transcript paging on a real Postgres (PLUGINS_PG_TEST_URL)', () => {
  beforeAll(async () => {
    const [{ users }] = await db().$queryRaw<{ users: number }[]>`SELECT count(*)::int AS users FROM users`
    const [{ marked }] = await db().$queryRaw<{ marked: boolean }[]>`SELECT to_regclass(${MARKER}) IS NOT NULL AS marked`
    if (users > 0 && !marked) throw new Error('Refusing to run: this database holds users and is not a disposable test database')
    await db().$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${MARKER} (created_at timestamptz DEFAULT now())`)
  })

  beforeEach(async () => {
    setNowForTests(null)
    await db().$executeRawUnsafe(
      'TRUNCATE plugin_data, plugin_overrides, plugin_installs, plugin_platform_state, chat_messages, conversations, projects, users CASCADE',
    )
    await db().user.create({ data: { id: 'alice', name: 'Alice', email: 'alice@example.invalid' } })
    await db().project.create({ data: { id: 'p1', userId: 'alice', name: 'p1' } })
    await db().conversation.create({ data: { id: 'c1', sessionId: 's1', userId: 'alice', projectId: 'p1' } })
    await db().pluginInstall.create({ data: { pluginId: 'echo', status: 'ready', enabled: true } })
  })

  afterAll(async () => {
    await db()?.$disconnect()
  })

  describe('one active job (the unique index under real concurrency)', () => {
    test('twelve first clicks at once: one job created, every click gets it, one job row and one lock row', async () => {
      const all = await Promise.all(Array.from({ length: 12 }, () => start()))
      expect(all.filter((r) => r.created)).toHaveLength(1)
      expect(new Set(all.map((r) => r.job.jobId)).size).toBe(1)
      expect(await rows(jobs.JOBS_COLLECTION)).toHaveLength(1)
      expect(await rows(jobs.JOB_LOCKS_COLLECTION)).toHaveLength(1)
    })

    test('the lock is released when the job ends, and the next click makes a new job', async () => {
      const { job } = await start()
      await jobs.markRunning(job, 'boot-1')
      expect((await jobs.completeJob('echo', 'alice', job.jobId, { status: 'succeeded', result: { n: 1 } })).changed).toBe(true)
      expect(await rows(jobs.JOB_LOCKS_COLLECTION)).toHaveLength(0)
      const next = await start()
      expect(next.created).toBe(true)
      expect(next.job.jobId).not.toBe(job.jobId)
    })

    test('a lock left by a job that ended is replaced', async () => {
      const { job } = await start()
      // A job that ended without releasing its lock (a crash between the two writes).
      const row = (await rows(jobs.JOBS_COLLECTION))[0]
      await db().pluginData.update({ where: { id: row.id }, data: { value: { ...(row.value as object), status: 'failed' } } })
      const next = await start()
      expect(next.created).toBe(true)
      expect(next.job.jobId).not.toBe(job.jobId)
      expect((await rows(jobs.JOB_LOCKS_COLLECTION)).map((l) => (l.value as { jobId: string }).jobId)).toEqual([next.job.jobId])
    })
  })

  describe('status changes are compare-and-swaps on jsonb', () => {
    test('a completion racing a cancel: exactly one wins, the job ends in the winner’s state', async () => {
      for (let i = 0; i < 10; i++) {
        await db().pluginData.deleteMany({})
        const { job } = await start()
        await jobs.markRunning(job, 'boot-1')
        const [done, cancelled] = await Promise.all([
          jobs.completeJob('echo', 'alice', job.jobId, { status: 'succeeded', result: { i } }),
          jobs.cancelJobRow(job),
        ])
        expect([done.changed, cancelled.changed].filter(Boolean)).toHaveLength(1)
        const final = await jobs.findUserJob('alice', job.jobId)
        expect(final!.status).toBe(done.changed ? 'succeeded' : 'cancelled')
        expect(await rows(jobs.JOB_LOCKS_COLLECTION)).toHaveLength(0)
      }
    })

    test('two completions at once: one result stands', async () => {
      const { job } = await start()
      await jobs.markRunning(job, 'boot-1')
      const out = await Promise.all([
        jobs.completeJob('echo', 'alice', job.jobId, { status: 'succeeded', result: { who: 'a' } }),
        jobs.completeJob('echo', 'alice', job.jobId, { status: 'failed', error: { code: 'x', message: 'y' } }),
      ])
      expect(out.filter((o) => o.changed)).toHaveLength(1)
      const final = await jobs.findUserJob('alice', job.jobId)
      expect(final!.status).toBe(out[0].changed ? 'succeeded' : 'failed')
    })

    test('a 202 processed after the job already ended does not bring it back to running', async () => {
      const { job } = await start()
      await jobs.completeJob('echo', 'alice', job.jobId, { status: 'failed', error: { code: 'crashed', message: 'm' } })
      expect((await jobs.markRunning(job, 'boot-1')).status).toBe('failed')
    })

    test('progress during the run is kept; after the end it is ignored', async () => {
      const { job } = await start()
      await jobs.markRunning(job, 'boot-1')
      expect((await jobs.reportProgress('echo', 'alice', job.jobId, { message: 'half', fields: { a: 'b' } })).changed).toBe(true)
      await jobs.completeJob('echo', 'alice', job.jobId, { status: 'succeeded', result: {} })
      expect((await jobs.reportProgress('echo', 'alice', job.jobId, { message: 'late', fields: {} })).changed).toBe(false)
      expect((await jobs.findUserJob('alice', job.jobId))!.progress).toEqual({ message: 'half', fields: { a: 'b' } })
    })

    test('past its deadline a job reads as failed timeout and frees its lock', async () => {
      const { job } = await jobs.startJob({ pluginId: 'echo', userId: 'alice', actionId: 'sleep', context: CTX, deadline: new Date(Date.now() + 1000) })
      setNowForTests(() => new Date(Date.now() + 5000))
      const read = await jobs.refreshJob(job)
      expect(read).toMatchObject({ status: 'failed', error: { code: 'timeout' } })
      expect(await rows(jobs.JOB_LOCKS_COLLECTION)).toHaveLength(0)
    })

    test('a 2 MB result is measured in bytes of JSON', async () => {
      const { job } = await start()
      await jobs.markRunning(job, 'boot-1')
      // 700,000 three-byte characters: under 2 MB of characters, over 2 MB of UTF-8.
      await jobs.completeJob('echo', 'alice', job.jobId, { status: 'succeeded', result: { text: '€'.repeat(700_000) } })
      expect((await jobs.findUserJob('alice', job.jobId))!.error).toMatchObject({ code: 'result_too_large' })
    })
  })

  describe('transcript paging', () => {
    test('duplicate sequence numbers and equal timestamp(3) values page once each, in order', async () => {
      const at = (ms: number) => new Date(Date.parse('2026-10-09T10:00:00.000Z') + ms)
      const spec: [string, number, number][] = [
        ['m-f', 3, 9],
        ['m-c', 1, 5],
        ['m-b', 1, 5],
        ['m-a', 0, 1],
        ['m-d', 1, 6],
        ['m-e', 2, 7],
        ['m-g', 2, 7],
      ]
      for (const [id, seq, ms] of spec) {
        await db().chatMessage.create({ data: { id, conversationId: 'c1', sequenceNum: seq, createdAt: at(ms), type: 'thinking', data: { id } } })
      }
      const conversation = { id: 'c1', title: '', status: 'active', currentPhase: 'informational', iterationCount: 0, createdAt: at(0), updatedAt: at(0) }
      for (const pageRows of [1, 2, 3, 500]) {
        const t = await readTranscript(conversation, { running: false, pageRows })
        expect(t.events.map((e) => (e.data as { id: string }).id), `pageRows=${pageRows}`).toEqual(['m-a', 'm-b', 'm-c', 'm-d', 'm-e', 'm-g', 'm-f'])
      }
    })
  })
})
