/**
 * Project export and import leave plugin rows out, and say so (OQ-18, X25). A project-scope
 * skill version or a project-owned plugin data row belongs to a plugin installation: moving it
 * to another instance would need the same plugin installed there, and an import gives the
 * project a new id and owner anyway. The export manifest names what it left out; the import
 * reads only the files it knows, so a plugin file added to an archive by hand is never read,
 * and the result says so.
 */
export const PROJECT_EXPORT_EXCLUDED = ['plugin_overrides', 'plugin_data'] as const

export const PROJECT_EXPORT_EXCLUDED_REASON =
  'Plugin skill versions and plugin data belong to a plugin installation and are not part of a project export.'

/** An archive entry that looks like plugin rows: worth a warning, never read. */
export function isPluginArchivePath(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('plugins/') || lower.startsWith('plugin/') || /(^|\/)plugin[_-]?(overrides?|data)\b/.test(lower)
}
