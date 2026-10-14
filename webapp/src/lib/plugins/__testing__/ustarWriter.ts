/**
 * Writes gzip'd ustar archives for tests, including the malicious shapes the
 * strict reader (TD-12) must refuse: links, devices, absolute and `..` paths,
 * pax and GNU long-name headers, oversize files. Output is deterministic
 * (fixed mtime, uid/gid 0), so a test can pin its bytes.
 *
 * Header layout (POSIX ustar, 512 bytes): name 0/100, mode 100/8, uid 108/8,
 * gid 116/8, size 124/12, mtime 136/12, chksum 148/8, typeflag 156/1,
 * linkname 157/100, magic 257/6, version 263/2, uname 265/32, gname 297/32,
 * devmajor 329/8, devminor 337/8, prefix 345/155.
 */
import { gzipSync } from 'zlib'

export const BLOCK = 512
const MTIME = 1_767_225_600 // 2026-01-01T00:00:00Z

export type UstarEntry =
  | { type: 'file'; name: string; content: string | Uint8Array; mode?: number }
  | { type: 'dir'; name: string; mode?: number }
  | { type: 'symlink'; name: string; target: string }
  | { type: 'hardlink'; name: string; target: string }
  | { type: 'char' | 'block' | 'fifo'; name: string; devmajor?: number; devminor?: number }
  | { type: 'pax'; name: string; records: Record<string, string> }
  | { type: 'gnu-longname'; longName: string }
  /** A header whose fields are written exactly as given (backslash or NUL in a name, a bad typeflag). */
  | { type: 'raw'; name: string; typeflag: string; content?: Uint8Array; linkname?: string }

export type FileMap = Record<string, string | Uint8Array>

export interface UstarOptions {
  /** Directory entries; by default every parent folder of every file gets one, in order. */
  dirs?: string[]
  symlink?: { name: string; target: string }
  hardlink?: { name: string; target: string }
  /** A regular file whose name is absolute, e.g. '/etc/cron.d/x'. */
  absolutePath?: string
  /** A regular file whose name climbs out, e.g. 'demo/../../x'. */
  dotDotPath?: string
  /** A pax extended header (typeflag 'x') placed before the files. */
  paxHeader?: Record<string, string>
  /** A GNU long-name header (typeflag 'L') followed by a file carrying that name. */
  gnuLongName?: string
  device?: { name: string; kind: 'char' | 'block' | 'fifo' }
  /** One extra regular file of this many zero bytes (compresses to almost nothing: also a gzip bomb). */
  oversize?: { name: string; bytes: number }
  /** Appended as given, after everything else. */
  extra?: UstarEntry[]
}

const TYPEFLAG: Record<string, string> = {
  file: '0', hardlink: '1', symlink: '2', char: '3', block: '4', dir: '5', fifo: '6', pax: 'x', 'gnu-longname': 'L',
}

function octal(n: number, width: number): string {
  // width includes the trailing NUL
  return n.toString(8).padStart(width - 1, '0') + '\0'
}

function putString(buf: Buffer, offset: number, width: number, s: string | Uint8Array): void {
  const b = typeof s === 'string' ? Buffer.from(s, 'utf8') : Buffer.from(s)
  if (b.length > width) throw new Error(`field too long (${b.length} > ${width}): ${b.toString('utf8')}`)
  b.copy(buf, offset)
}

/** Splits a long name into ustar prefix/name at a '/', as tar does. */
function splitName(name: string): { name: string; prefix: string } {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' }
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== '/') continue
    const prefix = name.slice(0, i)
    const rest = name.slice(i + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { name: rest, prefix }
  }
  throw new Error(`name cannot be split into ustar prefix/name: ${name}`)
}

interface HeaderFields {
  name: string
  mode: number
  size: number
  typeflag: string
  linkname?: string
  devmajor?: number
  devminor?: number
  rawName?: boolean
}

function header(f: HeaderFields): Buffer {
  const h = Buffer.alloc(BLOCK, 0)
  const { name, prefix } = f.rawName ? { name: f.name, prefix: '' } : splitName(f.name)
  putString(h, 0, 100, name)
  putString(h, 100, 8, octal(f.mode, 8))
  putString(h, 108, 8, octal(0, 8))
  putString(h, 116, 8, octal(0, 8))
  putString(h, 124, 12, octal(f.size, 12))
  putString(h, 136, 12, octal(MTIME, 12))
  h.fill(0x20, 148, 156) // checksum is computed with its own field as spaces
  putString(h, 156, 1, f.typeflag)
  putString(h, 157, 100, f.linkname ?? '')
  putString(h, 257, 6, 'ustar\0')
  putString(h, 263, 2, '00')
  putString(h, 265, 32, 'root')
  putString(h, 297, 32, 'root')
  putString(h, 329, 8, octal(f.devmajor ?? 0, 8))
  putString(h, 337, 8, octal(f.devminor ?? 0, 8))
  putString(h, 345, 155, prefix)
  let sum = 0
  for (const byte of h) sum += byte
  putString(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ')
  return h
}

function padded(content: Uint8Array): Buffer[] {
  const rem = content.length % BLOCK
  return rem === 0 ? [Buffer.from(content)] : [Buffer.from(content), Buffer.alloc(BLOCK - rem, 0)]
}

/** A pax record is "<len> <key>=<value>\n" where <len> counts the whole record, itself included. */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let len = Buffer.byteLength(body) + 1
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body)
  return `${len}${body}`
}

function encodeEntry(e: UstarEntry): Buffer[] {
  switch (e.type) {
    case 'file': {
      const content = typeof e.content === 'string' ? Buffer.from(e.content, 'utf8') : Buffer.from(e.content)
      return [header({ name: e.name, mode: e.mode ?? 0o644, size: content.length, typeflag: '0' }), ...padded(content)]
    }
    case 'dir':
      return [header({ name: e.name.endsWith('/') ? e.name : `${e.name}/`, mode: e.mode ?? 0o755, size: 0, typeflag: '5' })]
    case 'symlink':
    case 'hardlink':
      return [header({ name: e.name, mode: 0o777, size: 0, typeflag: TYPEFLAG[e.type], linkname: e.target })]
    case 'char':
    case 'block':
    case 'fifo':
      return [header({ name: e.name, mode: 0o644, size: 0, typeflag: TYPEFLAG[e.type], devmajor: e.devmajor ?? 1, devminor: e.devminor ?? 3 })]
    case 'pax': {
      const body = Buffer.from(Object.entries(e.records).map(([k, v]) => paxRecord(k, v)).join(''), 'utf8')
      return [header({ name: e.name, mode: 0o644, size: body.length, typeflag: 'x' }), ...padded(body)]
    }
    case 'gnu-longname': {
      const body = Buffer.from(e.longName + '\0', 'utf8')
      return [header({ name: '././@LongLink', mode: 0o644, size: body.length, typeflag: 'L' }), ...padded(body)]
    }
    case 'raw': {
      const content = e.content ?? new Uint8Array()
      return [header({ name: e.name, mode: 0o644, size: content.length, typeflag: e.typeflag, linkname: e.linkname, rawName: true }), ...padded(content)]
    }
  }
}

function parentDirs(files: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const f of files) {
    const parts = f.split('/').slice(0, -1)
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join('/')
      if (d && !d.startsWith('/') && !seen.has(d)) {
        seen.add(d)
        out.push(d)
      }
    }
  }
  return out
}

/** The entry list a file map and options produce, in archive order. */
export function ustarEntries(files: FileMap, opts: UstarOptions = {}): UstarEntry[] {
  const names = Object.keys(files)
  const entries: UstarEntry[] = []
  if (opts.paxHeader) entries.push({ type: 'pax', name: 'PaxHeader/entry', records: opts.paxHeader })
  for (const d of opts.dirs ?? parentDirs(names)) entries.push({ type: 'dir', name: d })
  for (const n of names) entries.push({ type: 'file', name: n, content: files[n] })
  if (opts.symlink) entries.push({ type: 'symlink', ...opts.symlink })
  if (opts.hardlink) entries.push({ type: 'hardlink', ...opts.hardlink })
  if (opts.absolutePath) entries.push({ type: 'file', name: opts.absolutePath, content: 'absolute' })
  if (opts.dotDotPath) entries.push({ type: 'file', name: opts.dotDotPath, content: 'climb' })
  if (opts.gnuLongName) {
    entries.push({ type: 'gnu-longname', longName: opts.gnuLongName })
    entries.push({ type: 'raw', name: opts.gnuLongName.slice(0, 99), typeflag: '0', content: Buffer.from('long') })
  }
  if (opts.device) entries.push({ type: opts.device.kind, name: opts.device.name })
  if (opts.oversize) entries.push({ type: 'file', name: opts.oversize.name, content: new Uint8Array(opts.oversize.bytes) })
  entries.push(...(opts.extra ?? []))
  return entries
}

/** An uncompressed ustar stream: the entries, then two zero blocks. */
export function writeUstar(entries: UstarEntry[]): Buffer {
  return Buffer.concat([...entries.flatMap(encodeEntry), Buffer.alloc(BLOCK * 2, 0)])
}

export function writeTarGz(files: FileMap, opts: UstarOptions = {}): Buffer {
  return gzipSync(writeUstar(ustarEntries(files, opts)))
}
