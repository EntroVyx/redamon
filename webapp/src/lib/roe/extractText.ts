/**
 * Run the RoE text extractor in a child process and hash what it returns.
 *
 * Server-side only. The child (`scripts/roe-extract.mjs`) gets the file on stdin,
 * an empty environment, a 256 MB heap and no code generation from strings, and
 * is killed at EXTRACT_TIMEOUT_MS. Whatever goes wrong in it, the caller gets a
 * coded error whose message never quotes the document.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createHash } from 'crypto'
import path from 'path'

import { digestScopeDocument } from '@/lib/engagement'
import {
  EXTRACT_MAX_OLD_SPACE_MB,
  EXTRACT_TIMEOUT_MS,
  MAX_DOCX_ENTRIES,
  MAX_DOCX_UNCOMPRESSED_BYTES,
  MAX_FILE_SIZE,
  MAX_PDF_PAGES,
  MAX_TEXT_CHARS,
  type RoeFileKind,
} from './limits'

export interface ExtractedDocument {
  text: string
  /** PDF page count; 0 for formats without pages. */
  pages: number
  /** The extracted text hit MAX_TEXT_CHARS and was cut there. */
  truncated: boolean
  bytesSha256: string
  /** The same digest an MCP engagement authorization records for a document. */
  textSha256: string
}

export type ExtractErrorCode = 'extract_failed' | 'too_many_pages' | 'empty_document' | 'file_too_large'

export class ExtractError extends Error {
  constructor(
    readonly code: ExtractErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ExtractError'
  }
}

export interface ExtractOptions {
  /** Tests point this at a script that hangs or dumps its environment. */
  scriptPath?: string
  timeoutMs?: number
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function extractorPath(): string {
  // The standalone server and vitest both run with the webapp root as cwd.
  return path.join(process.cwd(), 'scripts', 'roe-extract.mjs')
}

const REFUSALS: Record<string, { code: ExtractErrorCode; status: number; message: (o: Record<string, unknown>) => string }> = {
  too_many_pages: {
    code: 'too_many_pages',
    status: 400,
    message: o => `The PDF has ${Number(o.pages) || 'too many'} pages (max ${MAX_PDF_PAGES}). Use a shorter document.`,
  },
  file_too_large: {
    code: 'file_too_large',
    status: 400,
    message: () => `The file is larger than ${MAX_FILE_SIZE / 1024 / 1024} MB.`,
  },
  docx_too_large: {
    code: 'extract_failed',
    status: 422,
    message: () =>
      `The DOCX expands to more than ${MAX_DOCX_UNCOMPRESSED_BYTES / 1024 / 1024} MB, which no Rules of Engagement document needs. Save it as PDF and try again.`,
  },
  docx_too_many_entries: {
    code: 'extract_failed',
    status: 422,
    message: () => `The DOCX holds more than ${MAX_DOCX_ENTRIES} parts. Save it as PDF and try again.`,
  },
  not_a_docx: {
    code: 'extract_failed',
    status: 422,
    message: () => 'The file is not a readable DOCX document.',
  },
}

const GENERIC_FAILURE = 'The document could not be read. It may be damaged, encrypted, or too complex; try saving it again as PDF.'

export async function extractRoeText(
  bytes: Buffer,
  kind: RoeFileKind,
  opts: ExtractOptions = {},
): Promise<ExtractedDocument> {
  if (bytes.length > MAX_FILE_SIZE) {
    throw new ExtractError('file_too_large', REFUSALS.file_too_large.message({}), 400)
  }
  const out = await runExtractor(bytes, kind, opts)

  if (typeof out.error === 'string') {
    const refusal = REFUSALS[out.error]
    if (refusal) throw new ExtractError(refusal.code, refusal.message(out), refusal.status)
    throw new ExtractError('extract_failed', GENERIC_FAILURE, 422)
  }
  if (typeof out.text !== 'string') throw new ExtractError('extract_failed', GENERIC_FAILURE, 422)
  if (!out.text.trim()) {
    throw new ExtractError(
      'empty_document',
      'No text could be extracted from the document. A scanned PDF has no text layer; run it through OCR first.',
      422,
    )
  }
  return {
    text: out.text,
    pages: typeof out.pages === 'number' ? out.pages : 0,
    truncated: out.truncated === true,
    bytesSha256: sha256Hex(bytes),
    textSha256: digestScopeDocument(out.text),
  }
}

function runExtractor(bytes: Buffer, kind: RoeFileKind, opts: ExtractOptions): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? EXTRACT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [
        `--max-old-space-size=${EXTRACT_MAX_OLD_SPACE_MB}`,
        '--disallow-code-generation-from-strings',
        opts.scriptPath ?? extractorPath(),
        '--kind', kind,
        '--max-pages', String(MAX_PDF_PAGES),
        '--max-chars', String(MAX_TEXT_CHARS),
        '--max-docx-bytes', String(MAX_DOCX_UNCOMPRESSED_BYTES),
        '--max-docx-entries', String(MAX_DOCX_ENTRIES),
        '--max-input-bytes', String(MAX_FILE_SIZE),
      ],
      // No environment beyond NODE_ENV: not DATABASE_URL, not AUTH_SECRET, not
      // the internal key. A parser exploit lands in a process that holds nothing.
      { env: { NODE_ENV: 'production' }, stdio: 'pipe' },
    )

    const fail = (detail: string) => {
      console.warn(`[roe-extract] ${kind}: ${detail}`)
      reject(new ExtractError('extract_failed', GENERIC_FAILURE, 422))
    }

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      fail(`killed after ${timeoutMs} ms`)
    }, timeoutMs)

    // JSON-escaped text is at most ~6x its length; anything beyond that is not our protocol.
    const stdoutCap = MAX_TEXT_CHARS * 6 + 4096
    const chunks: Buffer[] = []
    let size = 0
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > stdoutCap) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          child.kill('SIGKILL')
          fail('output over the protocol cap')
        }
        return
      }
      chunks.push(chunk)
    })
    // Parser warnings can quote the document; they are drained and never logged.
    child.stderr.resume()

    child.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fail(`spawn failed: ${err.message}`)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let parsed: unknown = null
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        parsed = null
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        resolve(parsed as Record<string, unknown>)
        return
      }
      fail(`exited ${code ?? signal} with no result`)
    })

    child.stdin.on('error', () => {
      // EPIPE when the child refuses early; its own answer arrives on stdout.
    })
    child.stdin.end(bytes)
  })
}
