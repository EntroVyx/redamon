import { deepEqual } from '@/lib/deepEqual'

/** The document columns the RoE route writes on every replace or remove. */
const ROE_ARTEFACTS = ['roeDocumentName', 'roeDocumentMimeType', 'roeRawText', 'roeParsedJson']

/**
 * Merge the row a RoE replace saved into an open settings form.
 *
 * The baseline takes every column the form knows, because it is what the server
 * now holds. The form takes the columns the RoE changed, and every other column
 * the person had not edited; an unsaved edit elsewhere stays an unsaved edit.
 * Without this the next whole-row save PUT the pre-replace values back.
 */
export function mergeServerRow<T extends Record<string, unknown>>(
  form: T,
  baseline: T,
  row: Record<string, unknown>,
  changedKeys: Iterable<string>,
): { form: T; baseline: T } {
  const changed = new Set([...changedKeys, ...ROE_ARTEFACTS])
  const nextForm: Record<string, unknown> = { ...form }
  const nextBaseline: Record<string, unknown> = { ...baseline }
  for (const [key, value] of Object.entries(row)) {
    const known = key in form || key in baseline
    if (!known && !changed.has(key)) continue
    if (changed.has(key) || deepEqual(form[key], baseline[key])) nextForm[key] = value
    nextBaseline[key] = value
  }
  return { form: nextForm as T, baseline: nextBaseline as T }
}
