"""The container's health probe: `python -m supervisor.healthcheck`.

There is no unauthenticated route, so the probe reads the runner key from its own
environment and calls /runner/v1/health on loopback. Exit 0 on HTTP 200 whatever the
reported state: an out-of-date runner is shown by /api/plugins/status, and restarting it
in a loop would change nothing. Never prints the key.
"""

import os
import sys
import urllib.error
import urllib.request


def main() -> int:
    key = (os.environ.get("PLUGIN_RUNNER_KEY") or "").strip()
    port = os.environ.get("PLUGIN_RUNNER_PORT") or "7080"
    if not key:
        sys.stderr.write("healthcheck: PLUGIN_RUNNER_KEY is not set\n")
        return 1
    req = urllib.request.Request(f"http://127.0.0.1:{port}/runner/v1/health",
                                 headers={"X-Plugin-Runner-Key": key})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=4) as resp:
            return 0 if resp.status == 200 else 1
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"healthcheck: HTTP {e.code}\n")
    except (OSError, ValueError) as e:
        sys.stderr.write(f"healthcheck: {type(e).__name__}\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
