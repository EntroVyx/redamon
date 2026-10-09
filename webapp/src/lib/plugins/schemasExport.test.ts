/**
 * The committed JSON Schema files are what the plugin repository's CI validates
 * plugins against, so they must match the zod schemas. Fix a failure with
 * `npm run plugins:schemas`.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { SCHEMA_NAMES, exportPluginSchemas, schemaFileText } from './schemas/export'

const DIR = path.join(__dirname, 'schemas/json')

describe('schemas/json', () => {
  const fresh = exportPluginSchemas()

  test.each(SCHEMA_NAMES)('%s.schema.json is up to date', (name) => {
    const committed = readFileSync(path.join(DIR, `${name}.schema.json`), 'utf8')
    expect(committed).toBe(schemaFileText(fresh[name]))
  })

  test('the manifest schema is closed (unknown keys refused) and the catalog schema is open', () => {
    expect(fresh.manifest.additionalProperties).toBe(false)
    expect(fresh.catalog.additionalProperties).toBeUndefined()
  })

  test('each file says it is generated', () => {
    for (const name of SCHEMA_NAMES) expect(String(fresh[name].description)).toMatch(/Do not edit by hand/)
  })
})
