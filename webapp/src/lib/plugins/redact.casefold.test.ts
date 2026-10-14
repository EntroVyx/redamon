/**
 * Under JavaScript's `i` flag a class also matches every character that folds into it,
 * where Python's `\\w` does not (phase 04 review). The word classes of the case-insensitive
 * patterns gain exactly one code point that way, U+0345, which redact.ts swaps for a
 * private-use character while it masks. Every code point is checked, so a Node whose
 * folding adds another turns this red.
 *
 * @vitest-environment node
 */
import { test, expect } from 'vitest'
import { WORD_CLASSES, redactSecretShapes } from './redact'

test.each(Object.entries(WORD_CLASSES))('%s under the i flag gains U+0345 and nothing else', (_name, cls) => {
  const withFlag = new RegExp(`^${cls}$`, 'iu')
  const without = new RegExp(`^${cls}$`, 'u')
  const gained: string[] = []
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    const ch = String.fromCodePoint(cp)
    if (withFlag.test(ch) !== without.test(ch)) gained.push(cp.toString(16))
  }
  expect(gained).toEqual(['345'])
})

test('Greek iota stays a word character: only U+0345 is swapped', () => {
  expect(redactSecretShapes('\u03b9password=hunter2hunter2')).toBe('\u03b9password=hunter2hunter2')
  expect(redactSecretShapes('\u0345password=hunter2hunter2')).toBe('\u0345password=hunt[REDACTED 14 chars]')
})

test('a private-use character already in the text is never confused with the stand-in', () => {
  const text = '\ue000\u0345api_key=RyDhj2xR1SFuDIXFsaA \ue001'
  expect(redactSecretShapes(text)).toBe('\ue000\u0345api_key=RyDh[REDACTED 19 chars] \ue001')
})
