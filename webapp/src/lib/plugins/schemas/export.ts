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
 */
export const SCHEMA_NAMES = ['manifest', 'screen', 'catalog'] as const
export type SchemaName = (typeof SCHEMA_NAMES)[number]

const SOURCES: Record<SchemaName, { schema: z.ZodType; title: string }> = {
  manifest: { schema: manifestSchema, title: 'RedAmon plugin manifest (plugin.json)' },
  screen: { schema: screenSchema, title: 'RedAmon plugin screen description' },
  catalog: { schema: catalogSchema, title: 'RedAmon plugin catalog (catalog.json)' },
}

export function exportPluginSchemas(): Record<SchemaName, Record<string, unknown>> {
  const out = {} as Record<SchemaName, Record<string, unknown>>
  for (const name of SCHEMA_NAMES) {
    // `input`: the files describe what a plugin author writes, before defaults apply.
    const json = z.toJSONSchema(SOURCES[name].schema, { io: 'input' }) as Record<string, unknown>
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
