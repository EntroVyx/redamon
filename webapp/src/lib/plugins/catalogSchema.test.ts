/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { parseCatalog } from './schemas/catalog'
import valid from './__fixtures__/catalogs/two-plugins.valid.json'

const FIXTURES = path.join(__dirname, '__fixtures__/catalogs')
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

// A fixture document the test mutates freely; the schema under test is what types it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>

function refusal(mutate: (c: Doc) => void): string {
  const c = clone(valid) as Doc
  mutate(c)
  const r = parseCatalog(c)
  if (r.ok) throw new Error('expected the catalog to be refused')
  return r.errors.join('\n')
}

describe('fixtures', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))
  test.each(files.filter((f) => f.endsWith('.valid.json')))('%s is accepted', (f) => {
    const r = parseCatalog(JSON.parse(readFileSync(path.join(FIXTURES, f), 'utf8')))
    expect(r.ok ? [] : r.errors).toEqual([])
  })
  test.each(files.filter((f) => f.endsWith('.invalid.json')))('%s is refused', (f) => {
    expect(parseCatalog(JSON.parse(readFileSync(path.join(FIXTURES, f), 'utf8'))).ok).toBe(false)
  })
})

describe('shape checks', () => {
  test('a bad sha256', () => {
    expect(refusal((c) => (c.plugins[0].releases[0].sha256 = 'abc'))).toMatch(
      /plugins\.0\.releases\.0\.sha256: must be 64 lower-case hex characters/,
    )
    expect(refusal((c) => (c.plugins[0].releases[0].sha256 = 'A'.repeat(64)))).toMatch(/sha256/)
  })

  test('an http URL passes the schema (https and the host allowlist are the client\'s checks)', () => {
    const r = parseCatalog(clone(valid))
    expect(r.ok && r.value.plugins[1].releases[0].url).toBe('http://example.org/echo-0.3.1.tar.gz')
  })

  test('a non-http URL is refused', () => {
    expect(refusal((c) => (c.plugins[0].releases[0].url = 'file:///etc/passwd'))).toMatch(/url: must be an http\(s\) URL/)
    expect(refusal((c) => (c.plugins[0].releases[0].url = 'not a url'))).toMatch(/url/)
  })

  test('a catalog has no expiry: none is needed', () => {
    const r = parseCatalog(clone(valid))
    expect(r.ok ? [] : r.errors).toEqual([])
    expect(r.ok && 'expires' in r.value).toBe(false)
  })

  test('an expires left by an older catalog is ignored, whatever its value', () => {
    for (const expires of ['2026-10-01T00:00:00Z', '2026-12-31', 7, null]) {
      const c = clone(valid) as Doc
      c.expires = expires
      const r = parseCatalog(c)
      expect(r.ok ? [] : r.errors).toEqual([])
      expect(r.ok && 'expires' in r.value).toBe(false)
    }
  })

  test('another catalogVersion', () => {
    expect(refusal((c) => (c.catalogVersion = 2))).toMatch(/catalogVersion/)
  })

  test('a dataVersion past the int4 column', () => {
    expect(refusal((c) => (c.plugins[0].releases[0].dataVersion = 2_147_483_648))).toMatch(/dataVersion: Too big/)
  })

  test('a serial below 1', () => {
    expect(refusal((c) => (c.serial = 0))).toMatch(/serial/)
  })

  test('an invalid release platform range', () => {
    expect(refusal((c) => (c.plugins[0].releases[0].platform = '>=1.0'))).toMatch(/platform: must be a version range/)
  })

  test('a plugin listed twice, a release version listed twice', () => {
    expect(refusal((c) => c.plugins.push(clone(c.plugins[0])))).toMatch(/plugins: lists a plugin twice/)
    expect(refusal((c) => c.plugins[0].releases.push(clone(c.plugins[0].releases[0])))).toMatch(
      /releases: lists a release version twice/,
    )
  })
})

describe('the listing', () => {
  const icon = { url: 'https://raw.githubusercontent.com/o/r/master/echo/icon.jpg', sha256: 'a'.repeat(64), size: 4096, type: 'image/jpeg' }
  const listed = (c: Doc) => {
    c.plugins[0].icon = clone(icon)
    c.plugins[0].docsUrl = 'https://github.com/o/r/wiki/Plugin-Echo'
  }

  test('an icon and a docs URL are kept', () => {
    const c = clone(valid) as Doc
    listed(c)
    const r = parseCatalog(c)
    expect(r.ok ? [] : r.errors).toEqual([])
    expect(r.ok && r.value.plugins[0].icon).toEqual(icon)
    expect(r.ok && r.value.plugins[0].docsUrl).toBe('https://github.com/o/r/wiki/Plugin-Echo')
  })

  test('both are optional', () => {
    const r = parseCatalog(clone(valid))
    expect(r.ok && r.value.plugins[0].icon).toBeUndefined()
    expect(r.ok && r.value.plugins[0].docsUrl).toBeUndefined()
  })

  test('a docs URL is https only: it becomes a link on the card', () => {
    for (const docsUrl of ['http://github.com/o/r/wiki', 'javascript:alert(1)']) {
      expect(refusal((c) => (listed(c), (c.plugins[0].docsUrl = docsUrl)))).toMatch(/docsUrl: must be an https URL/)
    }
  })

  test('an icon of another type, too large, over http or without its hash is refused', () => {
    expect(refusal((c) => (listed(c), (c.plugins[0].icon.type = 'image/svg+xml')))).toMatch(/icon\.type/)
    expect(refusal((c) => (listed(c), (c.plugins[0].icon.size = 262_145)))).toMatch(/icon\.size/)
    expect(refusal((c) => (listed(c), (c.plugins[0].icon.url = 'http://example.org/i.jpg')))).toMatch(/icon\.url: must be an https URL/)
    expect(refusal((c) => (listed(c), delete c.plugins[0].icon.sha256))).toMatch(/icon\.sha256/)
  })
})

describe('forward compatibility', () => {
  test('a field a later CI adds is ignored, not refused', () => {
    const r = parseCatalog(clone(valid))
    expect(r.ok).toBe(true)
    expect(r.ok && 'generatedBy' in r.value).toBe(false)
  })

  test('a permission this platform does not know is kept for the install check', () => {
    const r = parseCatalog(clone(valid))
    expect(r.ok && r.value.plugins[0].releases[1].permissions).toContain('future:capability')
  })

  test('revoked may be omitted', () => {
    const c = clone(valid) as Record<string, unknown>
    delete c.revoked
    const r = parseCatalog(c)
    expect(r.ok && r.value.revoked).toEqual([])
  })
})
