/**
 * What a plugin may ask for (README.PLUGINS.md §10). The admin grants these at install
 * from the consent text below; a capability missing from the manifest is one the
 * plugin does not have. `sdk.data.*` needs no permission: every plugin may keep its
 * own data.
 */
export const PLUGIN_PERMISSIONS = ['session:read', 'llm:invoke', 'override:skill.text'] as const

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

export interface PermissionText {
  title: string
  consent: string
}

// The consent text says plainly what the code will see or do, because the admin
// grants it once for every user of the instance.
export const PERMISSION_TEXT: Record<PluginPermission, PermissionText> = {
  'session:read': {
    title: 'Read chat sessions',
    consent:
      'Reads the agent chat sessions it is run on, including the target data in them: ' +
      'hostnames, addresses, findings, tool output and the messages you wrote. The ' +
      "plugin's code sees this data while it works.",
  },
  'llm:invoke': {
    title: 'Use a language model',
    consent:
      'Sends prompts to a language model through RedAmon, using the model each user picks ' +
      'for this plugin in Models by feature. The calls use that user\'s provider account ' +
      'and count towards a daily limit.',
  },
  'override:skill.text': {
    title: 'Propose agent instructions',
    consent:
      "Proposes new text for the agent's built-in skills. A proposal changes nothing until " +
      'a person reviews the difference and approves it; approved text can be reset to the ' +
      'factory version at any time.',
  },
}

export function isPluginPermission(p: unknown): p is PluginPermission {
  return typeof p === 'string' && (PLUGIN_PERMISSIONS as readonly string[]).includes(p)
}
