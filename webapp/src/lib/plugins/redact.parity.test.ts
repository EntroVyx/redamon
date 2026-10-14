/**
 * The TypeScript port of the agent's `redact_secret_shapes` (TD-25, R-32) against the
 * shared fixture agentic/tests/test_redaction_vectors.py also asserts. Python's regex is
 * Unicode-aware where JavaScript's is not (word boundaries, \s, `.`, case-insensitive
 * i/İ/ı), and the fixture holds a case for each such difference.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactDeep, redactSecretShapes } from './redact'

interface Vector {
  name: string
  input: string
  expected: string
}

const FIXTURE = join(__dirname, '../../../../agentic/tests/fixtures/redaction_vectors.json')
const VECTORS: Vector[] = JSON.parse(readFileSync(FIXTURE, 'utf8')).vectors

describe('parity with agentic/cypherfix_triage/evidence.py', () => {
  test('the fixture is there and has the Unicode cases', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(40)
    for (const needle of ['İ', 'ı', 'ſ', 'K', '\x1c', '﻿', ' ']) {
      expect(VECTORS.some((v) => v.input.includes(needle))).toBe(true)
    }
  })

  test.each(VECTORS.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    expect(redactSecretShapes(v.input)).toBe(v.expected)
  })

  test.each(VECTORS.map((v) => [v.name, v] as const))('idempotent: %s', (_name, v) => {
    expect(redactSecretShapes(v.expected)).toBe(v.expected)
  })

  test('null, undefined and empty become empty, as str(text or "") does', () => {
    expect(redactSecretShapes(null)).toBe('')
    expect(redactSecretShapes(undefined)).toBe('')
    expect(redactSecretShapes('')).toBe('')
  })
})

describe('redactDeep', () => {
  test('masks every string value at any depth and leaves keys, numbers, booleans and null', () => {
    const aws = 'AKIAIOSFODNN7EXAMPLE'
    const input = {
      command: `curl -H "Authorization: Bearer abcdefghijklmnop" https://example.com`,
      nested: { list: ['plain', `key ${aws}`, 7, true, null], password: 'not-assigned-in-value' },
      [aws]: 'a key that looks like a secret stays: keys are structure',
    }
    const out = redactDeep(input) as typeof input
    expect(out.command).toBe('curl -H "Authorization: Bearer abcd[REDACTED 16 chars]" https://example.com')
    expect(out.nested.list).toEqual(['plain', 'key AKIA[REDACTED 20 chars]', 7, true, null])
    expect(out.nested.password).toBe('not-assigned-in-value')
    expect(Object.keys(out)).toContain(aws)
    expect(input.nested.list[1]).toBe(`key ${aws}`)
  })

  test('a very deep value is cut rather than overflowing the stack', () => {
    let deep: unknown = 'AKIAIOSFODNN7EXAMPLE'
    for (let i = 0; i < 10_000; i++) deep = [deep]
    expect(() => redactDeep(deep)).not.toThrow()
    expect(JSON.stringify(redactDeep(deep))).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })
})
