/**
 * Names of a user's own agent skills. One rule for every write (upload, rename, community
 * import, saving a plugin's proposal): 1 to NAME_MAX_CHARS characters, no control
 * characters, and unique per user ignoring case and spacing.
 *
 * The comparison key is computed in SQL on BOTH sides, never here: JavaScript and Postgres
 * disagree on trimming, `\s`, case folding and normalization, so a key computed in JS would
 * call two names different that the database calls equal, or the reverse. There is no
 * unique index (building one would mean renaming users' existing duplicates at start-up);
 * every writer checks under the per-user lock of userSkillWrites.ts instead.
 *
 * Server only: it imports the Prisma runtime.
 */
import { Prisma } from '@prisma/client'
import { NAME_MAX_CHARS, UserSkillError } from './userSkills'

type Db = Pick<Prisma.TransactionClient, '$queryRaw' | 'userAttackSkill'>

/** Unicode whitespace trimmed, inner runs collapsed to one space, NFC. Names are stored so. */
export function normalizeName(s: string): string {
  return s.normalize('NFC').replace(/\s+/gu, ' ').trim()
}

// Control, format (zero-width, bidi, soft hyphen, tags), private-use and surrogate code
// points: each would let two names look identical while their keys differ. A zero-width
// joiner is a format character too, so an emoji sequence built with one is refused.
const FORBIDDEN_IN_NAME = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u

/** What is wrong with an already normalized name, or null. */
export function nameProblem(name: string): UserSkillError | null {
  if (!name) return new UserSkillError(400, 'name_invalid', 'A skill needs a name.')
  if (name.length > NAME_MAX_CHARS) {
    return new UserSkillError(400, 'name_too_long', `A skill name is at most ${NAME_MAX_CHARS} characters.`)
  }
  if (FORBIDDEN_IN_NAME.test(name)) {
    return new UserSkillError(400, 'name_invalid', 'A skill name cannot contain control or invisible characters.')
  }
  return null
}

// Passed as a parameter, not written into the SQL text, so no layer of string escaping
// can turn `\s` into a literal `s`. Postgres's `\s` leaves out the Unicode spaces JavaScript's
// `\s` holds (the no-break space among them), so they are listed: a name stored before the
// rules is keyed as normalizeName would store it.
const WHITESPACE_RUN = '[\\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+'
// NFC on both sides too: a name typed on one system and one uploaded from a decomposed file
// name are the same name. normalize() needs a UTF8 database, which RedAmon's is.
const sqlKey = (x: Prisma.Sql) =>
  Prisma.sql`lower(regexp_replace(regexp_replace(normalize(${x}, NFC), ${WHITESPACE_RUN}, ' ', 'g'), '^ | $', '', 'g'))`

/** True when another of the user's skills (not `exceptId`) has the same key as `name`. */
export async function isNameTaken(db: Db, userId: string, name: string, exceptId?: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ taken: boolean }[]>(Prisma.sql`
    SELECT /* user_skill_name_taken */ EXISTS (
      SELECT 1 FROM user_attack_skills
       WHERE user_id = ${userId}
         AND ${sqlKey(Prisma.raw('name'))} = ${sqlKey(Prisma.sql`${name}::text`)}
         AND id <> ${exceptId ?? ''}
    ) AS taken`)
  return rows[0]?.taken === true
}

/** The SQL key of each string, in order (for comparing names without a JS key). */
export async function nameKeys(db: Db, names: string[]): Promise<string[]> {
  if (names.length === 0) return []
  const rows = await db.$queryRaw<{ i: number; k: string }[]>(Prisma.sql`
    SELECT /* user_skill_name_keys */ t.i::int AS i, ${sqlKey(Prisma.raw('t.s'))} AS k
      FROM unnest(${names}::text[]) WITH ORDINALITY AS t(s, i)
     ORDER BY t.i`)
  return rows.map((r) => r.k)
}

const VERSION_SUFFIX = /^(.*\S)\s+v(\d{1,6})$/i

/** `My flow v3` → {root: 'My flow', n: 3}; a name without the suffix is its own root. */
export function splitVersion(s: string): { root: string; n: number | null } {
  const m = VERSION_SUFFIX.exec(s)
  return m ? { root: m[1], n: Number(m[2]) } : { root: s, n: null }
}

/** `root` cut so `root + suffix` fits NAME_MAX_CHARS, never inside a surrogate pair. */
function withSuffix(root: string, suffix: string): string {
  const room = NAME_MAX_CHARS - suffix.length
  let out = ''
  for (const ch of root) {
    if (out.length + ch.length > room) break
    out += ch
  }
  return out.trimEnd() + suffix
}

export interface VersionSource {
  id: string
  name: string
  lineageRootId: string | null
}

/**
 * The next `<root> vN` for a new version of `source`, and its N.
 *
 * The family is every skill of the user whose name has the same root (a bare root counts as
 * v1), plus every skill of the same lineage, so the numbering stays right after a rename.
 * A deleted top version's number can come back: a name is not a revision id, sessions
 * record the skill's id.
 */
export async function suggestVersionName(
  db: Db,
  userId: string,
  source: VersionSource,
): Promise<{ name: string; version: number }> {
  const root = splitVersion(normalizeName(source.name)).root
  const rows = await db.userAttackSkill.findMany({
    where: { userId },
    select: { id: true, name: true, version: true, lineageRootId: true },
  })
  const splits = rows.map((r) => splitVersion(r.name))
  const [rootKey, ...keys] = await nameKeys(db, [root, ...splits.map((s) => s.root)])
  const lineage = source.lineageRootId ?? source.id
  let top = 1
  rows.forEach((r, i) => {
    if (keys[i] === rootKey) top = Math.max(top, splits[i].n ?? 1)
    if (r.lineageRootId === lineage || r.id === lineage) top = Math.max(top, r.version ?? 1)
  })
  // Bounded: at most one candidate per existing skill can be taken.
  for (let next = top + 1, tries = 0; tries <= rows.length + 1; next++, tries++) {
    const candidate = withSuffix(root, ` v${next}`)
    if (!(await isNameTaken(db, userId, candidate))) return { name: candidate, version: next }
  }
  throw new UserSkillError(409, 'name_taken', 'No free version name was found; type a name.')
}
