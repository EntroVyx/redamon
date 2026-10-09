"""The proxy's health probe: `python -m gateway_proxy.healthcheck` opens a TCP connection
to both listeners on loopback; exit 0 only when both accept."""

import os
import socket
import sys


def main() -> int:
    ports = (int(os.environ.get("PLUGIN_PROXY_GATEWAY_PORT") or 7071),
             int(os.environ.get("PLUGIN_PROXY_RUNNER_PORT") or 7072))
    for port in ports:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=3):
                pass
        except OSError:
            sys.stderr.write(f"healthcheck: port {port} is not accepting connections\n")
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
