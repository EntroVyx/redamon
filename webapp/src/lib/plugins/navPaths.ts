import { SCREEN_PATH_RE } from './schemas/common'

/**
 * A plugin page's URL names a screen file without its `ui/` folder and `.json`:
 * `/plugins/echo/forms/new-item` is `ui/forms/new-item.json`. Segments use the screen-path
 * alphabet only, so a URL can never reach outside `ui/`.
 */
const SEGMENT_RE = /^[a-z0-9_-]+$/

export function screenPathFromSegments(segments: readonly string[]): string | null {
  if (segments.length === 0 || !segments.every((s) => SEGMENT_RE.test(s))) return null
  const screenPath = `ui/${segments.join('/')}.json`
  return SCREEN_PATH_RE.test(screenPath) ? screenPath : null
}

export function screenUrl(pluginId: string, screenPath: string): string {
  return `/plugins/${pluginId}/${screenPath.replace(/^ui\//, '').replace(/\.json$/, '')}`
}
