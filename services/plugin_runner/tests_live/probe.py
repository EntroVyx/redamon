"""Isolation probe, run INSIDE the plugin-runner or plugin-gateway container by
tests/plugins_isolation_live.sh (standard library only, `python -I -S -`).

Each check prints one JSON line {check, ok, detail}. ok=false is a leak: something plugin
code could reach or read that the design forbids (master plan TD-05, experiments E1/E2).

    python -I -S - --role runner|gateway [--host-gateway ADDR]... [--worker-uid UID]...
"""

import argparse
import errno
import json
import os
import socket
import urllib.error
import urllib.request

# A connect that times out or finds no route is isolation; ECONNREFUSED means a host
# stack answered, so the address is reachable (experiment E1 found exactly that).
BLOCKED_ERRNOS = {errno.ENETUNREACH, errno.EHOSTUNREACH, errno.ETIMEDOUT}


def report(check, ok, detail=""):
    print(json.dumps({"check": check, "ok": bool(ok), "detail": str(detail)[:300]}), flush=True)


def connect(host, port, timeout=3.0):
    """'dns' / 'blocked' / 'refused' / 'open' / 'error:<errno>'."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return "dns"
    family, kind, proto, _, addr = infos[0]
    s = socket.socket(family, kind, proto)
    s.settimeout(timeout)
    try:
        s.connect(addr)
        return "open"
    except socket.timeout:
        return "blocked"
    except OSError as e:
        if e.errno in BLOCKED_ERRNOS:
            return "blocked"
        if e.errno == errno.ECONNREFUSED:
            return "refused"
        return f"error:{e.errno}"
    finally:
        s.close()


def must_not_reach(check, host, port):
    r = connect(host, port)
    report(check, r in ("dns", "blocked") or r.startswith("error:"), f"{host}:{port} -> {r}")


def http_status(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {}, method="GET")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=5) as resp:
            return resp.status, resp.read(300).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(300).decode("utf-8", "replace")
    except OSError as e:
        return None, type(e).__name__


def unreadable(check, path):
    try:
        with open(path, "rb") as f:
            f.read(64)
    except OSError as e:
        report(check, True, f"{path}: {errno.errorcode.get(e.errno, e.errno)}")
        return
    report(check, False, f"{path} is readable")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--role", choices=("runner", "gateway"), required=True)
    p.add_argument("--host-gateway", action="append", default=[])
    p.add_argument("--worker-pid", action="append", type=int, default=[])
    a = p.parse_args()
    report("whoami", True, f"uid={os.getuid()} gid={os.getgid()} role={a.role}")

    # The internet and public DNS.
    for host, port in (("1.1.1.1", 443), ("8.8.8.8", 53), ("example.com", 443)):
        must_not_reach(f"internet {host}:{port}", host, port)

    # The stack's services on the shared redamon network.
    for host, port in (("postgres", 5432), ("neo4j", 7687), ("agent", 8080), ("kali-sandbox", 8000),
                       ("recon-orchestrator", 8010), ("redamon-postgres", 5432)):
        must_not_reach(f"service {host}:{port}", host, port)

    # The host itself, through each plugin network's bridge address (gateway_mode_ipv4).
    for gw in a.host_gateway:
        for port in (22, 80, 443, 3000, 5432, 8090):
            must_not_reach(f"host {gw}:{port}", gw, port)

    if a.role == "runner":
        # Only through the proxy, and only the plugin prefixes.
        must_not_reach("webapp direct", "webapp", 3000)
        status, body = http_status("http://plugin-gateway:7071/api/projects")
        report("proxy refuses /api/projects", status == 404 and "plugin gateway proxy" in body,
               f"HTTP {status} {body[:80]}")
        status, body = http_status("http://plugin-gateway:7071/api/plugin-runner/v1/run-list")
        report("proxy passes the run list (the webapp answers)", status in (401, 404, 503),
               f"HTTP {status} {body[:80]}")
        try:
            with open("/plugins/.isolation-probe", "w") as f:
                f.write("x")
            report("plugins volume not writable", False, "wrote /plugins/.isolation-probe")
        except OSError as e:
            report("plugins volume not writable", True, errno.errorcode.get(e.errno, e.errno))
        unreadable("pid 1 environment", "/proc/1/environ")
        for pid in a.worker_pid:
            unreadable(f"worker {pid} environment", f"/proc/{pid}/environ")
            unreadable(f"worker {pid} memory", f"/proc/{pid}/mem")
    else:
        status, _ = http_status("http://webapp:3000/api/health")
        report("the proxy reaches the webapp on plugins-edge", status == 200, f"HTTP {status}")


if __name__ == "__main__":
    main()
