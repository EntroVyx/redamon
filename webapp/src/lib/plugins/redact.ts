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
 *   does not (U+017F and U+212A it folds like Python): CI_I and the extra class letters;
 * - under JavaScript's `i` flag a class also matches what folds into it: U+0345, a
 *   combining mark that is no word character in Python, folds to the letter ι and so
 *   enters W. No class can leave it out without leaving out ι too, so it is swapped for an
 *   unused private-use character while the text is masked (withIotaStandIn).
 *   redact.casefold.test.ts checks every code point: nothing else folds in.
 * Lengths and the kept prefix count code points, as Python's str does.
 *
 * One difference is accepted: a letter is what the runtime's Unicode version says, Python
 * 3.11's 14.0 in the agent, Node's newer one here, so a letter added after 14.0 counts as a
 * word character only here. Masking is a guard against a real secret leaking by accident,
 * not against an author hiding one (any text can be shaped past a pattern), and real
 * secrets do not sit against such letters.
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

// The two name-then-value patterns below are Python's `NAME*KEYWORD NAME*` rewritten to
// run in linear time. Python's form backtracks over every keyword in a run of name
// characters, so a scan target printing one long word that repeats a keyword stalled the
// webapp for tens of seconds (phase 04 review). The match is the same, because the name
// must reach the end of its run: the character after it has to be a separator, never a
// name character. So a lookahead checks that the run holds a keyword, then the run is
// consumed once. redact.linear.test.ts compares both forms match by match.

const HEADER_NAME = String.raw`[\p{L}\p{N}_-]`
const CREDENTIAL_HEADER = re(
  String.raw`${LINE_START}([ \t]*(?!www-authent${CI_I}cate${B})(?=${HEADER_NAME}*?` +
    String.raw`(?:auth|ap${CI_I}-?key|ap${CI_I}key|token|sess${CI_I}on|secret|s${CI_I}gnature` +
    String.raw`|credent${CI_I}al|password|csrf|xsrf))${HEADER_NAME}*[ \t]*:[ \t]*)(${'[^' + S_CHARS + ']'}${DOT}{5,})${LINE_END}`,
  'i',
)

// A dash is not a name character, so a keyword with one (`api-key`) cannot sit inside a
// run: it joins the run before the dash to the run after it, and is matched as such.
const ASSIGNED_NAME = `[${CI_LETTERS}_]`
const ASSIGNED_KEYWORD_IN_RUN =
  String.raw`(?:password|passwd|pwd|secret|ap${CI_I}_?key|access_?token|auth_?token|cl${CI_I}ent_?secret)`
const ASSIGNED_KEYWORD_ACROSS_DASH = String.raw`(?:ap${CI_I}-key|access-token|auth-token|cl${CI_I}ent-secret)`
const ASSIGNED_SECRET = re(
  String.raw`(${B_BEFORE_WORD}(?:(?=${ASSIGNED_NAME}*?${ASSIGNED_KEYWORD_IN_RUN})${ASSIGNED_NAME}+` +
    String.raw`|${ASSIGNED_NAME}*${ASSIGNED_KEYWORD_ACROSS_DASH}${ASSIGNED_NAME}*)${B}["']?${S}*[:=]${S}*["']?)` +
    String.raw`([^${S_CHARS}"'&,;<>]{6,})`,
  'i',
)

/** Exported for redact.linear.test.ts only. */
export const LINEAR_PATTERNS = { ASSIGNED_SECRET, CREDENTIAL_HEADER }
/** Exported for redact.casefold.test.ts only. */
export const WORD_CLASSES = { W, HEADER_NAME }

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

const IOTA_SUBSCRIPT = '\u0345'

/**
 * A private-use character absent from `text`. In every pattern it behaves as Python's
 * U+0345 does: no word character, no space, no letter of any class, and nothing folds to
 * it. Null only for a text that holds every one of them (over 137,000 characters).
 */
function unusedPrivateUse(text: string): string | null {
  const used = new Set<number>()
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if ((cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000) used.add(cp)
  }
  for (let cp = 0xe000; cp <= 0xf8ff; cp++) if (!used.has(cp)) return String.fromCodePoint(cp)
  for (let cp = 0xf0000; cp <= 0x10fffd; cp++) if (!used.has(cp)) return String.fromCodePoint(cp)
  return null
}

function withIotaStandIn(text: string, mask: (t: string) => string): string {
  if (!text.includes(IOTA_SUBSCRIPT)) return mask(text)
  const standIn = unusedPrivateUse(text)
  if (!standIn) return mask(text)
  return mask(text.replaceAll(IOTA_SUBSCRIPT, standIn)).replaceAll(standIn, IOTA_SUBSCRIPT)
}

/** Every secret-shaped substring masked, keeping its first 4 characters. */
export function redactSecretShapes(text: unknown): string {
  // Python's `str(text or "")`.
  if (!text) return ''
  return withIotaStandIn(String(text), maskShapes)
}

function maskShapes(text: string): string {
  let out = text
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

/**
 * A string value masked as Python masks it inside JSON text, where its key stands before
 * it: `{"password": "hunter2hunter2"}` reads as an assignment there, which the value
 * alone does not show. Only the assignment rule is applied across the key, so a value
 * whose key is no credential name is masked exactly as it would be alone.
 */
export function redactKeyedValue(key: string, value: string): string {
  const masked = redactSecretShapes(value)
  const prefix = `${key}=`
  const joined = withIotaStandIn(prefix + masked, (t) =>
    t.replace(ASSIGNED_SECRET, (_m, name: string, v: string) => name + (v.includes('[REDACTED') ? v : keep4(v))),
  )
  return joined.startsWith(prefix) ? joined.slice(prefix.length) : masked
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
