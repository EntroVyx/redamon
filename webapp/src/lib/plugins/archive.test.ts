/**
 * The strict ustar reader (TD-12): only regular files and directories under ONE top
 * folder named after the plugin, nothing a tar extractor could be tricked with. Every
 * malicious shape the test writer can produce is refused with `unsafe_archive` and the
 * reason, before a byte reaches the disk.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { gzipSync } from 'zlib'
import { BLOCK, writeTarGz, writeUstar, ustarEntries, type UstarEntry } from './__testing__/ustarWriter'
import { ArchiveError, ARCHIVE_MAX_ENTRIES, readArchive } from './archive'

const GOOD = {
  'echo/plugin.json': '{"id":"echo"}',
  'echo/engine/__init__.py': '',
  'echo/engine/main.py': 'async def echo(ctx, params):\n    return params\n',
  'echo/ui/home.json': '{"type":"page","children":[]}',
}

function refused(fn: () => unknown): ArchiveError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ArchiveError)
    expect((e as ArchiveError).code).toBe('unsafe_archive')
    return e as ArchiveError
  }
  throw new Error('expected a refusal')
}

const read = (gz: Buffer, maxBytes = 5_000_000) => readArchive(gz, { pluginId: 'echo', maxBytes })

describe('a good archive', () => {
  test('lists the files relative to the top folder, with their bytes, and the directories', () => {
    const out = read(writeTarGz(GOOD))
    expect(out.files.map((f) => f.path).sort()).toEqual(['engine/__init__.py', 'engine/main.py', 'plugin.json', 'ui/home.json'])
    expect(out.files.find((f) => f.path === 'engine/main.py')!.bytes.toString()).toContain('async def echo')
    expect(out.dirs.sort()).toEqual(['engine', 'ui'])
    expect(out.totalBytes).toBe(Object.values(GOOD).reduce((n, s) => n + Buffer.byteLength(s), 0))
  })

  test('directory entries are optional, and a name split into prefix and name is joined', () => {
    const long = `echo/${'d'.repeat(90)}/${'f'.repeat(60)}.py`
    const out = read(writeTarGz({ 'echo/plugin.json': '{}', [long]: 'x' }, { dirs: [] }))
    expect(out.files.map((f) => f.path)).toContain(long.slice('echo/'.length))
  })

  test('the modes in the archive are kept for reference, never trusted', () => {
    const out = read(gzipSync(writeUstar([{ type: 'file', name: 'echo/plugin.json', content: '{}', mode: 0o4777 }])))
    expect(out.files[0].mode).toBe(0o4777)
  })
})

describe('refusals', () => {
  test.each<[string, Parameters<typeof writeTarGz>[1], RegExp]>([
    ['a symlink', { symlink: { name: 'echo/link', target: '/etc/passwd' } }, /symlink/],
    ['a hard link', { hardlink: { name: 'echo/hard', target: 'echo/plugin.json' } }, /hard link/],
    ['a character device', { device: { name: 'echo/dev', kind: 'char' } }, /device/],
    ['a block device', { device: { name: 'echo/blk', kind: 'block' } }, /device/],
    ['a fifo', { device: { name: 'echo/fifo', kind: 'fifo' } }, /fifo/],
    ['an absolute path', { absolutePath: '/etc/cron.d/x' }, /absolute/],
    ['a .. component', { dotDotPath: 'echo/../../x' }, /\.\./],
    ['a pax header', { paxHeader: { path: 'echo/other' } }, /pax/],
    ['a GNU long name', { gnuLongName: `echo/${'n'.repeat(120)}` }, /GNU/],
  ])('%s', (_name, opts, reason) => {
    const e = refused(() => read(writeTarGz(GOOD, opts)))
    expect(e.message).toMatch(reason)
  })

  test.each<[string, UstarEntry, RegExp]>([
    ['a backslash in a name', { type: 'raw', name: 'echo\\evil.py', typeflag: '0', content: Buffer.from('x') }, /backslash/],
    ['a NUL inside a name', { type: 'raw', name: 'echo/a\0b.py', typeflag: '0', content: Buffer.from('x') }, /NUL/],
    ['a control character', { type: 'raw', name: 'echo/a\nb.py', typeflag: '0', content: Buffer.from('x') }, /control/],
    ['a global pax header', { type: 'raw', name: 'pax_global_header', typeflag: 'g', content: Buffer.from('') }, /pax/],
    ['a GNU long link', { type: 'raw', name: '././@LongLink', typeflag: 'K', content: Buffer.from('x\0') }, /GNU/],
    ['a contiguous file', { type: 'raw', name: 'echo/c', typeflag: '7', content: Buffer.from('x') }, /type/],
    ['a "." component', { type: 'raw', name: 'echo/./x.py', typeflag: '0', content: Buffer.from('x') }, /component/],
    ['an empty component', { type: 'raw', name: 'echo//x.py', typeflag: '0', content: Buffer.from('x') }, /component/],
    ['a file with a link name', { type: 'raw', name: 'echo/f', typeflag: '0', linkname: 'other' }, /link/],
  ])('%s', (_name, entry, reason) => {
    const entries = [...ustarEntries(GOOD), entry]
    const e = refused(() => read(gzipSync(writeUstar(entries))))
    expect(e.message).toMatch(reason)
  })

  test('two top folders', () => {
    const e = refused(() => read(writeTarGz({ ...GOOD, 'other/x.py': 'x' })))
    expect(e.message).toMatch(/one top folder/)
  })

  test('a top folder not named after the plugin', () => {
    const e = refused(() => read(writeTarGz({ 'skiller/plugin.json': '{}' })))
    expect(e.message).toMatch(/echo/)
  })

  test('a file at the top level, outside the folder', () => {
    const e = refused(() => read(writeTarGz({ ...GOOD, 'README.md': 'x' })))
    expect(e.message).toMatch(/top folder/)
  })

  test(`more than ${ARCHIVE_MAX_ENTRIES} entries`, () => {
    const files: Record<string, string> = { 'echo/plugin.json': '{}' }
    for (let i = 0; i < ARCHIVE_MAX_ENTRIES; i++) files[`echo/f/${i}.txt`] = ''
    const e = refused(() => read(writeTarGz(files)))
    expect(e.message).toMatch(/entries/)
  })

  test('implied folders count too: a few deep files cannot make thousands of directories', () => {
    const files: Record<string, string> = { 'echo/plugin.json': '{}' }
    const deep = Array(110).fill('x').join('/')
    // 25 headers, no directory entries, ~2,800 folders that staging would create.
    for (let i = 0; i < 25; i++) files[`echo/a${i}/${deep}/f`] = ''
    const e = refused(() => read(writeTarGz(files, { dirs: [] })))
    expect(e.message).toMatch(/files and folders/)
  })

  test('exactly the limit of entries is accepted', () => {
    const files: Record<string, string> = { 'echo/plugin.json': '{}' }
    for (let i = 0; i < ARCHIVE_MAX_ENTRIES - 3; i++) files[`echo/f/${i}.txt`] = ''
    // + the echo/ and echo/f/ directory entries
    expect(read(writeTarGz(files)).files).toHaveLength(ARCHIVE_MAX_ENTRIES - 2)
  })

  test('a real file over the size cap', () => {
    const e = refused(() => read(writeTarGz({ ...GOOD, 'echo/big.bin': Buffer.alloc(200_000, 7) }), 100_000))
    expect(e.message).toMatch(/larger than/)
  })

  test('a gzip bomb stops at the cap instead of filling memory (maxOutputLength)', () => {
    // 64 MB of zeros compresses to ~64 KB.
    const bomb = writeTarGz(GOOD, { oversize: { name: 'echo/zeros', bytes: 64 * 1024 * 1024 } })
    expect(bomb.length).toBeLessThan(200_000)
    const e = refused(() => read(bomb, 1_000_000))
    expect(e.message).toMatch(/larger than/)
  })

  test('the same path twice (a later entry would overwrite the first)', () => {
    const entries = [...ustarEntries(GOOD), { type: 'file' as const, name: 'echo/plugin.json', content: '{"evil":1}' }]
    const e = refused(() => read(gzipSync(writeUstar(entries))))
    expect(e.message).toMatch(/twice/)
  })

  test('a path that is both a file and a directory', () => {
    const e = refused(() => read(writeTarGz({ 'echo/plugin.json': '{}', 'echo/x': 'file', 'echo/x/y': 'nested' })))
    expect(e.message).toMatch(/file and a directory/)
  })

  test('not gzip', () => {
    const e = refused(() => read(writeUstar(ustarEntries(GOOD))))
    expect(e.message).toMatch(/gzip/)
  })

  test('a header whose checksum does not match', () => {
    const tar = writeUstar(ustarEntries(GOOD))
    tar[10] ^= 0x01
    const e = refused(() => read(gzipSync(tar)))
    expect(e.message).toMatch(/checksum/)
  })

  test('a header that is not ustar (old GNU magic)', () => {
    const tar = writeUstar(ustarEntries(GOOD))
    tar.write('ustar  \0', 257, 'latin1')
    // Recompute the checksum so only the magic is wrong.
    tar.fill(0x20, 148, 156)
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += tar[i]
    tar.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
    const e = refused(() => read(gzipSync(tar)))
    expect(e.message).toMatch(/ustar/)
  })

  test('a truncated archive (data shorter than its header says)', () => {
    const tar = writeUstar(ustarEntries({ 'echo/plugin.json': 'x'.repeat(3000) }))
    const e = refused(() => read(gzipSync(tar.subarray(0, BLOCK * 3))))
    expect(e.message).toMatch(/truncated|end/)
  })

  test('bytes after the end-of-archive blocks', () => {
    const tar = Buffer.concat([writeUstar(ustarEntries(GOOD)), Buffer.from('trailing garbage'.padEnd(BLOCK, 'x'))])
    const e = refused(() => read(gzipSync(tar)))
    expect(e.message).toMatch(/after the end/)
  })

  test('an empty archive', () => {
    const e = refused(() => read(gzipSync(Buffer.alloc(BLOCK * 2))))
    expect(e.message).toMatch(/no file/)
  })

  test('a base-256 (GNU binary) size field', () => {
    const tar = writeUstar(ustarEntries({ 'echo/plugin.json': '{}' }, { dirs: [] }))
    tar[124] = 0x80
    tar.fill(0x20, 148, 156)
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += tar[i]
    tar.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
    const e = refused(() => read(gzipSync(tar)))
    expect(e.message).toMatch(/size/)
  })

  test('a name that is not UTF-8', () => {
    const entry: UstarEntry = { type: 'raw', name: 'echo/x.py', typeflag: '0', content: Buffer.from('x') }
    const tar = writeUstar([...ustarEntries(GOOD), entry])
    // The raw entry's header is the one after the GOOD entries; patch one name byte to 0xff.
    const at = tar.indexOf(Buffer.from('echo/x.py'))
    tar[at + 6] = 0xff
    tar.fill(0x20, at + 148, at + 156)
    let sum = 0
    for (let i = at; i < at + BLOCK; i++) sum += tar[i]
    tar.write(sum.toString(8).padStart(6, '0') + '\0 ', at + 148, 'latin1')
    const e = refused(() => read(gzipSync(tar)))
    expect(e.message).toMatch(/UTF-8/)
  })
})
