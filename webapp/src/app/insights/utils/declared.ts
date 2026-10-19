/**
 * The subtitle suffix for what only an API specification declares: documented,
 * not observed, so it is named beside a chart rather than drawn as surface.
 */
export function declaredNote(declared: number): string {
  return declared > 0 ? ` · ${declared} more declared in API specifications` : ''
}
