type Settings = Record<string, unknown>

function isRecord(value: unknown): value is Settings {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username && !url.password && !url.hash
  } catch {
    return false
  }
}

const SOURCE_FIELDS = ['id', 'url', 'serverOverride', 'enabled'] as const

export function validateOpenApiSettings(settings: Settings): string | null {
  if ('openapiEnabled' in settings && typeof settings.openapiEnabled !== 'boolean') {
    return 'openapiEnabled must be a boolean'
  }
  if ('openapiAutoDiscover' in settings && typeof settings.openapiAutoDiscover !== 'boolean') {
    return 'openapiAutoDiscover must be a boolean'
  }
  if ('openapiTimeout' in settings
      && (!Number.isInteger(settings.openapiTimeout) || (settings.openapiTimeout as number) < 1
        || (settings.openapiTimeout as number) > 60)) {
    return 'openapiTimeout must be an integer between 1 and 60'
  }
  if ('openapiMaxDocuments' in settings
      && (!Number.isInteger(settings.openapiMaxDocuments) || (settings.openapiMaxDocuments as number) < 1
        || (settings.openapiMaxDocuments as number) > 200)) {
    return 'openapiMaxDocuments must be an integer between 1 and 200'
  }

  if ('openapiDiscoveryPaths' in settings) {
    const paths = settings.openapiDiscoveryPaths
    if (!Array.isArray(paths) || paths.length > 200 || paths.some(path =>
      typeof path !== 'string' || path.length > 2048 || !path.startsWith('/')
      || path.startsWith('//') || /[\s\x00-\x1f\x7f\\?#]/.test(path))) {
      return 'openapiDiscoveryPaths must contain at most 200 origin-relative paths without queries or fragments'
    }
  }
  if ('openapiSources' in settings) {
    if (!Array.isArray(settings.openapiSources)) return 'openapiSources must be an array'
    const sourceIds = new Set<string>()
    for (let index = 0; index < settings.openapiSources.length; index += 1) {
      const source = settings.openapiSources[index]
      const field = `openapiSources[${index}]`
      if (!isRecord(source) || !isHttpUrl(source.url)) {
        return `${field}.url must be an absolute HTTP(S) URL`
      }
      if ('id' in source && source.id !== undefined) {
        if (typeof source.id !== 'string' || !source.id.trim() || source.id.length > 128) {
          return `${field}.id must be a non-empty string of at most 128 characters`
        }
        if (sourceIds.has(source.id)) return `${field}.id must be unique`
        sourceIds.add(source.id)
      }
      if ('serverOverride' in source && source.serverOverride !== undefined
          && !isHttpUrl(source.serverOverride)) {
        return `${field}.serverOverride must be an absolute HTTP(S) URL`
      }
      if (typeof source.serverOverride === 'string' && new URL(source.serverOverride).search) {
        return `${field}.serverOverride must be an absolute HTTP(S) URL without a query`
      }
      if ('enabled' in source && source.enabled !== undefined && typeof source.enabled !== 'boolean') {
        return `${field}.enabled must be a boolean`
      }
    }
  }

  return null
}

export function normalizeOpenApiSourceIds(
  value: unknown,
  createId: () => string = () => crypto.randomUUID(),
): unknown {
  if (!Array.isArray(value)) return value
  return value.map(source => (
    isRecord(source) && source.id === undefined
      ? { ...source, id: createId() }
      : source
  ))
}

/**
 * Sources as they are stored: a row the form left blank is dropped rather than
 * refused, and a source keeps only its four fields, so nothing else written
 * with it (a header, a note) is stored, exported or read back.
 */
export function cleanOpenApiSources(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value
    .filter(source => !(isRecord(source) && (source.url === undefined || source.url === null
      || (typeof source.url === 'string' && !source.url.trim()))))
    .map(source => isRecord(source)
      ? Object.fromEntries(SOURCE_FIELDS.filter(key => source[key] !== undefined).map(key => [key, source[key]]))
      : source)
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : undefined
}

/**
 * Make an imported project's OpenAPI columns storable, in place. A bundle is
 * untrusted and may be old, so an import never fails on one bad row: a source
 * keeps only its four fields and is dropped when it is invalid, a missing or
 * repeated id is minted, a discovery path that breaks the rules is
 * dropped, numbers are clamped to their bounds, and a flag that is not a
 * boolean is removed so the column default applies.
 */
export function sanitizeImportedOpenApiSettings(
  settings: Settings,
  createId: () => string = () => crypto.randomUUID(),
): void {
  for (const flag of ['openapiEnabled', 'openapiAutoDiscover']) {
    if (flag in settings && typeof settings[flag] !== 'boolean') delete settings[flag]
  }
  for (const [key, min, max] of [['openapiTimeout', 1, 60], ['openapiMaxDocuments', 1, 200]] as const) {
    if (!(key in settings)) continue
    const clamped = clampInt(settings[key], min, max)
    if (clamped === undefined) delete settings[key]
    else settings[key] = clamped
  }
  if ('openapiDiscoveryPaths' in settings) {
    const paths = Array.isArray(settings.openapiDiscoveryPaths) ? settings.openapiDiscoveryPaths : []
    settings.openapiDiscoveryPaths = paths
      .filter(path => validateOpenApiSettings({ openapiDiscoveryPaths: [path] }) === null)
      .slice(0, 200)
  }
  if ('openapiSources' in settings) {
    const seen = new Set<string>()
    const kept: Settings[] = []
    for (const source of Array.isArray(settings.openapiSources) ? settings.openapiSources : []) {
      if (!isRecord(source)) continue
      const clean: Settings = Object.fromEntries(
        SOURCE_FIELDS.filter(key => source[key] !== undefined).map(key => [key, source[key]]))
      if (typeof clean.id !== 'string' || seen.has(clean.id)) clean.id = createId()
      if (validateOpenApiSettings({ openapiSources: [clean] }) !== null) continue
      seen.add(clean.id as string)
      kept.push(clean)
    }
    settings.openapiSources = kept
  }
}
