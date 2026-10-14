/**
 * Taking a RoE replace's saved row into an open settings form.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'

import { mergeServerRow } from './mergeServerRow'

describe('mergeServerRow', () => {
  const baseline: Record<string, unknown> = { roeGlobalMaxRps: 0, katanaDepth: 2, naabuRateLimit: 100, roeRawText: 'A' }

  test('a column the RoE changed takes the saved value in both, so it is no longer dirty', () => {
    const form = { ...baseline }
    const out = mergeServerRow(form, baseline, { ...baseline, roeGlobalMaxRps: 5, roeRawText: 'B' }, ['roeGlobalMaxRps'])
    expect(out.form.roeGlobalMaxRps).toBe(5)
    expect(out.baseline.roeGlobalMaxRps).toBe(5)
    expect(out.form.roeRawText).toBe('B')
  })

  test('an unsaved edit the RoE did not touch stays unsaved', () => {
    const form = { ...baseline, katanaDepth: 4 }
    const out = mergeServerRow(form, baseline, { ...baseline, roeGlobalMaxRps: 5 }, ['roeGlobalMaxRps'])
    expect(out.form.katanaDepth).toBe(4)
    expect(out.baseline.katanaDepth).toBe(2)
  })

  test('an unsaved edit the RoE overwrote takes the RoE value (the review listed it as a conflict)', () => {
    const form = { ...baseline, naabuRateLimit: 7 }
    const out = mergeServerRow(form, baseline, { ...baseline, naabuRateLimit: 10 }, ['naabuRateLimit'])
    expect(out.form.naabuRateLimit).toBe(10)
  })

  test('another writer\'s change to an untouched column is taken, not reverted later', () => {
    const form = { ...baseline }
    const out = mergeServerRow(form, baseline, { ...baseline, katanaDepth: 3 }, [])
    expect(out.form.katanaDepth).toBe(3)
  })

  test('a column the form does not know is not added, unless the RoE wrote it', () => {
    const out = mergeServerRow({ ...baseline }, baseline, { ...baseline, roeEnabled: true, roeParsedJson: { version: 2 } }, [])
    expect(out.form).not.toHaveProperty('roeEnabled')
    expect(out.form.roeParsedJson).toEqual({ version: 2 })
  })
})
