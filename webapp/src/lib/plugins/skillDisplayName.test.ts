/**
 * The name the Gateway shows for a built-in skill (`override.get` displayName) comes from
 * the chat drawer's per-skill config, a layer every built-in skill already fills
 * (KNOWN_ATTACK_PATH_CONFIG; the agent's per-skill tests check it). Every skill whose text a
 * plugin may propose (the agent's skill-part registry) must have one.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { skillDisplayName } from './overrideOps'

const REGISTRY = join(__dirname, '../../../../agentic/prompts/skill_parts.py')

describe('skillDisplayName', () => {
  test('every skill of the agent skill-part registry has a name', () => {
    // Each _SPECS entry starts ("skill_id", "part_id", "module.CONSTANT", ...).
    const specs = readFileSync(REGISTRY, 'utf8').matchAll(/\("([a-z_]+)", "[a-z_]+",\s*"[a-z_]+\.[A-Z_]+"/g)
    const ids = new Set([...specs].map((m) => m[1]))
    expect(ids.size).toBeGreaterThanOrEqual(14)
    for (const id of ids) expect(skillDisplayName(id), id).not.toBe(id)
  })

  test('the name, or the id for a skill it does not know', () => {
    expect(skillDisplayName('xxe')).toBe('XML External Entity')
    expect(skillDisplayName('path_traversal')).toBe('Path Traversal / LFI / RFI')
    expect(skillDisplayName('no_such_skill')).toBe('no_such_skill')
  })
})
