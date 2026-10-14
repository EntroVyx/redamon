/**
 * Every route that writes project settings runs the same guards after its own
 * per-field validation. A second writer that skipped one of them would be a way
 * around it, so each caller is held to this module by its source.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'fs'
import path from 'path'

import { describe, test, expect } from 'vitest'

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8')

const CALLERS = {
  'PUT /api/projects/[id]': 'src/app/api/projects/[id]/route.ts',
  'POST and DELETE /api/projects/[id]/roe': 'src/lib/roe/applyRoe.ts',
}

describe('the shared project-write guards', () => {
  test.each(Object.entries(CALLERS))('%s runs guardProjectWrite and recordProjectWrite', (_name, rel) => {
    const source = read(rel)
    expect(source).toMatch(/guardProjectWrite\(/)
    expect(source).toMatch(/recordProjectWrite\(/)
    // Not the pieces directly, which is how one of them gets forgotten.
    expect(source).not.toMatch(/validateJevEngineChange\(/)
    expect(source).not.toMatch(/writeFireteamAudit\(/)
  })

  test('both RoE routes reach applyRoe', () => {
    const route = read('src/app/api/projects/[id]/roe/route.ts')
    expect(route.match(/applyRoe\(/g)?.length).toBe(2)
  })
})
