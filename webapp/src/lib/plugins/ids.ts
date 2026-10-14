/**
 * Plugin ids (README.PLUGINS.md §6.1). An id is also a URL segment beside the
 * platform's own static segments (`/api/plugins/<id>`, `/plugins/<id>`), and Next.js
 * resolves a static folder before the dynamic `[pluginId]` one, so a plugin named
 * after a static segment would be unreachable. Every static folder created at those
 * levels is therefore reserved; pluginIds.test.ts fails when one is missing here.
 */
export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{1,39}$/

export const RESERVED_PLUGIN_IDS: ReadonlySet<string> = new Set([
  'staging',
  'platform',
  'core',
  'redamon',
  'plugins',
  'admin',
  'api',
  'system',
  'internal',
  // Static segments under /api/plugins/
  'status',
  'llm-features',
  'jobs',
  'offline-install',
  'contributions',
  'overrides',
  // Static segments under /plugins/
  'external-link',
])

export function isValidPluginId(id: unknown): id is string {
  return typeof id === 'string' && PLUGIN_ID_RE.test(id) && !RESERVED_PLUGIN_IDS.has(id)
}
