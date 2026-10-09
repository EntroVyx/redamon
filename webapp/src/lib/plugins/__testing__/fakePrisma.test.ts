import { describe, test, expect, afterEach } from 'vitest'
import { Prisma } from '@prisma/client'
import { createFakePrisma } from './fakePrisma'
import { setNowForTests } from '../clock'

afterEach(() => setNowForTests(null))

describe('fakePrisma', () => {
  test('a where key set to undefined is ignored, as Prisma does', async () => {
    const db = createFakePrisma()
    db.seed('pluginInstall', [{ pluginId: 'a', operationId: 'op1' }, { pluginId: 'b' }])
    const r = await db.pluginInstall.updateMany({ where: { operationId: undefined }, data: { enabled: true } })
    expect(r.count).toBe(2)
  })

  test('startsWith is an unescaped LIKE pattern, as Prisma 6 sends it to Postgres', async () => {
    const db = createFakePrisma()
    db.seed('pluginInstall', [{ pluginId: 'ab' }, { pluginId: '__' }, { pluginId: 'a%b' }])
    const ids = async (where: Record<string, unknown>) =>
      (await db.pluginInstall.findMany({ where, orderBy: { pluginId: 'asc' } })).map((r) => r.pluginId)
    expect(await ids({ pluginId: { startsWith: '__' } })).toEqual(['__', 'a%b', 'ab'])
    expect(await ids({ pluginId: { startsWith: '\\_\\_' } })).toEqual(['__'])
    expect(await ids({ pluginId: { contains: '\\%' } })).toEqual(['a%b'])
  })

  test('updateMany counts the rows it changed', async () => {
    const db = createFakePrisma()
    db.seed('pluginInstall', [{ pluginId: 'a', status: 'ready' }, { pluginId: 'b' }])
    const r = await db.pluginInstall.updateMany({ where: { status: { in: ['ready'] } }, data: { status: 'failed' } })
    expect(r.count).toBe(1)
    expect(db.rows('pluginInstall').map((x) => x.status).sort()).toEqual(['available', 'failed'])
  })

  test('a duplicate key raises the real P2002', async () => {
    const db = createFakePrisma()
    db.seed('pluginInstall', [{ pluginId: 'a' }])
    const err = await db.pluginInstall.create({ data: { pluginId: 'a' } }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002')
  })

  test('the composite unique key of plugin data is enforced and addressable', async () => {
    const db = createFakePrisma()
    const key = { pluginId: 'p', namespace: 'live', ownerType: 'user', ownerId: 'u', collection: 'c', key: 'k' }
    await db.pluginData.create({ data: { ...key, userId: 'u', value: 1, sizeBytes: 1 } })
    await expect(db.pluginData.create({ data: { ...key, userId: 'u', value: 2, sizeBytes: 1 } })).rejects.toMatchObject({ code: 'P2002' })
    const row = await db.pluginData.findUnique({ where: { pluginId_namespace_ownerType_ownerId_collection_key: key } })
    expect(row?.value).toBe(1)
  })

  test('Prisma.DbNull and JsonNull are stored as null', async () => {
    const db = createFakePrisma()
    await db.pluginInstall.create({ data: { pluginId: 'a', operationArgs: { mode: 'purge' } } })
    await db.pluginInstall.update({ where: { pluginId: 'a' }, data: { operationArgs: Prisma.DbNull } })
    expect(db.rows('pluginInstall')[0].operationArgs).toBeNull()
  })

  test('a failed transaction rolls back only its own writes', async () => {
    const db = createFakePrisma()
    db.seed('pluginInstall', [{ pluginId: 'a' }])
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const failing = db.$transaction(async (tx) => {
      await tx.pluginInstall.update({ where: { pluginId: 'a' }, data: { enabled: true } })
      await gate
      throw new Error('boom')
    })
    await db.pluginInstall.create({ data: { pluginId: 'b' } })
    release()
    await expect(failing).rejects.toThrow('boom')
    expect(db.rows('pluginInstall').map((r) => [r.pluginId, r.enabled])).toEqual([
      ['a', false],
      ['b', false],
    ])
  })

  test('pg_advisory_xact_lock serializes two transactions until the first ends', async () => {
    const db = createFakePrisma()
    const order: string[] = []
    const run = (name: string) =>
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'k'}))`
        order.push(`${name}:in`)
        await new Promise((r) => setTimeout(r, 5))
        order.push(`${name}:out`)
      })
    await Promise.all([run('a'), run('b')])
    expect(order).toEqual(['a:in', 'a:out', 'b:in', 'b:out'])
  })

  test('different lock keys do not serialize', async () => {
    const db = createFakePrisma()
    const order: string[] = []
    const run = (name: string) =>
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${name}))`
        order.push(`${name}:in`)
        await new Promise((r) => setTimeout(r, 5))
        order.push(`${name}:out`)
      })
    await Promise.all([run('a'), run('b')])
    expect(order.slice(0, 2).sort()).toEqual(['a:in', 'b:in'])
  })

  test('createdAt and updatedAt follow the platform clock', async () => {
    const db = createFakePrisma()
    setNowForTests(() => new Date('2026-01-01T00:00:00Z'))
    await db.pluginInstall.create({ data: { pluginId: 'a' } })
    setNowForTests(() => new Date('2026-01-02T00:00:00Z'))
    await db.pluginInstall.update({ where: { pluginId: 'a' }, data: { enabled: true } })
    const [row] = db.rows('pluginInstall')
    expect((row.createdAt as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect((row.updatedAt as Date).toISOString()).toBe('2026-01-02T00:00:00.000Z')
  })

  test('unsupported raw SQL fails loudly', async () => {
    const db = createFakePrisma()
    await expect(db.$executeRaw`DELETE FROM plugin_data`).rejects.toThrow(/not supported/)
  })
})
