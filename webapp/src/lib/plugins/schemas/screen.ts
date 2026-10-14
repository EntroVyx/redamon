import { z } from 'zod'
import { ACTION_ID_RE, SCREEN_PATH_RE, parseWith, type SchemaResult } from './common'

/**
 * A plugin screen is a JSON description drawn by the core host from a fixed set of
 * primitives (README.PLUGINS.md §7.5); the host never runs plugin JavaScript. Data
 * comes from plugin actions (`source`), buttons and forms call actions, and row
 * actions pass only the listed row fields. A new primitive is a platform change.
 */
export const SCREEN_MAX_DEPTH = 6
export const SCREEN_MAX_NODES = 200
export const SCREEN_TEXT_MAX = 2000
const LABEL_MAX = 200

const text = z.string().max(SCREEN_TEXT_MAX)
const label = z.string().min(1).max(LABEL_MAX)
const actionId = z.string().regex(ACTION_ID_RE, 'must be an action id declared in the manifest')
const screenPath = z.string().regex(SCREEN_PATH_RE, 'must be a .json file under ui/')
const fieldName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'must be a field name of the action result')
const paramValue = z.union([text, z.number(), z.boolean(), z.null()])
const params = z.record(fieldName, paramValue)

const source = z.strictObject({ action: actionId, params: params.optional() })

const exactlyOne = (keys: string[]) => (v: Record<string, unknown>) =>
  keys.filter((k) => v[k] !== undefined).length === 1

const rowAction = z
  .strictObject({
    label,
    screen: screenPath.optional(),
    action: actionId.optional(),
    pass: z.array(fieldName).max(20).default([]),
  })
  .refine(exactlyOne(['screen', 'action']), 'a row action opens a screen or calls an action, not both')

const rowActions = z.array(rowAction).max(5)

/** Static text, or a field of the data the enclosing page's `source` returned. */
const textBinding = z
  .strictObject({ text: text.optional(), field: fieldName.optional() })
  .refine(exactlyOne(['text', 'field']), 'give either text or field')

const option = z.strictObject({ value: z.string().max(LABEL_MAX), label })

const formField = z
  .strictObject({
    name: fieldName,
    label,
    kind: z.enum(['text', 'textarea', 'number', 'select', 'checkbox']),
    required: z.boolean().optional(),
    placeholder: label.optional(),
    maxLength: z.number().int().min(1).max(100000).optional(),
    options: z.array(option).min(1).max(100).optional(),
    default: paramValue.optional(),
  })
  .refine((f) => (f.kind === 'select') === (f.options !== undefined), {
    message: 'options are required for a select field and allowed only there',
    path: ['options'],
  })

export type ScreenNode =
  | { type: 'page'; title?: string; source?: z.infer<typeof source>; children: ScreenNode[] }
  | {
      type: 'list'
      title?: string
      source: z.infer<typeof source>
      itemTitle: string
      itemSubtitle?: string
      rowActions?: z.infer<typeof rowAction>[]
      emptyText?: string
    }
  | {
      type: 'table'
      title?: string
      source: z.infer<typeof source>
      columns: { field: string; label?: string; format?: 'text' | 'date' | 'number' }[]
      rowActions?: z.infer<typeof rowAction>[]
      emptyText?: string
    }
  | {
      type: 'form'
      title?: string
      fields: z.infer<typeof formField>[]
      submit: { action: string; label?: string }
      resultScreen?: string
    }
  | {
      type: 'select'
      name: string
      label: string
      options: { value: string; label: string }[]
      default?: string
    }
  | {
      type: 'button'
      label: string
      action?: string
      screen?: string
      params?: Record<string, string | number | boolean | null>
      confirm?: string
      tone?: 'primary' | 'secondary' | 'danger'
    }
  | { type: 'markdown'; content: z.infer<typeof textBinding> }
  | { type: 'textDiff'; title?: string; before: z.infer<typeof textBinding>; after: z.infer<typeof textBinding> }
  | { type: 'badge'; content: z.infer<typeof textBinding>; tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }
  | { type: 'emptyState'; title: string; text?: string }

export const screenNodeSchema: z.ZodType<ScreenNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('page'),
      title: label.optional(),
      source: source.optional(),
      children: z.array(screenNodeSchema).max(50),
    }),
    z.strictObject({
      type: z.literal('list'),
      title: label.optional(),
      source,
      itemTitle: fieldName,
      itemSubtitle: fieldName.optional(),
      rowActions: rowActions.optional(),
      emptyText: text.optional(),
    }),
    z.strictObject({
      type: z.literal('table'),
      title: label.optional(),
      source,
      columns: z
        .array(
          z.strictObject({
            field: fieldName,
            label: label.optional(),
            format: z.enum(['text', 'date', 'number']).optional(),
          }),
        )
        .min(1)
        .max(20),
      rowActions: rowActions.optional(),
      emptyText: text.optional(),
    }),
    z.strictObject({
      type: z.literal('form'),
      title: label.optional(),
      fields: z.array(formField).min(1).max(30),
      submit: z.strictObject({ action: actionId, label: label.optional() }),
      resultScreen: screenPath.optional(),
    }),
    z.strictObject({
      type: z.literal('select'),
      name: fieldName,
      label,
      options: z.array(option).min(1).max(100),
      default: z.string().max(LABEL_MAX).optional(),
    }),
    z
      .strictObject({
        type: z.literal('button'),
        label,
        action: actionId.optional(),
        screen: screenPath.optional(),
        params: params.optional(),
        confirm: text.optional(),
        tone: z.enum(['primary', 'secondary', 'danger']).optional(),
      })
      .refine(exactlyOne(['action', 'screen']), 'a button calls an action or opens a screen, not both'),
    z.strictObject({ type: z.literal('markdown'), content: textBinding }),
    z.strictObject({
      type: z.literal('textDiff'),
      title: label.optional(),
      before: textBinding,
      after: textBinding,
    }),
    z.strictObject({
      type: z.literal('badge'),
      content: textBinding,
      tone: z.enum(['neutral', 'info', 'success', 'warning', 'danger']).optional(),
    }),
    z.strictObject({ type: z.literal('emptyState'), title: label, text: text.optional() }),
  ]),
) as z.ZodType<ScreenNode>

function measure(node: ScreenNode, depth: number, acc: { depth: number; nodes: number }) {
  acc.depth = Math.max(acc.depth, depth)
  acc.nodes += 1
  if (node.type === 'page') for (const c of node.children) measure(c, depth + 1, acc)
}

/** A whole screen file: one node, usually a page, nested at most SCREEN_MAX_DEPTH deep. */
export const screenSchema = screenNodeSchema.superRefine((node, ctx) => {
  const acc = { depth: 0, nodes: 0 }
  measure(node, 1, acc)
  if (acc.depth > SCREEN_MAX_DEPTH) {
    ctx.addIssue({ code: 'custom', message: `nested ${acc.depth} deep; at most ${SCREEN_MAX_DEPTH}` })
  }
  if (acc.nodes > SCREEN_MAX_NODES) {
    ctx.addIssue({ code: 'custom', message: `${acc.nodes} elements; at most ${SCREEN_MAX_NODES}` })
  }
})

// Deeper than any valid screen (6 pages of nodes, a few levels inside each), and far
// below what would overflow the stack of the recursive schema check.
const SCREEN_MAX_JSON_DEPTH = 64

/** Depth of a JSON value, iteratively, so a hostile file cannot overflow the stack. */
function jsonDepth(input: unknown, limit: number): number {
  const stack: [unknown, number][] = [[input, 1]]
  let max = 0
  while (stack.length) {
    const [node, depth] = stack.pop()!
    if (depth > max) max = depth
    if (max > limit) return max
    if (node && typeof node === 'object') {
      for (const child of Object.values(node)) stack.push([child, depth + 1])
    }
  }
  return max
}

export function parseScreen(input: unknown): SchemaResult<ScreenNode> {
  if (jsonDepth(input, SCREEN_MAX_JSON_DEPTH) > SCREEN_MAX_JSON_DEPTH) {
    return { ok: false, errors: [`(root): nested too deep (more than ${SCREEN_MAX_JSON_DEPTH} levels of JSON)`] }
  }
  return parseWith(screenSchema, input)
}

/** Every action and screen a description refers to, for the install-time cross-check. */
export function screenReferences(node: ScreenNode): { actions: string[]; screens: string[] } {
  const actions = new Set<string>()
  const screens = new Set<string>()
  const walk = (n: ScreenNode) => {
    switch (n.type) {
      case 'page':
        if (n.source) actions.add(n.source.action)
        n.children.forEach(walk)
        break
      case 'list':
      case 'table':
        actions.add(n.source.action)
        for (const r of n.rowActions ?? []) {
          if (r.action) actions.add(r.action)
          if (r.screen) screens.add(r.screen)
        }
        break
      case 'form':
        actions.add(n.submit.action)
        if (n.resultScreen) screens.add(n.resultScreen)
        break
      case 'button':
        if (n.action) actions.add(n.action)
        if (n.screen) screens.add(n.screen)
        break
    }
  }
  walk(node)
  return { actions: [...actions].sort(), screens: [...screens].sort() }
}
