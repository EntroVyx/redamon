import prisma from '@/lib/prisma'
import { KNOWN_ATTACK_PATH_CONFIG } from '@/app/graph/components/AIAssistantDrawer/phaseConfig'
import type { BehaviourExtensionPoint } from './extensionPoints'
import { hasSecretKeyShape } from './redact'

/**
 * The skills an agent session used, built-in and the user's own, read from its
 * `phase_update` rows only: they are small, while the `thinking` rows carry the thought
 * text and are never read here. Shared by the skill picker, the action start (which
 * re-derives a pick instead of trusting it) and the Gateway's user-skill target check.
 *
 * A turn is a distinct `iteration_count`; its skill is that of the LAST phase_update row
 * with that count (the agent writes one per think step). A row is attributed:
 * - by its `skill_workflow` record when that is an object: the skill whose text the
 *   prompt really held (for a user skill, `{skillId: "user_skill:<id>", kind: "user"}`,
 *   possibly the version that superseded the label's);
 * - otherwise by its label (`attack_path_type`):
 *   - a user-skill label in every phase, but only in a session that holds NO user
 *     record: such a session was recorded before the agent recorded user skills, and in a
 *     later one a label without a record means the skill was off and nothing rendered;
 *   - a built-in label outside post-exploitation, and only on a row with no
 *     `skill_workflow` key at all: a null record says the playbook was not in the prompt.
 *
 * Rows are ordered by (sequenceNum, createdAt, id): sequenceNum repeats. No cache: the
 * answer must follow a skill deleted or quarantined a second ago.
 */
export type SessionSkillReason = 'deleted' | 'credentials' | 'quarantined'

export interface SessionSkill {
  /** The built-in id, or `user_skill:<id>`. */
  ref: string
  kind: 'builtin' | 'user'
  point: BehaviourExtensionPoint
  /** What the point's target group is: the built-in id, or the user skill's id. */
  target: string
  /** Null for a user skill that no longer exists (or is not the session owner's). */
  name: string | null
  turns: number
  lastSeq: number
  exists: boolean
  selectable: boolean
  reason?: SessionSkillReason
  /** The text hash the agent last recorded for a user skill (16 hex), when it did. */
  lastContentSha256?: string | null
  /** True when some of its turns were counted by label alone. */
  byLabel: boolean
}

const USER_PREFIX = 'user_skill:'
const USER_ID_RE = /^[a-z][a-z0-9_]{0,63}$/

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isBuiltin = (id: unknown): id is string => typeof id === 'string' && Object.hasOwn(KNOWN_ATTACK_PATH_CONFIG, id)
const userIdOf = (ref: unknown): string | null => {
  if (typeof ref !== 'string' || !ref.startsWith(USER_PREFIX)) return null
  const id = ref.slice(USER_PREFIX.length)
  return USER_ID_RE.test(id) ? id : null
}

/**
 * A key or token in a recognised format. Not the transcript masker's whole rule set, which
 * refused about half of the community skills over words like "Basic authentication".
 */
export function holdsCredentials(text: string): boolean {
  return hasSecretKeyShape(text)
}

/** The same, over everything a plugin is given of a skill: its name, description and text. */
export function skillHoldsCredentials(skill: { name: string; description?: string | null; content: string }): boolean {
  return holdsCredentials([skill.name, skill.description ?? '', skill.content].join('\n'))
}

interface Attribution {
  ref: string
  byLabel: boolean
  contentSha256?: string | null
}

function attribute(data: Record<string, unknown>, sessionHasUserRecord: boolean): Attribution | null {
  const wf = data.skill_workflow
  if (isObj(wf)) {
    if (isBuiltin(wf.skillId)) return { ref: wf.skillId, byLabel: false }
    if (wf.kind === 'user' && userIdOf(wf.skillId)) {
      return {
        ref: wf.skillId as string,
        byLabel: false,
        contentSha256: typeof wf.contentSha256 === 'string' ? wf.contentSha256 : null,
      }
    }
    return null
  }
  const label = data.attack_path_type
  if (userIdOf(label)) return sessionHasUserRecord ? null : { ref: label as string, byLabel: true }
  if (!('skill_workflow' in data) && isBuiltin(label) && data.current_phase !== 'post_exploitation') {
    return { ref: label, byLabel: true }
  }
  return null
}

/** The skills of conversation `conversationId`, whose owner is `ownerId`; most turns first. */
export async function sessionSkills(conversationId: string, ownerId: string): Promise<SessionSkill[]> {
  const rows = await prisma.chatMessage.findMany({
    where: { conversationId, type: 'phase_update' },
    select: { sequenceNum: true, createdAt: true, id: true, data: true },
    orderBy: [{ sequenceNum: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })
  const datas = rows.map((r) => (isObj(r.data) ? r.data : {}))
  const hasUserRecord = datas.some((d) => isObj(d.skill_workflow) && d.skill_workflow.kind === 'user')

  // The last row of each iteration decides that turn.
  const lastOfTurn = new Map<number, number>()
  datas.forEach((d, i) => {
    const n = d.iteration_count
    if (typeof n === 'number' && Number.isInteger(n)) lastOfTurn.set(n, i)
  })

  const tally = new Map<string, { turns: number; lastSeq: number; byLabel: boolean; sha?: string | null }>()
  for (const i of [...lastOfTurn.values()].sort((a, b) => a - b)) {
    const a = attribute(datas[i], hasUserRecord)
    if (!a) continue
    const t = tally.get(a.ref) ?? { turns: 0, lastSeq: 0, byLabel: false }
    t.turns += 1
    t.lastSeq = rows[i].sequenceNum
    t.byLabel ||= a.byLabel
    if (a.contentSha256 !== undefined) t.sha = a.contentSha256
    tally.set(a.ref, t)
  }

  const userIds = [...tally.keys()].map(userIdOf).filter((id): id is string => !!id)
  const owned = userIds.length
    ? await prisma.userAttackSkill.findMany({
        where: { userId: ownerId, id: { in: userIds } },
        select: { id: true, name: true, description: true, content: true, quarantinedAt: true },
      })
    : []
  const byId = new Map(owned.map((s) => [s.id, s]))

  const out: SessionSkill[] = []
  for (const [ref, t] of tally) {
    const userId = userIdOf(ref)
    if (!userId) {
      out.push({
        ref, kind: 'builtin', point: 'skill.text', target: ref, name: KNOWN_ATTACK_PATH_CONFIG[ref].label,
        turns: t.turns, lastSeq: t.lastSeq, exists: true, selectable: true, byLabel: t.byLabel,
      })
      continue
    }
    const skill = byId.get(userId)
    const reason: SessionSkillReason | undefined = !skill
      ? 'deleted'
      : skill.quarantinedAt
        ? 'quarantined'
        : skillHoldsCredentials(skill) ? 'credentials' : undefined
    out.push({
      ref, kind: 'user', point: 'user_skill.text', target: userId, name: skill?.name ?? null,
      turns: t.turns, lastSeq: t.lastSeq, exists: !!skill, selectable: !reason,
      ...(reason ? { reason } : {}),
      lastContentSha256: t.sha ?? null, byLabel: t.byLabel,
    })
  }
  return out.sort((a, b) => b.turns - a.turns || b.lastSeq - a.lastSeq || a.ref.localeCompare(b.ref))
}

/** The suggested pick: the most turns, ties to the latest, among the selectable ones. */
export function suggestedSkill(skills: SessionSkill[]): SessionSkill | null {
  return skills.filter((s) => s.selectable).sort((a, b) => b.turns - a.turns || b.lastSeq - a.lastSeq)[0] ?? null
}
