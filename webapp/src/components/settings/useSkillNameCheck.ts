import { useEffect, useState } from 'react'

export type NameCheckState = 'idle' | 'checking' | 'available' | 'taken' | 'invalid' | 'error'

export interface NameCheck {
  state: NameCheckState
  /** The next free `<root> vN` (for a version) or a free variant of a taken name. */
  suggestion: string | null
  /** The server's reason code when not available (name_taken, name_too_long, name_invalid). */
  reason: string | null
}

const DEBOUNCE_MS = 300

/**
 * The server's answer on a user-skill name while the person types (GET .../name-check).
 * An early answer for the form only: the write checks again under its lock. `sourceId` asks
 * for the next version name of that skill; `exceptId` is the skill being renamed.
 */
export function useSkillNameCheck(
  userId: string | null | undefined,
  name: string,
  opts: { sourceId?: string; exceptId?: string; enabled?: boolean } = {},
): NameCheck {
  const { sourceId, exceptId, enabled = true } = opts
  const [check, setCheck] = useState<NameCheck>({ state: 'idle', suggestion: null, reason: null })

  useEffect(() => {
    if (!enabled || !userId) {
      setCheck({ state: 'idle', suggestion: null, reason: null })
      return
    }
    let cancelled = false
    setCheck((c) => ({ ...c, state: 'checking' }))
    const timer = setTimeout(async () => {
      const qs = new URLSearchParams({ name })
      if (sourceId) qs.set('sourceId', sourceId)
      if (exceptId) qs.set('exceptId', exceptId)
      try {
        const res = await fetch(`/api/users/${userId}/attack-skills/name-check?${qs}`)
        const body = await res.json().catch(() => null)
        if (cancelled) return
        if (!res.ok || !body) {
          setCheck({ state: 'error', suggestion: null, reason: null })
          return
        }
        setCheck({
          state: body.available ? 'available' : body.reason === 'name_taken' ? 'taken' : 'invalid',
          suggestion: typeof body.suggestion === 'string' ? body.suggestion : null,
          reason: typeof body.reason === 'string' ? body.reason : null,
        })
      } catch {
        if (!cancelled) setCheck({ state: 'error', suggestion: null, reason: null })
      }
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [userId, name, sourceId, exceptId, enabled])

  return check
}

export function nameCheckMessage(check: NameCheck): string | null {
  switch (check.state) {
    case 'taken':
      return check.suggestion
        ? `You already have a skill with this name. Try "${check.suggestion}".`
        : 'You already have a skill with this name.'
    case 'invalid':
      return check.reason === 'name_too_long'
        ? 'A skill name is at most 100 characters.'
        : 'A skill needs a name without control or invisible characters.'
    case 'error':
      return 'The name could not be checked; it is checked again when you save.'
    default:
      return null
  }
}
