/**
 * The `echo` fixture plugin (services/plugin_runner/tests/fixtures/plugins/echo) is the
 * platform's test plugin: the runner's tests execute it and later phases install it as
 * an archive. It must therefore pass the same checks a real plugin meets at install.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseManifest } from './schemas/manifest'
import { parseScreen, screenReferences } from './schemas/screen'
import { PLUGIN_PERMISSIONS } from './permissions'
import { UI_EXTENSION_POINTS } from './extensionPoints'

const ECHO = join(__dirname, '../../../../services/plugin_runner/tests/fixtures/plugins/echo')
const raw = JSON.parse(readFileSync(join(ECHO, 'plugin.json'), 'utf8'))

describe('the echo fixture plugin', () => {
  test('its manifest passes the install-time schema', () => {
    const parsed = parseManifest(raw)
    expect(parsed).toEqual({ ok: true, value: expect.anything() })
  })

  test('it declares every permission and every UI extension point', () => {
    expect([...raw.permissions].sort()).toEqual([...PLUGIN_PERMISSIONS].sort())
    expect(Object.keys(raw.contributes).sort()).toEqual([...UI_EXTENSION_POINTS].sort())
    const chat = raw.contributes['chat.session.actions']
    expect(chat.some((c: { action?: string }) => c.action)).toBe(true)
    expect(chat.some((c: { coreScreen?: string }) => c.coreScreen)).toBe(true)
  })

  test('every action entry names an existing file and function', () => {
    for (const a of raw.actions as { id: string; entry: string }[]) {
      const [file, fn] = a.entry.split(':')
      const path = join(ECHO, file)
      expect(existsSync(path), `${a.id}: ${file}`).toBe(true)
      expect(readFileSync(path, 'utf8'), `${a.id}: ${fn}`).toMatch(new RegExp(`^(async )?def ${fn}\\(`, 'm'))
    }
  })

  test('one action is async, for the job paths', () => {
    expect(raw.actions.filter((a: { async?: boolean }) => a.async).map((a: { id: string }) => a.id)).toEqual(['sleep'])
  })

  test('its screens parse and call only declared actions', () => {
    const declared = new Set((raw.actions as { id: string }[]).map((a) => a.id))
    const screens = new Set<string>([...raw.screens, raw.contributes.nav.screen])
    for (const s of screens) {
      const parsed = parseScreen(JSON.parse(readFileSync(join(ECHO, s), 'utf8')))
      expect(parsed.ok, s).toBe(true)
      if (!parsed.ok) continue
      const refs = screenReferences(parsed.value)
      for (const action of refs.actions) expect(declared.has(action), `${s} calls ${action}`).toBe(true)
      for (const screen of refs.screens) expect(screens.has(screen), `${s} opens ${screen}`).toBe(true)
    }
  })
})
