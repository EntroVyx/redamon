/**
 * GET /api/users/[id]/attack-skills/name-check (plan 0.C.3): the form's early answer,
 * `{available, normalized, suggestion, reason?}`. The write re-checks under its lock.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  db: null as unknown as Record<string, unknown>,
  denied: null as unknown,
}))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/session', () => ({ requireUserAccess: async () => h.denied }))

import { createFakePrisma, type FakePrisma } from '@/lib/plugins/__testing__/fakePrisma'
import { GET } from './route'

let db: FakePrisma

async function check(query: Record<string, string>, id = 'alice') {
  const qs = new URLSearchParams(query).toString()
  const res = await GET(new NextRequest(`http://localhost:3000/api/users/${id}/attack-skills/name-check?${qs}`), {
    params: Promise.resolve({ id }),
  })
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  h.denied = null
  db.seed('userAttackSkill', [
    { id: 'src', userId: 'alice', name: 'My SQLi flow', content: 'x', lineageRootId: 'src', version: 1 },
    { id: 'v2', userId: 'alice', name: 'My SQLi flow v2', content: 'x', lineageRootId: 'src', version: 2 },
    { id: 'solo', userId: 'alice', name: 'Recon basics', content: 'x' },
    { id: 'bobs', userId: 'bob', name: 'Bob only', content: 'x' },
  ])
})

describe('name-check', () => {
  test('a free name is available, normalized, with no suggestion and no reason', async () => {
    const { status, body } = await check({ name: '  Brand \t new  ' })
    expect(status).toBe(200)
    expect(body).toEqual({ available: true, normalized: 'Brand new', suggestion: null })
  })

  test("another user's name is free", async () => {
    expect((await check({ name: 'Bob only' })).body.available).toBe(true)
  })

  test('a taken name (by case and spacing) is name_taken with the next version as suggestion', async () => {
    const { body } = await check({ name: 'recon   BASICS' })
    expect(body).toEqual({ available: false, normalized: 'recon BASICS', suggestion: 'recon BASICS v2', reason: 'name_taken' })
  })

  test('with sourceId the suggestion is the next version of that skill, even for a free name', async () => {
    const { body } = await check({ name: 'Something new', sourceId: 'src' })
    expect(body).toEqual({ available: true, normalized: 'Something new', suggestion: 'My SQLi flow v3' })
  })

  test("a sourceId of another user's skill is ignored", async () => {
    const { body } = await check({ name: 'Something new', sourceId: 'bobs' })
    expect(body.suggestion).toBeNull()
  })

  test('with exceptId a rename to its own name (another case) is available', async () => {
    const { body } = await check({ name: 'RECON basics', exceptId: 'solo' })
    expect(body).toEqual({ available: true, normalized: 'RECON basics', suggestion: null })
  })

  test('exceptId does not free the name of another skill', async () => {
    const { body } = await check({ name: 'Recon basics', exceptId: 'src' })
    expect(body).toMatchObject({ available: false, reason: 'name_taken' })
  })

  test.each([
    ['name_too_long', 'n'.repeat(101)],
    ['name_invalid', ''],
    ['name_invalid', '   '],
    ['name_invalid', 'My\u202Eflow'],
    ['name_invalid', 'My\u0000flow'],
  ])('%s for %j', async (reason, name) => {
    const { body } = await check({ name })
    expect(body).toMatchObject({ available: false, suggestion: null, reason })
  })

  test('no name parameter at all is name_invalid', async () => {
    expect((await check({})).body).toMatchObject({ available: false, normalized: '', reason: 'name_invalid' })
  })

  test('an invalid name with a sourceId still gets the version suggestion', async () => {
    const { body } = await check({ name: '', sourceId: 'solo' })
    expect(body).toEqual({ available: false, normalized: '', suggestion: 'Recon basics v2', reason: 'name_invalid' })
  })

  test('a caller refused by requireUserAccess gets its answer', async () => {
    h.denied = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    expect((await check({ name: 'x' }, 'bob')).status).toBe(403)
    expect(db.rawCalls).toEqual([])
  })
})
