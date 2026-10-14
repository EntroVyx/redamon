#!/usr/bin/env node
/**
 * Extract the text of a Rules of Engagement document, in a process of its own.
 *
 * The document is untrusted, and both parsers do unbounded work on it: pdfjs
 * runs on the calling thread under Node (there is no real worker) and inflates
 * streams without a cap, and mammoth inflates the whole of word/document.xml.
 * In the webapp process one upload could block the event loop for every user or
 * take the server down with it. Here it is a child the caller kills at a
 * deadline, with a small heap, no environment and no database credentials.
 *
 * Plain Node ESM on purpose: it runs from the image's `scripts/` with no
 * bundler, and resolves its three packages from the node_modules beside it.
 *
 * Protocol: the file arrives on stdin. One JSON line goes to stdout:
 *   {"text": "...", "pages": N, "truncated": false}
 *   {"error": "<code>", ...}           a refusal; the exit code is 2
 * `--self-test` only imports the parsers, so an image build can prove they are
 * present before any upload needs them.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

const require = createRequire(import.meta.url)

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}

const KIND = arg('--kind', '')
const MAX_PAGES = Number(arg('--max-pages', '200'))
const MAX_CHARS = Number(arg('--max-chars', String(2 * 1024 * 1024)))
const MAX_DOCX_BYTES = Number(arg('--max-docx-bytes', String(50 * 1024 * 1024)))
const MAX_DOCX_ENTRIES = Number(arg('--max-docx-entries', '2000'))
const MAX_INPUT_BYTES = Number(arg('--max-input-bytes', String(9 * 1024 * 1024)))
const MAX_RSS_BYTES = Number(arg('--max-rss-bytes', String(768 * 1024 * 1024)))

class Refusal extends Error {
  constructor(code, extra = {}) {
    super(code)
    this.code = code
    this.extra = extra
  }
}

function finish(payload, exitCode) {
  process.stdout.write(JSON.stringify(payload) + '\n', () => process.exit(exitCode))
}

// The heap flag bounds JavaScript objects, not the typed arrays an inflate fills;
// this catches those between awaits. A synchronous inflate that runs away is the
// caller's deadline to stop.
const watchdog = setInterval(() => {
  if (process.memoryUsage().rss > MAX_RSS_BYTES) finish({ error: 'memory_limit' }, 2)
}, 100)
watchdog.unref()

async function readStdin() {
  const chunks = []
  let total = 0
  for await (const chunk of process.stdin) {
    total += chunk.length
    if (total > MAX_INPUT_BYTES) throw new Refusal('file_too_large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function cap(text) {
  return text.length > MAX_CHARS
    ? { text: text.slice(0, MAX_CHARS), truncated: true }
    : { text, truncated: false }
}

// --- PDF -----------------------------------------------------------------------------

async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
  ).href
  return pdfjs
}

async function extractPdf(bytes) {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    // No code generated from document content, no fonts loaded or installed:
    // text extraction needs none of it.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    stopAtErrors: false,
    verbosity: 0,
  }).promise
  try {
    if (doc.numPages > MAX_PAGES) throw new Refusal('too_many_pages', { pages: doc.numPages })
    const parts = []
    let length = 0
    let truncated = false
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const line = content.items.map(item => (typeof item.str === 'string' ? item.str : '')).join(' ')
      page.cleanup()
      parts.push(line)
      length += line.length + 1
      if (length > MAX_CHARS) {
        truncated = true
        break
      }
    }
    const capped = cap(parts.join('\n'))
    return { text: capped.text, pages: doc.numPages, truncated: truncated || capped.truncated }
  } finally {
    await doc.destroy()
  }
}

// --- DOCX ----------------------------------------------------------------------------

/**
 * Prove the archive inflates to at most MAX_DOCX_BYTES before mammoth sees it.
 *
 * The central directory states each entry's size, and a bomb can state a small
 * one, so every entry is actually inflated here with zlib's `maxOutputLength`
 * set to what is left of the budget: a liar fails at the budget rather than at
 * the heap limit.
 */
function checkDocxArchive(buf) {
  const EOCD = 0x06054b50
  const searchFrom = Math.max(0, buf.length - 22 - 0xffff)
  let eocd = -1
  for (let i = buf.length - 22; i >= searchFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Refusal('not_a_docx')
  const entries = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (entries === 0xffff || cdOffset === 0xffffffff) throw new Refusal('docx_too_large')
  if (entries > MAX_DOCX_ENTRIES) throw new Refusal('docx_too_many_entries', { entries })
  if (cdOffset + cdSize > buf.length) throw new Refusal('not_a_docx')

  let budget = MAX_DOCX_BYTES
  let p = cdOffset
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Refusal('not_a_docx')
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const declaredSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    p += 46 + nameLen + extraLen + commentLen

    if (declaredSize > budget) throw new Refusal('docx_too_large')
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Refusal('not_a_docx')
    }
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    if (dataStart + compressedSize > buf.length) throw new Refusal('not_a_docx')
    const data = buf.subarray(dataStart, dataStart + compressedSize)

    let actual
    if (method === 0) {
      actual = data.length
    } else if (method === 8) {
      try {
        actual = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, budget) }).length
      } catch (err) {
        if (err && err.code === 'ERR_BUFFER_TOO_LARGE') throw new Refusal('docx_too_large')
        throw new Refusal('not_a_docx')
      }
    } else {
      throw new Refusal('not_a_docx')
    }
    budget -= actual
    if (budget < 0) throw new Refusal('docx_too_large')
  }
}

async function extractDocx(bytes) {
  checkDocxArchive(bytes)
  const mammoth = await import('mammoth')
  const result = await (mammoth.default ?? mammoth).extractRawText({ buffer: bytes })
  const capped = cap(result.value || '')
  return { text: capped.text, pages: 0, truncated: capped.truncated }
}

// --- text ----------------------------------------------------------------------------

function extractPlain(bytes) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^﻿/, '')
  const capped = cap(text)
  return { text: capped.text, pages: 0, truncated: capped.truncated }
}

async function main() {
  if (process.argv.includes('--self-test')) {
    await loadPdfjs()
    await import('mammoth')
    finish({ ok: true }, 0)
    return
  }
  const bytes = await readStdin()
  let result
  if (KIND === 'pdf') result = await extractPdf(bytes)
  else if (KIND === 'docx') result = await extractDocx(bytes)
  else if (KIND === 'txt' || KIND === 'md') result = extractPlain(bytes)
  else throw new Refusal('unsupported_type')
  finish(result, 0)
}

main().catch(err => {
  if (err instanceof Refusal) {
    finish({ error: err.code, ...err.extra }, 2)
    return
  }
  // The message of a parser error can quote the document; only its class leaves.
  finish({ error: 'parse_failed', kind: err && err.name ? String(err.name).slice(0, 40) : 'Error' }, 2)
})
