import { gunzipSync } from 'zlib'

/**
 * The strict reader of plugin archives (TD-12): a gzip'd POSIX ustar stream holding only
 * regular files and directories under one top folder named after the plugin. Anything a
 * general tar extractor would accept and this platform does not need (links, devices,
 * pax and GNU headers, base-256 numbers, absolute or climbing paths, backslashes, NUL or
 * control characters, duplicates, more than 2,000 entries, more than the size cap) is
 * refused, so the reader never has to decide what an odd entry means.
 *
 * The cap applies to the whole unpacked tar stream through `maxOutputLength`, so a gzip
 * bomb stops at the cap instead of filling memory; sizes declared in headers are never
 * trusted for that.
 */
export const BLOCK = 512
export const ARCHIVE_MAX_ENTRIES = 2000

export interface ArchiveFile {
  /** Relative to the top folder, `/`-separated. */
  path: string
  /** As written in the archive; the platform writes its own modes. */
  mode: number
  bytes: Buffer
}

export interface ReadArchive {
  files: ArchiveFile[]
  /** Relative to the top folder; the top folder itself is not listed. */
  dirs: string[]
  totalBytes: number
}

export class ArchiveError extends Error {
  readonly code = 'unsafe_archive'
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveError'
  }
}

const refuse = (message: string): never => {
  throw new ArchiveError(message)
}

const TYPE_REFUSALS: Record<string, string> = {
  '1': 'a hard link',
  '2': 'a symlink',
  '3': 'a device',
  '4': 'a device',
  '6': 'a fifo',
  x: 'a pax header',
  g: 'a pax header',
  L: 'a GNU long name header',
  K: 'a GNU long name header',
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** A NUL-terminated header field; bytes after the first NUL must be NUL too. */
function field(h: Buffer, offset: number, width: number, what: string): Buffer {
  const raw = h.subarray(offset, offset + width)
  const end = raw.indexOf(0)
  if (end === -1) return raw
  if (raw.subarray(end).some((b) => b !== 0)) refuse(`${what} contains a NUL character`)
  return raw.subarray(0, end)
}

function octal(h: Buffer, offset: number, width: number, what: string): number {
  const raw = h.subarray(offset, offset + width)
  if (raw[0] & 0x80) refuse(`${what} uses a base-256 number, which ustar does not`)
  const text = raw.toString('latin1').replace(/[\0 ]+$/, '').replace(/^ +/, '')
  if (!/^[0-7]*$/.test(text)) refuse(`${what} is not an octal number`)
  return text === '' ? 0 : parseInt(text, 8)
}

function checksumOk(h: Buffer): boolean {
  const stored = octal(h, 148, 8, 'the header checksum')
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]
  return sum === stored
}

function entryName(h: Buffer): string {
  const name = field(h, 0, 100, 'a name')
  const prefix = field(h, 345, 155, 'a name prefix')
  const bytes = prefix.length ? Buffer.concat([prefix, Buffer.from('/'), name]) : name
  let s: string
  try {
    s = utf8.decode(bytes)
  } catch {
    return refuse('a name is not valid UTF-8')
  }
  if (s.includes('\\')) refuse(`"${s}" contains a backslash`)
  if (/[\u0000-\u001f\u007f]/.test(s)) refuse('a name contains a control character')
  if (s.startsWith('/')) refuse(`"${s}" is an absolute path`)
  return s
}

function components(name: string, isDir: boolean): string[] {
  const parts = (isDir ? name.replace(/\/$/, '') : name).split('/')
  for (const p of parts) {
    if (p === '..') refuse(`"${name}" climbs out of its folder with ..`)
    if (p === '' || p === '.') refuse(`"${name}" has an empty or "." path component`)
  }
  return parts
}

export function readArchive(gz: Buffer, opts: { pluginId: string; maxBytes: number }): ReadArchive {
  if (gz.length < 2 || gz[0] !== 0x1f || gz[1] !== 0x8b) refuse('the archive is not gzip-compressed')
  let tar: Buffer
  try {
    tar = gunzipSync(gz, { maxOutputLength: opts.maxBytes })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) {
      return refuse(`the unpacked archive is larger than ${opts.maxBytes} bytes`)
    }
    return refuse('the archive is not valid gzip')
  }

  const files: ArchiveFile[] = []
  const kinds = new Map<string, 'file' | 'dir'>()
  let entries = 0
  let totalBytes = 0
  let at = 0
  let ended = false

  while (at + BLOCK <= tar.length) {
    const h = tar.subarray(at, at + BLOCK)
    if (h.every((b) => b === 0)) {
      ended = true
      break
    }
    if (!checksumOk(h)) refuse(`the header at byte ${at} has a wrong checksum`)
    if (h.toString('latin1', 257, 263) !== 'ustar\0' || h.toString('latin1', 263, 265) !== '00') {
      refuse('an entry is not in the POSIX ustar format')
    }
    const typeflag = String.fromCharCode(h[156])
    if (TYPE_REFUSALS[typeflag]) refuse(`the archive contains ${TYPE_REFUSALS[typeflag]}`)
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '5') refuse(`unsupported entry type "${typeflag}"`)
    const isDir = typeflag === '5'

    const name = entryName(h)
    if (field(h, 157, 100, 'a link name').length) refuse(`"${name}" carries a link name`)
    const size = octal(h, 124, 12, 'a size')
    const mode = octal(h, 100, 8, 'a mode') & 0o7777
    if (isDir && size !== 0) refuse(`the directory "${name}" has a size`)

    entries += 1
    if (entries > ARCHIVE_MAX_ENTRIES) refuse(`the archive has more than ${ARCHIVE_MAX_ENTRIES} entries`)

    const parts = components(name, isDir)
    if (parts[0] !== opts.pluginId || (!isDir && parts.length === 1)) {
      refuse(`everything must be inside one top folder named "${opts.pluginId}" (found "${name}")`)
    }
    const rel = parts.slice(1).join('/')

    at += BLOCK
    const dataEnd = at + size
    if (dataEnd > tar.length) refuse('the archive is truncated: an entry is longer than the data left')
    const bytes = Buffer.from(tar.subarray(at, dataEnd))
    at += Math.ceil(size / BLOCK) * BLOCK

    if (rel === '') continue // the top folder itself
    for (let i = 1; i < parts.length - 1; i++) {
      const ancestor = parts.slice(1, i + 1).join('/')
      if (kinds.get(ancestor) === 'file') refuse(`"${ancestor}" is both a file and a directory`)
      kinds.set(ancestor, kinds.get(ancestor) ?? 'dir')
    }
    const seen = kinds.get(rel)
    if (seen && seen !== (isDir ? 'dir' : 'file')) refuse(`"${rel}" is both a file and a directory`)
    if (seen === 'file') refuse(`"${rel}" appears twice`)
    kinds.set(rel, isDir ? 'dir' : 'file')
    if (!isDir) {
      totalBytes += size
      files.push({ path: rel, mode, bytes })
    }
  }

  if (!ended) refuse('the archive is truncated: it has no end-of-archive block')
  if (tar.subarray(at).some((b) => b !== 0)) refuse('the archive has data after the end-of-archive blocks')
  if (!files.length) refuse('the archive contains no file')
  const dirs = [...kinds].filter(([, k]) => k === 'dir').map(([p]) => p)
  return { files, dirs, totalBytes }
}
