/**
 * Text Postgres cannot keep. jsonb and text columns refuse U+0000 (22P05, 22021), and
 * Prisma refuses a surrogate that is not half of a pair before the query is sent.
 * JavaScript strings, and so JSON from plugin code, may hold both: whatever reaches a
 * write is checked first, because the write would otherwise fail as a 500.
 */
const UNSTORABLE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
const UNSTORABLE_ALL = new RegExp(UNSTORABLE.source, 'g')

export const isStorableText = (s: string): boolean => !UNSTORABLE.test(s)

/** `s` with each character Postgres cannot keep replaced by U+FFFD. */
export const storableText = (s: string): string => s.replace(UNSTORABLE_ALL, '�')

/** Whether every string and key in `value` can be stored. Iterative: depth costs no stack. */
export function isStorableJson(value: unknown): boolean {
  const stack: unknown[] = [value]
  while (stack.length) {
    const v = stack.pop()
    if (typeof v === 'string') {
      if (!isStorableText(v)) return false
    } else if (Array.isArray(v)) {
      stack.push(...v)
    } else if (v !== null && typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) {
        if (!isStorableText(k)) return false
        stack.push(item)
      }
    }
  }
  return true
}
