/**
 * Writes the JSON Schema files of the plugin contracts, which the plugin repository's
 * CI validates plugins against. Run after changing a schema: `npm run plugins:schemas`.
 */
import { writeFileSync } from 'fs'
import path from 'path'
import { SCHEMA_NAMES, exportPluginSchemas, schemaFileText } from '../src/lib/plugins/schemas/export'

const dir = path.resolve(__dirname, '../src/lib/plugins/schemas/json')
const schemas = exportPluginSchemas()
for (const name of SCHEMA_NAMES) {
  const file = path.join(dir, `${name}.schema.json`)
  writeFileSync(file, schemaFileText(schemas[name]))
  console.log(`wrote ${path.relative(process.cwd(), file)}`)
}
