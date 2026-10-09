#!/usr/bin/env bash
# =============================================================================
# LIVE isolation probe of the plugin runner and the plugin-gateway proxy
# (master plan step 3.8, TD-05, experiments E1/E2). Not part of the gate: it needs
# the platform running (PLUGINS_ENABLED=true and ./redamon.sh up).
# Run:  bash tests/plugins_isolation_live.sh
#
# Starts nothing. Runs services/plugin_runner/tests_live/probe.py inside the
# runner under a worker-range UID, and inside the proxy, and fails on any leak:
# the internet, the stack's services (Postgres, Neo4j, agent, kali-sandbox,
# orchestrator), the webapp other than through the proxy's two prefixes, the
# host through either plugin network's bridge address (ports 22, 80, 443, 3000,
# 5432, 8090: a connect or ECONNREFUSED is a leak), a write to /plugins, the
# environment of pid 1 or of a running worker.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROBE="$REPO_ROOT/services/plugin_runner/tests_live/probe.py"
PROBE_UID=29999

running() { docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }
if ! command -v docker >/dev/null 2>&1 || ! running redamon-plugin-runner || ! running redamon-plugin-gateway; then
    echo "  SKIP  the plugin runner and proxy are not running (PLUGINS_ENABLED=true, ./redamon.sh up)"
    exit 0
fi

gateways=()
for net in redamon-plugins-net redamon-plugins-edge; do
    gw="$(docker network inspect "$net" -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' 2>/dev/null | awk '{print $1}')"
    [[ -n "$gw" ]] && gateways+=(--host-gateway "$gw")
done
# Running workers (the supervisor's children), so the probe can try their /proc entries.
workers=()
for pid in $(docker exec redamon-plugin-runner sh -c 'for p in /proc/[0-9]*; do u=$(awk "/^Uid:/{print \$2}" $p/status 2>/dev/null); [ -n "$u" ] && [ "$u" -ge 20000 ] 2>/dev/null && echo ${p#/proc/}; done' 2>/dev/null); do
    workers+=(--worker-pid "$pid")
done

FAIL=0; PASS=0
run_probe() {   # container, user, role
    local out
    out="$(docker exec -i -u "$2" "$1" python -I -S - --role "$3" "${gateways[@]}" ${workers[@]+"${workers[@]}"} < "$PROBE" 2>&1)"
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        if python3 -c 'import json,sys; sys.exit(0 if json.loads(sys.argv[1])["ok"] else 1)' "$line" 2>/dev/null; then
            PASS=$((PASS+1)); printf '  ok   %s: %s\n' "$1" "$line"
        else
            FAIL=$((FAIL+1)); printf '  LEAK %s: %s\n' "$1" "$line"
        fi
    done <<<"$out"
}

echo "== inside the runner, as a worker-range UID ($PROBE_UID) =="
run_probe redamon-plugin-runner "$PROBE_UID:$PROBE_UID" runner
echo
echo "== inside the proxy =="
run_probe redamon-plugin-gateway "65534:65534" gateway

echo
printf 'passed %d, leaks %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 && "$PASS" -gt 0 ]]
