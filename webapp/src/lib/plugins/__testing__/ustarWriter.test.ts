/**
 * The ustar writer must produce exactly the headers it claims, or the archive
 * reader's refusal tests (phase 05) would pass for the wrong reason.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { gunzipSync } from 'zlib'
import { BLOCK, paxRecord, writeTarGz, writeUstar } from './ustarWriter'

interface Hdr {
  name: string
  prefix: string
  fullName: string
  mode: number
  size: number
  typeflag: string
  linkname: string
  magic: string
  devmajor: number
  devminor: number
  checksumOk: boolean
  content: Buffer
}

const str = (b: Buffer, off: number, len: number) => b.subarray(off, off + len).toString('utf8').replace(/\0.*$/s, '')
const oct = (b: Buffer, off: number, len: number) => parseInt(str(b, off, len).trim() || '0', 8)

/** A minimal reader for these tests only: it trusts the writer and checks the checksum. */
function readHeaders(tar: Buffer): { headers: Hdr[]; endBlocks: number } {
  const headers: Hdr[] = []
  let off = 0
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK)
    if (h.every(x => x === 0)) break
    const stored = oct(h, 148, 8)
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]
    const size = oct(h, 124, 12)
    const name = str(h, 0, 100)
    const prefix = str(h, 345, 155)
    headers.push({
      name,
      prefix,
      fullName: prefix ? `${prefix}/${name}` : name,
      mode: oct(h, 100, 8),
      size,
      typeflag: String.fromCharCode(h[156]),
      linkname: str(h, 157, 100),
      magic: h.subarray(257, 263).toString('latin1'),
      devmajor: oct(h, 329, 8),
      devminor: oct(h, 337, 8),
      checksumOk: stored === sum,
      content: Buffer.from(tar.subarray(off + BLOCK, off + BLOCK + size)),
    })
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK
  }
  let endBlocks = 0
  while (off + BLOCK <= tar.length && tar.subarray(off, off + BLOCK).every(x => x === 0)) {
    endBlocks++
    off += BLOCK
  }
  return { headers, endBlocks }
}

const list = (gz: Buffer) => readHeaders(gunzipSync(gz))

describe('writeTarGz: a good archive', () => {
  const gz = writeTarGz({ 'demo/plugin.json': '{"id":"demo"}', 'demo/engine/main.py': 'async def run(ctx, params):\n    return {}\n' })
  const { headers, endBlocks } = list(gz)

  test('is gzip, ustar, with valid checksums and two zero end blocks', () => {
    expect(gz[0]).toBe(0x1f)
    expect(gz[1]).toBe(0x8b)
    expect(headers.every(h => h.magic === 'ustar\0')).toBe(true)
    expect(headers.every(h => h.checksumOk)).toBe(true)
    expect(endBlocks).toBe(2)
  })

  test('lists parent directories (0755) before files (0644), in order', () => {
    expect(headers.map(h => [h.typeflag, h.fullName])).toEqual([
      ['5', 'demo/'],
      ['5', 'demo/engine/'],
      ['0', 'demo/plugin.json'],
      ['0', 'demo/engine/main.py'],
    ])
    expect(headers.filter(h => h.typeflag === '5').every(h => h.mode === 0o755)).toBe(true)
    expect(headers.filter(h => h.typeflag === '0').every(h => h.mode === 0o644)).toBe(true)
  })

  test('carries file contents byte for byte', () => {
    expect(headers[2].content.toString()).toBe('{"id":"demo"}')
    expect(headers[3].size).toBe(Buffer.byteLength('async def run(ctx, params):\n    return {}\n'))
  })

  test('is deterministic', () => {
    expect(writeTarGz({ 'a/b': 'x' }).equals(writeTarGz({ 'a/b': 'x' }))).toBe(true)
  })

  test('splits a long path into ustar prefix and name', () => {
    const long = `demo/${'d'.repeat(60)}/${'e'.repeat(60)}/file.txt`
    const h = list(writeTarGz({ [long]: 'x' }, { dirs: [] })).headers[0]
    expect(h.prefix.length).toBeGreaterThan(0)
    expect(h.fullName).toBe(long)
  })
})

describe('writeTarGz: each malicious option adds exactly the header it names', () => {
  const base = { 'demo/plugin.json': '{}' }
  const extra = (opts: Parameters<typeof writeTarGz>[1]) => list(writeTarGz(base, opts)).headers.slice(2)

  test('symlink: typeflag 2 with its target', () => {
    expect(extra({ symlink: { name: 'demo/link', target: '/etc/passwd' } })).toMatchObject([
      { typeflag: '2', fullName: 'demo/link', linkname: '/etc/passwd', size: 0 },
    ])
  })

  test('hard link: typeflag 1 with its target', () => {
    expect(extra({ hardlink: { name: 'demo/hl', target: 'demo/plugin.json' } })).toMatchObject([
      { typeflag: '1', fullName: 'demo/hl', linkname: 'demo/plugin.json' },
    ])
  })

  test('absolute path: a regular file named from /', () => {
    expect(extra({ absolutePath: '/etc/cron.d/x' })).toMatchObject([{ typeflag: '0', fullName: '/etc/cron.d/x' }])
  })

  test('dot-dot path: a regular file that climbs out', () => {
    expect(extra({ dotDotPath: 'demo/../../x' })).toMatchObject([{ typeflag: '0', fullName: 'demo/../../x' }])
  })

  test('pax header: typeflag x first, with well-formed length-prefixed records', () => {
    const { headers } = list(writeTarGz(base, { paxHeader: { path: 'demo/other', linkpath: '/etc' } }))
    expect(headers[0].typeflag).toBe('x')
    const body = headers[0].content.toString()
    expect(body).toBe(paxRecord('path', 'demo/other') + paxRecord('linkpath', '/etc'))
    for (const rec of body.split('\n').filter(Boolean)) {
      const len = parseInt(rec.split(' ')[0], 10)
      expect(Buffer.byteLength(rec + '\n')).toBe(len)
    }
  })

  test('GNU long name: an L header carrying the name, then the file it names', () => {
    const longName = `demo/${'n'.repeat(150)}`
    const hs = extra({ gnuLongName: longName })
    expect(hs[0]).toMatchObject({ typeflag: 'L', fullName: '././@LongLink' })
    expect(hs[0].content.toString()).toBe(longName + '\0')
    expect(hs[1].typeflag).toBe('0')
  })

  test.each([
    ['char', '3'],
    ['block', '4'],
    ['fifo', '6'],
  ] as const)('device %s: typeflag %s', (kind, flag) => {
    expect(extra({ device: { name: 'demo/dev', kind } })).toMatchObject([{ typeflag: flag, fullName: 'demo/dev' }])
  })

  test('oversize file: the declared size is real, and zeros compress to a small archive', () => {
    const bytes = 21 * 1024 * 1024
    const gz = writeTarGz(base, { oversize: { name: 'demo/big.bin', bytes } })
    expect(gz.length).toBeLessThan(200 * 1024)
    const hs = list(gz).headers.slice(2)
    expect(hs).toMatchObject([{ typeflag: '0', fullName: 'demo/big.bin', size: bytes }])
  })

  test('raw entries keep names exactly as given (backslash, NUL)', () => {
    const tar = writeUstar([
      { type: 'raw', name: 'demo\\evil', typeflag: '0', content: Buffer.from('x') },
      { type: 'raw', name: 'demo/a\0b', typeflag: '0' },
    ])
    const { headers } = readHeaders(tar)
    expect(headers[0].name).toBe('demo\\evil')
    expect(tar.subarray(BLOCK * 2, BLOCK * 2 + 8).toString('latin1')).toBe('demo/a\0b')
  })

  test('two top folders and many entries are just file maps', () => {
    const files: Record<string, string> = { 'a/x': '1', 'b/y': '2' }
    for (let i = 0; i < 2001; i++) files[`demo/f${i}`] = ''
    const { headers } = list(writeTarGz(files))
    expect(headers.filter(h => h.typeflag === '5').map(h => h.fullName)).toEqual(['a/', 'b/', 'demo/'])
    expect(headers.filter(h => h.typeflag === '0')).toHaveLength(2003)
  })
})
