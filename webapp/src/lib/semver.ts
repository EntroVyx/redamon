/**
 * Compare two semver strings (e.g. "3.1.0" vs "3.1.1").
 * Returns true if `latest` is newer than `current`.
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string) => v.split('.').map(Number)
  const [cMajor = 0, cMinor = 0, cPatch = 0] = parse(current)
  const [lMajor = 0, lMinor = 0, lPatch = 0] = parse(latest)

  if (lMajor !== cMajor) return lMajor > cMajor
  if (lMinor !== cMinor) return lMinor > cMinor
  return lPatch > cPatch
}

/**
 * Compare two semver strings.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map(Number)
  const [aMajor = 0, aMinor = 0, aPatch = 0] = parse(a)
  const [bMajor = 0, bMinor = 0, bPatch = 0] = parse(b)

  if (aMajor !== bMajor) return aMajor > bMajor ? 1 : -1
  if (aMinor !== bMinor) return aMinor > bMinor ? 1 : -1
  if (aPatch !== bPatch) return aPatch > bPatch ? 1 : -1
  return 0
}

// ---------------------------------------------------------------------------
// Strict versions and ranges for the plugin platform (README.PLUGINS.md §11).
//
// A deliberately small grammar: a version is `x.y.z` (digits only, no leading
// zeros, at most 9 digits per part); a range is 1 to 4 space-separated
// comparators `>=`, `>`, `<=`, `<`, `=`, each glued to a full version, all of which
// must hold. Anything else throws RangeSyntaxError. The plugin repository's Python
// tools implement the same grammar; the cases in
// src/lib/plugins/__fixtures__/semver-cases.json keep the two equal, so a change
// here is a change there.
// ---------------------------------------------------------------------------

export class RangeSyntaxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RangeSyntaxError'
  }
}

export interface Version {
  major: number
  minor: number
  patch: number
}

export type ComparatorOp = '>=' | '>' | '<=' | '<' | '='

export interface Comparator {
  op: ComparatorOp
  version: Version
}

const PART = '(0|[1-9][0-9]{0,8})'
const VERSION = `${PART}\\.${PART}\\.${PART}`
const OP = '(>=|<=|>|<|=)'
const MAX_COMPARATORS = 4
const VERSION_RE = new RegExp(`^${VERSION}$`)
const COMPARATOR_RE = new RegExp(`^${OP}(${VERSION})$`)

/**
 * The same grammar as single patterns, for JSON Schema `pattern` (the plugin
 * repository's CI validates manifests with them). semver.ranges.test.ts holds them
 * equal to the parser on every fixture case. They end in `(?!\n)$` because Python's
 * `$` also matches before a trailing newline; this form means "end of string" in both.
 */
export const VERSION_PATTERN = `^${VERSION}(?!\\n)$`
export const RANGE_PATTERN = `^ *${OP}${VERSION}( +${OP}${VERSION}){0,${MAX_COMPARATORS - 1}} *(?!\\n)$`

export function parseVersion(v: string): Version {
  const m = typeof v === 'string' ? VERSION_RE.exec(v) : null
  if (!m) throw new RangeSyntaxError(`"${String(v)}" is not a version: expected x.y.z, digits only`)
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1
  return 0
}

export function parseRange(range: string): Comparator[] {
  if (typeof range !== 'string') throw new RangeSyntaxError('a version range must be a string')
  const tokens = range.split(' ').filter((t) => t !== '')
  if (tokens.length === 0) throw new RangeSyntaxError('a version range needs at least one comparator')
  if (tokens.length > MAX_COMPARATORS) {
    throw new RangeSyntaxError(`a version range has at most ${MAX_COMPARATORS} comparators`)
  }
  return tokens.map((t) => {
    const m = COMPARATOR_RE.exec(t)
    if (!m) {
      throw new RangeSyntaxError(
        `"${t}" is not a comparator: expected one of >= > <= < = glued to a version x.y.z`,
      )
    }
    return { op: m[1] as ComparatorOp, version: parseVersion(m[2]) }
  })
}

function holds(c: Comparator, v: Version): boolean {
  const cmp = compareVersions(v, c.version)
  switch (c.op) {
    case '>=': return cmp >= 0
    case '>': return cmp > 0
    case '<=': return cmp <= 0
    case '<': return cmp < 0
    case '=': return cmp === 0
  }
}

/** True when `version` meets every comparator of `range`. Throws RangeSyntaxError on bad input. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version)
  return parseRange(range).every((c) => holds(c, v))
}

export function isValidVersion(v: unknown): boolean {
  try {
    parseVersion(v as string)
    return true
  } catch {
    return false
  }
}

export function isValidRange(r: unknown): boolean {
  try {
    parseRange(r as string)
    return true
  } catch {
    return false
  }
}
