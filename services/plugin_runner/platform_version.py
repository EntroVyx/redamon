"""The plugin platform version this runner image implements (README.PLUGINS.md §11.2).

Must equal PLUGIN_PLATFORM_VERSION in webapp/src/lib/plugins/platformVersion.ts
(webapp/src/lib/plugins/platformVersion.parity.test.ts reads this file as text). A run
list whose platformVersion differs marks the runner out of date and starts no worker.
"""

PLATFORM_VERSION = "1.0.0"
