/**
 * The two name-then-value patterns of redactSecretShapes run in linear time (phase 04
 * review). Written the textbook way, as a keyword between two unbounded runs of name
 * characters, a long run that repeats the keyword makes them quadratic: tool output is
 * written by the scan target, so a hostile target could stall the webapp's one thread for
 * as long as a plugin reads the session. The rewritten patterns must match exactly what
 * the textbook ones match, which the fuzz below compares match by match.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { LINEAR_PATTERNS, redactSecretShapes } from './redact'

// The textbook forms, as ported from Python (agentic/cypherfix_triage/evidence.py).
const W = String.raw`[\p{L}\p{N}_]`
const HEADER_NAME = String.raw`[\p{L}\p{N}_-]`
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`
const S_CHARS = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0  -     　`
const S = `[${S_CHARS}]`
const CI_I = '[iİı]'
const CI_LETTERS = 'A-Za-zİı'
const TEXTBOOK = {
  ASSIGNED_SECRET: new RegExp(
    String.raw`((?<!${W})[${CI_LETTERS}_]*(?:password|passwd|pwd|secret|ap${CI_I}[_-]?key|access[_-]?token` +
      String.raw`|auth[_-]?token|cl${CI_I}ent[_-]?secret)[${CI_LETTERS}_]*${B}["']?${S}*[:=]${S}*["']?)` +
      String.raw`([^${S_CHARS}"'&,;<>]{6,})`,
    'giu',
  ),
  CREDENTIAL_HEADER: new RegExp(
    String.raw`(?:^|(?<=\n))([ \t]*(?!www-authent${CI_I}cate${B})${HEADER_NAME}*` +
      String.raw`(?:auth|ap${CI_I}-?key|ap${CI_I}key|token|sess${CI_I}on|secret|s${CI_I}gnature` +
      String.raw`|credent${CI_I}al|password|csrf|xsrf)${HEADER_NAME}*[ \t]*:[ \t]*)(${'[^' + S_CHARS + ']'}[^\n]{5,})(?=\n|$)`,
    'giu',
  ),
}

const matches = (re: RegExp, s: string) => [...s.matchAll(re)].map((m) => [m.index, m[0], m[1], m[2]])

const time = (f: () => unknown) => {
  const t0 = performance.now()
  f()
  return performance.now() - t0
}

describe('hostile input is masked in linear time', () => {
  // The textbook ASSIGNED_SECRET takes ~40 s on this, CREDENTIAL_HEADER ~5 s on the second.
  test.each([
    ['one word repeating a keyword', 'password'.repeat(40_000)],
    ['one header-like line repeating a keyword', 'token-'.repeat(50_000)],
    ['a dashed keyword repeated', 'api-key'.repeat(40_000)],
    ['a run that ends on a digit', 'secret'.repeat(40_000) + '9=hunter2hunter2'],
  ])('%s: under half a second', (_name, input) => {
    expect(time(() => redactSecretShapes(input))).toBeLessThan(500)
  })

  test('a real assignment after a hostile run is still masked', () => {
    const out = redactSecretShapes('password'.repeat(10_000) + ' api_key=RyDhj2xR1SFuDIXFsaA')
    expect(out.endsWith('api_key=RyDh[REDACTED 19 chars]')).toBe(true)
  })
})

describe('the linear patterns match exactly what the textbook ones match', () => {
  const TOKENS = [
    'password', 'passwd', 'pwd', 'secret', 'api', 'apı', 'apİ', 'APİ', 'key', 'Key', 'access', 'token', 'auth',
    'client', 'clıent', 'session', 'sessıon', 'signature', 'credential', 'csrf', 'xsrf', 'www-authenticate',
    'Authorization', 'my', 'x', 'Z', '9', '0', 'ſ', 'K', 'é', 'ß', 'ι', '_', '_', '-', '-', '=', '=', ':', ':', ' ',
    ' ', '\t', '\n', '\r\n', '"', "'", ';', ',', 'hunter2hunter2', 'abcdef', 'RyDhj2xR1S', '[REDACTED', '日本',
    '\u0345', 'api-key', 'apİ-key', 'access-token', 'auth-token', 'clıent-secret', 'x-api-key', '=hunter2hunter2', ': abcdef12',
  ]
  // A deterministic generator (mulberry32), so a failure names a reproducible input. A
  // plain LCG's successive outputs are correlated, and some token pairs then never occur.
  let seed = 0x5eed
  const rnd = (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) % n
  }
  const inputs = Array.from({ length: 100_000 }, () => Array.from({ length: 1 + rnd(24) }, () => TOKENS[rnd(TOKENS.length)]).join(''))

  test.each(['ASSIGNED_SECRET', 'CREDENTIAL_HEADER'] as const)('%s on 100,000 generated inputs', (name) => {
    let matched = 0
    let dashedNames = 0
    for (const s of inputs) {
      const expected = matches(TEXTBOOK[name], s)
      expect(matches(LINEAR_PATTERNS[name], s), JSON.stringify(s)).toEqual(expected)
      if (expected.length) matched++
      if (expected.some((m) => /-/.test(String(m[2]).replace(/[:=][\s\S]*$/, '')))) dashedNames++
    }
    // The generator must exercise the patterns, the dashed keywords included, not only their refusals.
    expect(matched).toBeGreaterThan(3_000)
    expect(dashedNames).toBeGreaterThan(50)
  })
})
