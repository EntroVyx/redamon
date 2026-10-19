/**
 * Cypher, true for an Endpoint known only from an API specification: documented,
 * not observed by any tool. A node an earlier release declared
 * (`openapi_declared` without `openapi_declared_only`) counts as declared-only,
 * so an unknown case is never shown as observed. The same predicate recon uses
 * (`recon/partial_recon_modules/graph_builders.py`, DECLARED_ONLY).
 */
export function DECLARED_ONLY(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error(`not a Cypher variable: ${alias}`)
  return `coalesce(${alias}.openapi_declared_only, ${alias}.openapi_declared, false)`
}
