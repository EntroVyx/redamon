"""RedAmon plugin SDK: what plugin code imports (README.PLUGINS.md §7.3, §7.7).

An action is `async def run(ctx, params) -> dict`; `ctx.sdk` makes every Gateway call,
each awaited. Standard library only: workers start with `python -I -S` and see no
site-packages, so a plugin's own pure-Python dependencies go in its `vendor/` folder.
"""

from .client import GatewayTransport, Sdk
from .context import Context
from .errors import PluginError

# The platform contract this copy of the SDK implements; equal to the runner's
# services/plugin_runner/platform_version.py (tests/test_sdk_contract.py).
PLATFORM_VERSION = "1.0.0"

__all__ = ["Context", "GatewayTransport", "PLATFORM_VERSION", "PluginError", "Sdk"]
