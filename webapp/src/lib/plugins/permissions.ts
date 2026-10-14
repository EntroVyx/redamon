/**
 * What a plugin may ask for (README.PLUGINS.md §10). The admin grants these at install
 * from the consent text below; a capability missing from the manifest is one the
 * plugin does not have. `sdk.data.*` needs no permission: every plugin may keep its
 * own data.
 */
export const PLUGIN_PERMISSIONS = ['session:read', 'llm:invoke', 'override:skill.text', 'override:user_skill.text'] as const

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
  'override:user_skill.text': {
    title: 'Propose versions of your own skills',
    consent:
      'Propose new versions of your own agent skills from the sessions that used them. A ' +
      'person reviews each one; saving creates a new skill and never changes the original. ' +
      "The plugin reads the text of the skills its session used and sends it to the model " +
      'chosen for it; a skill holding a key or token (a private key, a JWT, an API token) is never given to it.',
  },
}

export function isPluginPermission(p: unknown): p is PluginPermission {
  return typeof p === 'string' && (PLUGIN_PERMISSIONS as readonly string[]).includes(p)
}
