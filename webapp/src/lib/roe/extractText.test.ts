/**
 * The RoE extractor runs the parsers in a child that holds nothing and dies on
 * time. Each fixture is generated here, so no binary document is committed.
 *
 * @vitest-environment node
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

import JSZip from 'jszip'
import { describe, test, expect, beforeAll } from 'vitest'

import { digestScopeDocument } from '@/lib/engagement'
import { extractRoeText, ExtractError, sha256Hex } from './extractText'
import { MAX_FILE_SIZE, MAX_PDF_PAGES, classifyRoeFile } from './limits'

/** A valid PDF whose every page shows `lines`, Helvetica, uncompressed. */
function makePdf(lines: string[], pages = 1): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, m => `\\${m}`)
  const stream = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map(l => `(${esc(l)}) '`).join(' ')} ET`
  const kids = Array.from({ length: pages }, (_, i) => `${5 + i} 0 R`).join(' ')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...Array.from({ length: pages }, () =>
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 3 0 R /Resources << /Font << /F1 4 0 R >> >> >>'),
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

async function makeDocx(bodyXml: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    bodyXml + '</w:body></w:document>')
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })
}

const para = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`

let scratch = ''
beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'roe-extract-test-'))
})

describe('the formats it reads', () => {
  test('a PDF: text, page count and both hashes', async () => {
    const pdf = makePdf(['Rules of Engagement', 'Maximum 5 requests per second'], 2)
    const out = await extractRoeText(pdf, 'pdf')
    expect(out.text).toContain('Maximum 5 requests per second')
    expect(out.pages).toBe(2)
    expect(out.truncated).toBe(false)
    expect(out.bytesSha256).toBe(sha256Hex(pdf))
    expect(out.textSha256).toBe(digestScopeDocument(out.text))
  }, 30_000)

  test('a DOCX', async () => {
    const out = await extractRoeText(await makeDocx(para('Testing window: weekdays 09:00 to 17:00')), 'docx')
    expect(out.text).toContain('Testing window: weekdays 09:00 to 17:00')
  }, 30_000)

  test('text and Markdown, with a BOM dropped', async () => {
    const out = await extractRoeText(Buffer.from('﻿# RoE\nNo DoS.'), 'md')
    expect(out.text).toBe('# RoE\nNo DoS.')
  }, 30_000)

  test('a document with no text is refused as empty, not parsed', async () => {
    await expect(extractRoeText(Buffer.from('   \n  '), 'txt')).rejects.toMatchObject({ code: 'empty_document', status: 422 })
  }, 30_000)
})

describe('limits', () => {
  test('more pages than the cap is refused with the count', async () => {
    const err = await extractRoeText(makePdf(['x'], MAX_PDF_PAGES + 1), 'pdf').catch(e => e)
    expect(err).toBeInstanceOf(ExtractError)
    expect(err.code).toBe('too_many_pages')
    expect(err.message).toContain(String(MAX_PDF_PAGES + 1))
  }, 30_000)

  test('a file one byte over the cap never reaches the child', async () => {
    const err = await extractRoeText(Buffer.alloc(MAX_FILE_SIZE + 1, 0x20), 'txt').catch(e => e)
    expect(err.code).toBe('file_too_large')
  })

  test('a file exactly at the cap is read', async () => {
    const big = Buffer.alloc(MAX_FILE_SIZE, 0x61)
    const out = await extractRoeText(big, 'txt')
    expect(out.truncated).toBe(true)
    expect(out.text.length).toBe(2 * 1024 * 1024)
  }, 30_000)
})

describe('a zip bomb is refused before mammoth inflates it', () => {
  test('an honest bomb: the declared sizes exceed the budget', async () => {
    const bomb = await makeDocx(`<w:p><w:r><w:t>${' '.repeat(60 * 1024 * 1024)}</w:t></w:r></w:p>`)
    expect(bomb.length).toBeLessThan(MAX_FILE_SIZE)
    await expect(extractRoeText(bomb, 'docx')).rejects.toMatchObject({ code: 'extract_failed', status: 422 })
  }, 30_000)

  test('a lying bomb: the central directory claims 100 bytes', async () => {
    const bomb = await makeDocx(`<w:p><w:r><w:t>${' '.repeat(60 * 1024 * 1024)}</w:t></w:r></w:p>`)
    // Rewrite every central-directory "uncompressed size" to 100.
    for (let i = 0; i + 46 < bomb.length; i++) {
      if (bomb.readUInt32LE(i) === 0x02014b50) bomb.writeUInt32LE(100, i + 24)
    }
    const err = await extractRoeText(bomb, 'docx').catch(e => e)
    expect(err.code).toBe('extract_failed')
    expect(err.message).toMatch(/expands to more than/)
  }, 30_000)
})

describe('isolation', () => {
  test('a hung parser is killed at the deadline', async () => {
    const hang = path.join(scratch, 'hang.mjs')
    writeFileSync(hang, 'setInterval(() => {}, 1000)\n')
    const started = Date.now()
    const err = await extractRoeText(Buffer.from('x'), 'txt', { scriptPath: hang, timeoutMs: 500 }).catch(e => e)
    expect(err.code).toBe('extract_failed')
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 10_000)

  test('the child holds no environment: no database URL, no secrets', async () => {
    process.env.DATABASE_URL = 'postgresql://u:secret@db/x'
    process.env.INTERNAL_API_KEY = 'internal-secret'
    const dump = path.join(scratch, 'env.mjs')
    writeFileSync(dump, 'process.stdout.write(JSON.stringify({ text: JSON.stringify(process.env) }))\n')
    const out = await extractRoeText(Buffer.from('x'), 'txt', { scriptPath: dump })
    expect(JSON.parse(out.text)).toEqual({ NODE_ENV: 'production' })
  }, 10_000)

  test('a crash reports a fixed message and never the document', async () => {
    const crash = path.join(scratch, 'crash.mjs')
    writeFileSync(crash, 'throw new Error("SECRET-CLIENT-NAME in the document")\n')
    const err = await extractRoeText(Buffer.from('x'), 'txt', { scriptPath: crash }).catch(e => e)
    expect(err.code).toBe('extract_failed')
    expect(err.message).not.toContain('SECRET')
  }, 10_000)

  test('pdfjs runs with code generation and fonts off', () => {
    const script = readFileSync(path.join(process.cwd(), 'scripts', 'roe-extract.mjs'), 'utf8')
    expect(script).toMatch(/isEvalSupported:\s*false/)
    expect(script).toMatch(/disableFontFace:\s*true/)
    expect(script).toMatch(/useSystemFonts:\s*false/)
    const parent = readFileSync(path.join(process.cwd(), 'src', 'lib', 'roe', 'extractText.ts'), 'utf8')
    expect(parent).toContain('--disallow-code-generation-from-strings')
    expect(parent).toMatch(/env:\s*\{ NODE_ENV: 'production' \}/)
  })
})

describe('classifyRoeFile', () => {
  test('the extension decides, and a contradicting type is refused', () => {
    expect(classifyRoeFile('roe.PDF', 'application/pdf')).toBe('pdf')
    expect(classifyRoeFile('roe.md', '')).toBe('md')
    expect(classifyRoeFile('roe.docx', 'application/octet-stream')).toBe('docx')
    expect(classifyRoeFile('roe.pdf', 'text/html')).toBeNull()
    expect(classifyRoeFile('roe.html', 'text/html')).toBeNull()
    expect(classifyRoeFile('roe.exe', '')).toBeNull()
  })
})
