/**
 * The built-in attack skills' names, shared by the project skill toggles route and the
 * plugin Gateway (`override.get` shows a skill by name). Every skill whose text a plugin
 * may propose (the agent's skill-part registry) must have one.
 *
 * @vitest-environment node
 */
import { describe, test, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'

vi.mock('@/lib/session', () => ({ requireUserAccess: vi.fn(async () => null) }))
vi.mock('@/lib/prisma', () => ({ default: { userAttackSkill: { findMany: vi.fn(async () => []) } } }))

import { BUILT_IN_SKILLS, builtinSkillName } from './builtinSkills'
import { GET } from '@/app/api/users/[id]/attack-skills/available/route'

const REGISTRY = join(__dirname, '../../../agentic/prompts/skill_parts.py')

describe('built-in skill names', () => {
  test('every skill of the agent skill-part registry has a name', () => {
    // Each _SPECS entry starts ("skill_id", "part_id", "module.CONSTANT", ...).
    const specs = readFileSync(REGISTRY, 'utf8').matchAll(/\("([a-z_]+)", "[a-z_]+",\s*"[a-z_]+\.[A-Z_]+"/g)
    const ids = new Set([...specs].map((m) => m[1]))
    expect(ids.size).toBeGreaterThanOrEqual(14)
    for (const id of ids) expect(BUILT_IN_SKILLS.find((s) => s.id === id), id).toBeDefined()
  })

  test('builtinSkillName: the name, or the id for a skill it does not know', () => {
    expect(builtinSkillName('xxe')).toBe('XML External Entity')
    expect(builtinSkillName('no_such_skill')).toBe('no_such_skill')
  })

  test('the toggles route still answers the same list', async () => {
    const res = await GET(new NextRequest('http://localhost/api/users/u1/attack-skills/available'), {
      params: Promise.resolve({ id: 'u1' }),
    })
    expect(await res.json()).toEqual({ builtIn: BUILT_IN_SKILLS, user: [] })
    expect(BUILT_IN_SKILLS.map((s) => s.id)).toEqual([
      'cve_exploit', 'sql_injection', 'xss', 'ssrf', 'rce', 'deserialization', 'path_traversal',
      'access_control', 'http_request_smuggling', 'xxe', 'crypto_attack', 'brute_force_credential_guess',
      'phishing_social_engineering', 'denial_of_service',
    ])
  })
})
