/**
 * A TypeScript port of `redact_secret_shapes` (agentic/cypherfix_triage/evidence.py),
 * used to mask session transcripts before plugin code reads them (README.PLUGINS.md §7.3,
 * TD-25). Both implementations assert agentic/tests/fixtures/redaction_vectors.json.
 *
 * Python's `re` is Unicode-aware where JavaScript's is not, so every construct whose
 * meaning differs is spelled out here instead of written the JavaScript way:
 * - `\w` is any letter or number in Python, ASCII in JavaScript: W below;
 * - `\b` follows that `\w`: written as lookarounds on W;
 * - `\s` includes \x1c-\x1f and U+0085 but not U+FEFF in Python: S below;
 * - `.` matches \r, U+2028 and U+2029 in Python: `[^\n]`;
 * - MULTILINE `^`/`$` see only \n as a line end in Python, and a plain `$` also matches
 *   before a final \n;
 * - IGNORECASE also matches U+0130 and U+0131 for i, which JavaScript's case folding
 *   does not (U+017F and U+212A it folds like Python): CI_I and the extra class letters.
 * Lengths and the kept prefix count code points, as Python's str does.
 */

const W = String.raw`[\p{L}\p{N}_]`
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`
// Every pattern's leading `\b` is followed by a word character, where `\b` means exactly
// "the previous character is not one". The lookbehind alone is ~20 times cheaper than B,
// which matters because a leading assertion is tried at every position of the text.
const B_BEFORE_WORD = `(?<!${W})`
const S_CHARS = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0  -     　`
const S = `[${S_CHARS}]`
const DOT = String.raw`[^\n]`
const LINE_START = String.raw`(?:^|(?<=\n))`
const LINE_END = String.raw`(?=\n|$)`
const CI_I = '[iİı]'
const CI_LETTERS = 'A-Za-zİı'

const re = (source: string, flags = '') => new RegExp(source, `gu${flags}`)

const SECRET_SHAPES: RegExp[] = [
  re(String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|(?=\n?$))`),
  re(String.raw`${B_BEFORE_WORD}eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*`),
  re(String.raw`${B_BEFORE_WORD}(?:AKIA|ASIA)[0-9A-Z]{16}${B}`),
  re(String.raw`${B_BEFORE_WORD}sk-[A-Za-z0-9_-]{20,}`),
  re(String.raw`${B_BEFORE_WORD}AIza[0-9A-Za-z_-]{35}${B}`),
  re(String.raw`${B_BEFORE_WORD}(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})`),
  re(String.raw`${B_BEFORE_WORD}glpat-[A-Za-z0-9_-]{20,}`),
  re(String.raw`${B_BEFORE_WORD}xox[abposr]-[A-Za-z0-9-]{10,}`),
  re(String.raw`${B_BEFORE_WORD}hf_[A-Za-z0-9]{30,}${B}`),
  re(String.raw`${B_BEFORE_WORD}(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}`),
]

const BEARER = re(
  String.raw`(${B_BEFORE_WORD}(?:Bearer|Bas${CI_I}c|Token)${S}+)([${CI_LETTERS}0-9._~+/=-]{8,})`,
  'i',
)

const COOKIE_HEADER = re(String.raw`${LINE_START}([ \t]*cook${CI_I}e[ \t]*:)(${DOT}*)${LINE_END}`, 'i')
const COOKIE_VALUE = re(String.raw`(=)([^;${S_CHARS}]{6,})`)

const CREDENTIAL_HEADER = re(
  String.raw`${LINE_START}([ \t]*(?!www-authent${CI_I}cate${B})[\p{L}\p{N}_-]*` +
    String.raw`(?:auth|ap${CI_I}-?key|ap${CI_I}key|token|sess${CI_I}on|secret|s${CI_I}gnature` +
    String.raw`|credent${CI_I}al|password|csrf|xsrf)[\p{L}\p{N}_-]*[ \t]*:[ \t]*)(${'[^' + S_CHARS + ']'}${DOT}{5,})${LINE_END}`,
  'i',
)

const ASSIGNED_SECRET = re(
  String.raw`(${B_BEFORE_WORD}[${CI_LETTERS}_]*(?:password|passwd|pwd|secret|ap${CI_I}[_-]?key|access[_-]?token` +
    String.raw`|auth[_-]?token|cl${CI_I}ent[_-]?secret)[${CI_LETTERS}_]*${B}["']?${S}*[:=]${S}*["']?)` +
    String.raw`([^${S_CHARS}"'&,;<>]{6,})`,
  'i',
)

const codePoints = (s: string) => Array.from(s)

function keep4(text: string): string {
  const cps = codePoints(text)
  return `${cps.slice(0, 4).join('')}[REDACTED ${cps.length} chars]`
}

function maskHeaderValue(value: string): string {
  if (value.includes('[REDACTED')) return value
  const body = value.replace(/\r+$/, '')
  return keep4(body) + value.slice(body.length)
}

/** Every secret-shaped substring masked, keeping its first 4 characters. */
export function redactSecretShapes(text: unknown): string {
  // Python's `str(text or "")`.
  if (!text) return ''
  let out = String(text)
  for (const pattern of SECRET_SHAPES) out = out.replace(pattern, (m) => keep4(m))
  out = out.replace(BEARER, (_m, scheme: string, value: string) => scheme + keep4(value))
  out = out.replace(COOKIE_HEADER, (_m, name: string, rest: string) =>
    name + rest.replace(COOKIE_VALUE, (_v, eq: string, value: string) => eq + (value.includes('[REDACTED') ? value : keep4(value))),
  )
  out = out.replace(CREDENTIAL_HEADER, (_m, name: string, value: string) => name + maskHeaderValue(value))
  out = out.replace(ASSIGNED_SECRET, (_m, name: string, value: string) =>
    name + (value.includes('[REDACTED') ? value : keep4(value)),
  )
  return out
}

const MAX_DEPTH = 64

/**
 * A copy of `value` with every string masked, at any depth. Object keys are structure
 * and stay as they are. Past MAX_DEPTH levels the rest is replaced by a marker, so a
 * hostile document cannot overflow the stack.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSecretShapes(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[nested too deep]'
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, depth + 1)
  return out
}
