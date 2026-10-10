/**
 * The icon allowlist: a contribution may name only an icon on the list, and anything else
 * (an unknown name, empty, null) falls back to Puzzle, so a plugin button can never borrow a
 * core icon's look by naming it (design §6, the "spoofing core UI" control).
 */
import { describe, test, expect } from 'vitest'
import { Puzzle, Sparkles } from 'lucide-react'
import { pluginIcon } from './pluginIcons'
import { PLUGIN_ICON_NAMES } from '@/lib/plugins/extensionPoints'

describe('pluginIcon', () => {
  test('a name on the list resolves to its component', () => {
    expect(pluginIcon('sparkles')).toBe(Sparkles)
  })

  test('every allowlisted name maps to a defined component', () => {
    for (const name of PLUGIN_ICON_NAMES) {
      expect(pluginIcon(name)).toBeTypeOf('object')
      expect(pluginIcon(name)).not.toBe(undefined)
    }
  })

  test('an unknown name falls back to Puzzle', () => {
    expect(pluginIcon('definitely-not-an-icon')).toBe(Puzzle)
  })

  test('a core icon name not on the list still falls back to Puzzle', () => {
    // "swords" is the Agent Skills icon; it is not in PLUGIN_ICON_NAMES.
    expect(pluginIcon('swords')).toBe(Puzzle)
  })

  test('null and undefined fall back to Puzzle', () => {
    expect(pluginIcon(null)).toBe(Puzzle)
    expect(pluginIcon(undefined)).toBe(Puzzle)
  })
})
