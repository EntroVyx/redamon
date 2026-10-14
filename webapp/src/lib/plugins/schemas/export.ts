import { z } from 'zod'
import { manifestSchema } from './manifest'
import { screenSchema } from './screen'
import { catalogSchema } from './catalog'
import { PLUGIN_PLATFORM_VERSION } from '../platformVersion'

/**
 * The JSON Schema form of the contracts, committed under schemas/json/ for the plugin
 * repository's CI (`npm run plugins:schemas` rewrites them; a vitest fails when they
 * are out of date). Cross-field rules (an action a contribution names must exist, the
 * nesting depth of a screen) do not translate to JSON Schema: the platform's zod check
 * at install remains the authority.
 *
 * The files are read by two regex engines: JavaScript's (ECMA-262, what JSON Schema
 * specifies) and Python's `re` in the plugin repository's CI. Every pattern is
 * therefore written out in a form both read alike (portablePattern).
 */
export const SCHEMA_NAMES = ['manifest', 'screen', 'catalog'] as const
export type SchemaName = (typeof SCHEMA_NAMES)[number]

const SOURCES: Record<SchemaName, { schema: z.ZodType; title: string }> = {
  manifest: { schema: manifestSchema, title: 'RedAmon plugin manifest (plugin.json)' },
  screen: { schema: screenSchema, title: 'RedAmon plugin screen description' },
  catalog: { schema: catalogSchema, title: 'RedAmon plugin catalog (catalog.json)' },
}

/**
 * Rewrites a regex so JavaScript and Python's `re.search` accept the same strings:
 * every end-of-string `$` becomes `(?!\n)$` (Python's `$` also matches before a final
 * newline), and `\d` becomes `0-9` (Python's matches any Unicode digit).
 */
export function portablePattern(pattern: string): string {
  let out = ''
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      const next = pattern[i + 1]
      out += next === 'd' ? (inClass ? '0-9' : '[0-9]') : c + (next ?? '')
      i++
    } else if (inClass) {
      if (c === ']') inClass = false
      out += c
    } else if (c === '[') {
      inClass = true
      out += c
    } else if (c === '$' && !out.endsWith('(?!\\n)')) {
      out += '(?!\\n)$'
    } else {
      out += c
    }
  }
  return out
}

function portable(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(portable)
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, k === 'pattern' && typeof v === 'string' ? portablePattern(v) : portable(v)]),
    )
  }
  return node
}

export function exportPluginSchemas(): Record<SchemaName, Record<string, unknown>> {
  const out = {} as Record<SchemaName, Record<string, unknown>>
  for (const name of SCHEMA_NAMES) {
    // `input`: the files describe what a plugin author writes, before defaults apply.
    const json = portable(z.toJSONSchema(SOURCES[name].schema, { io: 'input' })) as Record<string, unknown>
    out[name] = {
      ...json,
      title: SOURCES[name].title,
      description: `Generated from webapp/src/lib/plugins/schemas/${name}.ts for platform ${PLUGIN_PLATFORM_VERSION}. Do not edit by hand.`,
    }
  }
  return out
}

export function schemaFileText(json: Record<string, unknown>): string {
  return JSON.stringify(json, null, 2) + '\n'
}
