/**
 * openapiDiscoveryPaths holds origin-relative paths that recon requests on
 * every in-scope origin when OpenAPI auto-discovery is on.
 *
 * It was declared `free_text`, so an MCP write could store an entry the scan
 * would refuse, and one such entry made the runtime drop the WHOLE list. The
 * write now refuses the entry by name; the runtime skips a bad entry on its own.
 *
 * @vitest-environment node
 */
import { describe, test, expect, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ default: {} }))

import { filterReconSettings } from './filter'
import { field } from './registry'

const write = (value: unknown) =>
  filterReconSettings({ openapiDiscoveryPaths: value }, { mode: 'update' })

describe('OpenAPI discovery paths are origin-relative paths only', () => {
  test('it is declared a URL path list, still never parsed from an RoE document', () => {
    const spec = field('openapiDiscoveryPaths')!
    expect(spec.validator).toBe('url_path_list')
    expect(spec.roe_parse).toBe('deny')
  })

  test('the shipped defaults and an empty list are accepted', () => {
    expect(write(['/openapi.json', '/v3/api-docs', '/api-docs/', '/swagger-ui/index.html']).ok).toBe(true)
    expect(write([]).ok).toBe(true)
  })

  test.each([
    ['openapi.json'],
    ['//attacker.example/spec'],
    ['/spec?token=x'],
    ['/spec#frag'],
    ['/a b'],
    ['/a\tb'],
    ['/a\\b'],
    ['/' + 'a'.repeat(2048)],
  ])('%j is refused', (path) => {
    const r = write(['/openapi.json', path])
    expect(r.ok).toBe(false)
  })

  test('more than 200 paths are refused', () => {
    expect(write(Array.from({ length: 200 }, (_, i) => `/p${i}`)).ok).toBe(true)
    expect(write(Array.from({ length: 201 }, (_, i) => `/p${i}`)).ok).toBe(false)
  })

  test('a non-list is refused', () => {
    expect(write('/openapi.json').ok).toBe(false)
  })
})
