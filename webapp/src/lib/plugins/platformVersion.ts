/**
 * The plugin platform's public API version (README.PLUGINS.md §11): the SDK, the
 * Gateway API, the extension points, the UI primitives and the manifest and screen
 * schemas. Adding one of them is a minor bump; changing or removing one is a major
 * bump, and every plugin whose `platform` range excludes the new value becomes
 * incompatible. The runner image reports the version it was built with and must match.
 */
export const PLUGIN_PLATFORM_VERSION = '1.0.0'
