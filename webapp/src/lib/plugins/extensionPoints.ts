import type { PluginPermission } from './permissions'

/**
 * The named slots where a plugin may contribute (README.PLUGINS.md §7.6). UI points
 * are declared under `contributes` in the manifest; the behaviour point `skill.text`
 * is used through the SDK and needs its permission. A new point is a minor platform
 * bump (§11).
 */
export const UI_EXTENSION_POINTS = ['nav', 'chat.session.actions', 'project.skills.row'] as const
export const BEHAVIOUR_EXTENSION_POINTS = ['skill.text'] as const

export type UiExtensionPoint = (typeof UI_EXTENSION_POINTS)[number]
export type BehaviourExtensionPoint = (typeof BEHAVIOUR_EXTENSION_POINTS)[number]
export type ExtensionPoint = UiExtensionPoint | BehaviourExtensionPoint

export const POINT_PERMISSION: Record<BehaviourExtensionPoint, PluginPermission> = {
  'skill.text': 'override:skill.text',
}

/**
 * Screens the platform draws itself and a plugin may only open: approval, versions
 * and reset are core UI, so they keep working when the plugin is disabled or gone
 * (design principle 5).
 */
export const CORE_SCREENS = ['skill.text.versions'] as const
export type CoreScreen = (typeof CORE_SCREENS)[number]

export const CORE_SCREEN_POINT: Record<CoreScreen, BehaviourExtensionPoint> = {
  'skill.text.versions': 'skill.text',
}

/**
 * Icons a contribution may name. A fixed list, so a plugin button cannot borrow a core
 * icon's look; the UI host maps each name to a lucide-react component.
 */
export const PLUGIN_ICON_NAMES = [
  'puzzle', 'sparkles', 'history', 'list', 'file-text', 'settings', 'play', 'search', 'shield',
  'book-open', 'bot', 'bug', 'clock', 'database', 'star', 'target', 'zap',
] as const
export type PluginIconName = (typeof PLUGIN_ICON_NAMES)[number]
