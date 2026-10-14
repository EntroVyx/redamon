/**
 * The manifest's `pick` (platform 1.1.0, schemas/manifest.ts): `pick: "session.skill"` only on
 * a chat action that names an action, and only for a plugin that declares session:read and at
 * least one of override:skill.text / override:user_skill.text; no other value. The 1.0.0
 * Skiller manifest still parses unchanged (plan Phase 2.12). The UI host's contributions
 * (contributions.ts) carry `pick` through for action items only.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { CHAT_ACTION_PICKS, manifestSchema, parseManifest } from './schemas/manifest'
import { rowContributions } from './contributions'
import { echoArchive } from './__testing__/echoArchive'
import { runInstallChecks } from './installChecks'
import { PLUGIN_PLATFORM_VERSION } from './platformVersion'
import skiller100 from './__fixtures__/manifests/skiller.valid.json'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

/** Skiller as 1.1.0 ships it: the improve item asks the session's skill first. */
function skiller110(): Doc {
  const m = clone(skiller100) as Doc
  m.version = '1.1.0'
  m.platform = '>=1.1.0 <2.0.0'
  m.permissions = ['session:read', 'llm:invoke', 'override:skill.text', 'override:user_skill.text']
  m.contributes['chat.session.actions'][0].pick = 'session.skill'
  return m
}

function errors(m: Doc): string {
  const r = parseManifest(m)
  if (r.ok) throw new Error('expected the manifest to be refused')
  return r.errors.join('\n')
}

describe('compatibility', () => {
  test('the 1.0.0 Skiller manifest still parses, into the same object (no pick)', () => {
    const r = parseManifest(clone(skiller100))
    expect(r.ok ? [] : r.errors).toEqual([])
    expect(manifestSchema.parse(clone(skiller100))).toEqual(skiller100)
    expect(JSON.stringify(skiller100)).not.toContain('pick')
  })

  test('the 1.1.0 shape parses and keeps its pick', () => {
    const r = parseManifest(skiller110())
    expect(r.ok ? [] : r.errors).toEqual([])
    expect(manifestSchema.parse(skiller110()).contributes!['chat.session.actions']![0].pick).toBe('session.skill')
  })

  test('the only pick there is: session.skill', () => {
    expect([...CHAT_ACTION_PICKS]).toEqual(['session.skill'])
  })

  test('the committed JSON Schema carries the pick enum', () => {
    const json = readFileSync(path.join(__dirname, 'schemas/json/manifest.schema.json'), 'utf8')
    expect(json).toContain('"session.skill"')
  })
})

describe('the install checks (plan Phase 2.12)', () => {
  // The echo fixture's files under Skiller's manifest: its entry, engine/main.py, is there.
  const checks = (manifest: Doc, platformVersion = PLUGIN_PLATFORM_VERSION) => {
    const a = echoArchive({ top: 'skiller', manifest: { ...manifest, screens: undefined } })
    return runInstallChecks({ pluginId: 'skiller', archiveBytes: a.bytes, release: a.release, platformVersion, maxBytes: 5_000_000 })
  }

  test('this platform is 1.1.0, and the 1.0.0 Skiller still installs on it', () => {
    expect(PLUGIN_PLATFORM_VERSION).toBe('1.1.0')
    const out = checks(clone(skiller100))
    expect(out.ok ? [] : [out.code, out.message, out.details]).toEqual([])
  })

  test('the 1.1.0 Skiller installs on 1.1.0 and is refused by a 1.0.0 platform for its range', () => {
    expect(checks(skiller110()).ok).toBe(true)
    const old = checks(skiller110(), '1.0.0')
    expect(old.ok ? null : old.code).toBe('platform_incompatible')
  })
})

describe('refusals', () => {
  test('a pick on a core screen item', () => {
    const m = skiller110()
    m.contributes['chat.session.actions'][1].pick = 'session.skill'
    expect(errors(m)).toMatch(/contributes\.chat\.session\.actions\.1\.pick: pick goes with an action, not a core screen/)
  })

  test('an unknown pick value, or null', () => {
    for (const value of ['session.target', 'skill', '', null, true]) {
      const m = skiller110()
      m.contributes['chat.session.actions'][0].pick = value
      expect(errors(m), String(value)).toMatch(/chat\.session\.actions\.0\.pick/)
    }
  })

  test('session.skill without session:read', () => {
    const m = skiller110()
    m.permissions = ['llm:invoke', 'override:skill.text', 'override:user_skill.text']
    expect(errors(m)).toMatch(
      /chat\.session\.actions\.0\.pick: session\.skill needs the session:read permission and override:skill\.text or override:user_skill\.text/,
    )
  })

  test('session.skill without any override permission', () => {
    const m = skiller110()
    m.permissions = ['session:read', 'llm:invoke']
    m.contributes['chat.session.actions'].splice(1, 1) // the versions screen needs override:skill.text on its own
    expect(errors(m)).toMatch(/chat\.session\.actions\.0\.pick: session\.skill needs/)
  })

  test('a pick on a project.skills.row item is not a key there', () => {
    const m = skiller110()
    m.contributes['project.skills.row'] = [{ label: 'Improve', action: 'analyze_session', pick: 'session.skill' }]
    expect(errors(m)).toMatch(/project\.skills\.row\.0: Unrecognized key: "pick"/)
  })
})

describe('accepted', () => {
  test('either override permission is enough', () => {
    for (const p of ['override:skill.text', 'override:user_skill.text']) {
      const m = skiller110()
      m.permissions = ['session:read', 'llm:invoke', p]
      if (p !== 'override:skill.text') m.contributes['chat.session.actions'].splice(1, 1)
      const r = parseManifest(m)
      expect(r.ok ? [] : r.errors, p).toEqual([])
    }
  })

  test('pick is optional on any action item', () => {
    const m = skiller110()
    delete m.contributes['chat.session.actions'][0].pick
    expect(parseManifest(m).ok).toBe(true)
  })
})

describe('contributions: pick passes through for action items only', () => {
  const row = (manifest: Doc) => ({
    pluginId: 'skiller', enabled: true, status: 'ready', revokedReason: null, grantedPermissions: [], manifest,
  })

  test('an action item keeps its pick; the core-screen item has none', () => {
    const c = rowContributions(row(skiller110()) as never)!
    expect(c.chatSessionActions).toEqual([
      { key: 'analyze_session', label: 'Improve skill from this session', icon: 'sparkles', action: 'analyze_session', pick: 'session.skill', llm: true, async: true },
      { key: 'skill.text.versions', label: 'Skill versions', icon: 'history', coreScreen: 'skill.text.versions', llm: false, async: false },
    ])
  })

  test('a stored manifest that carries a pick where the schema refuses it, or an unknown one: not passed on', () => {
    const m = skiller110()
    m.contributes['chat.session.actions'][1].pick = 'session.skill'
    m.contributes['chat.session.actions'].push({ label: 'Other', action: 'analyze_session', pick: 'session.target' })
    const items = rowContributions(row(m) as never)!.chatSessionActions
    expect(items[1]).not.toHaveProperty('pick')
    expect(items[2]).not.toHaveProperty('pick')
  })

  test('the 1.0.0 manifest: no item has a pick key', () => {
    for (const item of rowContributions(row(clone(skiller100)) as never)!.chatSessionActions) expect(item).not.toHaveProperty('pick')
  })
})
