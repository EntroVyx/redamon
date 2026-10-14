import type { z } from 'zod'

/** An action id, as declared in the manifest and named by screens. */
export const ACTION_ID_RE = /^[a-z][a-z0-9_]{1,39}$/

/** A screen description file inside the plugin folder. */
export const SCREEN_PATH_RE = /^ui(\/[a-z0-9_-]+)+\.json$/

export type SchemaResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

/** One readable line per problem, `path: message`, for the install refusal and CI. */
export function formatSchemaIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.join('.') : '(root)'
    return `${where}: ${issue.message}`
  })
}

export function parseWith<T>(schema: z.ZodType<T>, input: unknown): SchemaResult<T> {
  const r = schema.safeParse(input)
  return r.success ? { ok: true, value: r.data } : { ok: false, errors: formatSchemaIssues(r.error) }
}
