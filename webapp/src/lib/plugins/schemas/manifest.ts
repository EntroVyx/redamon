import { z } from 'zod'
import { RANGE_PATTERN, VERSION_PATTERN } from '@/lib/semver'
import { RESERVED_PLUGIN_IDS, PLUGIN_ID_RE } from '../ids'
import { PLUGIN_PERMISSIONS } from '../permissions'
import { CORE_SCREENS, CORE_SCREEN_POINT, PLUGIN_ICON_NAMES, POINT_PERMISSION } from '../extensionPoints'
import { ACTION_ID_RE, SCREEN_PATH_RE, parseWith } from './common'

/**
 * `plugin.json`, the whole contract between a plugin and the platform
 * (README.PLUGINS.md §6.3): the platform decides what a plugin may do from this file
 * alone and never reads its Python for that. Strict everywhere, so a key this
 * platform version does not know is refused instead of silently ignored.
 */
export const ACTION_TIMEOUT_MAX_SECONDS = 3600
const ENTRY_RE = /^engine(\/[a-z0-9_]+)+\.py:[a-z_][a-z0-9_]*$/

const label = z.string().min(1).max(60)
const actionId = z.string().regex(ACTION_ID_RE, 'must match ^[a-z][a-z0-9_]{1,39}$')
const screenPath = z.string().regex(SCREEN_PATH_RE, 'must be a .json file under ui/')
const icon = z.enum(PLUGIN_ICON_NAMES)

const action = z.strictObject({
  id: actionId,
  entry: z
    .string()
    .regex(ENTRY_RE, 'must name a function in a .py file under engine/, e.g. engine/main.py:run'),
  // The runtime also caps this at PLUGIN_ACTION_MAX_TIMEOUT, a setting.
  timeoutSeconds: z.number().int().min(1).max(ACTION_TIMEOUT_MAX_SECONDS),
  async: z.boolean().optional(),
  llm: z.boolean().optional(),
  resultScreen: screenPath.optional(),
})

/**
 * What the core asks the person to pick before a chat action starts (platform 1.1.0). The
 * core draws the picker and re-derives the choice on the server; the action receives it as
 * `params.pick`. `session.skill`: one of the skills the session used, of a point the
 * plugin is granted.
 */
export const CHAT_ACTION_PICKS = ['session.skill'] as const

const chatSessionAction = z
  .strictObject({
    label,
    icon: icon.optional(),
    action: actionId.optional(),
    coreScreen: z.enum(CORE_SCREENS).optional(),
    pick: z.enum(CHAT_ACTION_PICKS).optional(),
  })
  .refine((c) => (c.action === undefined) !== (c.coreScreen === undefined), {
    message: 'give either action or coreScreen',
  })
  .refine((c) => c.pick === undefined || c.action !== undefined, {
    message: 'pick goes with an action, not a core screen',
    path: ['pick'],
  })

const contributes = z.strictObject(
  {
    nav: z.strictObject({ label, icon, screen: screenPath }).optional(),
    'chat.session.actions': z.array(chatSessionAction).max(5).optional(),
    'project.skills.row': z.array(z.strictObject({ label, action: actionId })).max(3).optional(),
  },
  {
    error: (iss) =>
      iss.code === 'unrecognized_keys' ? `unknown extension point: ${iss.keys.join(', ')}` : undefined,
  },
)

const unique = <T>(xs: T[]) => new Set(xs).size === xs.length

// A pattern rather than a refine, so the exported JSON Schema carries the rule too.
const NOT_RESERVED_RE = new RegExp(`^(?!(?:${[...RESERVED_PLUGIN_IDS].join('|')})$)`)

export const manifestSchema = z
  .strictObject({
    id: z
      .string()
      .regex(PLUGIN_ID_RE, 'must match ^[a-z][a-z0-9-]{1,39}$')
      .regex(NOT_RESERVED_RE, 'is a reserved name'),
    version: z.string().regex(new RegExp(VERSION_PATTERN), 'must be a version x.y.z'),
    displayName: z.string().min(1).max(60),
    description: z.string().min(1).max(500),
    platform: z
      .string()
      .regex(new RegExp(RANGE_PATTERN), 'must be a range of comparators like ">=1.0.0 <2.0.0"'),
    // The column is a Postgres int4.
    dataVersion: z.number().int().min(1).max(2_147_483_647),
    permissions: z
      .array(z.enum(PLUGIN_PERMISSIONS))
      .refine(unique, 'lists a permission twice'),
    llmFeature: z.strictObject({ description: z.string().min(1).max(200) }).optional(),
    actions: z.array(action).max(50),
    contributes: contributes.optional(),
    screens: z.array(screenPath).max(50).refine(unique, 'lists a screen twice').optional(),
  })
  .superRefine((m, ctx) => {
    const ids = m.actions.map((a) => a.id)
    if (!unique(ids)) ctx.addIssue({ code: 'custom', path: ['actions'], message: 'two actions share an id' })
    const known = new Set(ids)
    const has = (p: string) => (m.permissions as string[]).includes(p)

    m.actions.forEach((a, i) => {
      if (a.llm && !has('llm:invoke')) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', i, 'llm'],
          message: 'an action that calls a model needs the llm:invoke permission',
        })
      }
    })
    if (has('llm:invoke') && !m.llmFeature) {
      ctx.addIssue({
        code: 'custom',
        path: ['llmFeature'],
        message: 'is required with the llm:invoke permission (it describes the model choice to users)',
      })
    }
    if (m.llmFeature && !has('llm:invoke')) {
      ctx.addIssue({ code: 'custom', path: ['llmFeature'], message: 'needs the llm:invoke permission' })
    }

    const refs: { path: (string | number)[]; action: string }[] = []
    m.contributes?.['chat.session.actions']?.forEach((c, i) => {
      if (c.action) refs.push({ path: ['contributes', 'chat.session.actions', i, 'action'], action: c.action })
      if (c.pick === 'session.skill' && !(has('session:read') && (has('override:skill.text') || has('override:user_skill.text')))) {
        ctx.addIssue({
          code: 'custom',
          path: ['contributes', 'chat.session.actions', i, 'pick'],
          message: 'session.skill needs the session:read permission and override:skill.text or override:user_skill.text',
        })
      }
      if (c.coreScreen && !has(POINT_PERMISSION[CORE_SCREEN_POINT[c.coreScreen]])) {
        ctx.addIssue({
          code: 'custom',
          path: ['contributes', 'chat.session.actions', i, 'coreScreen'],
          message: `${c.coreScreen} needs the ${POINT_PERMISSION[CORE_SCREEN_POINT[c.coreScreen]]} permission`,
        })
      }
    })
    m.contributes?.['project.skills.row']?.forEach((c, i) =>
      refs.push({ path: ['contributes', 'project.skills.row', i, 'action'], action: c.action }),
    )
    for (const r of refs) {
      if (!known.has(r.action)) {
        ctx.addIssue({ code: 'custom', path: r.path, message: `no action "${r.action}" is declared` })
      }
    }
  })

export type PluginManifest = z.infer<typeof manifestSchema>

export function parseManifest(input: unknown) {
  return parseWith(manifestSchema, input)
}
