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

FAIL=0; PASS=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
leak() { FAIL=$((FAIL+1)); printf '  LEAK %s\n' "$1"; }

# The host side of each plugin network (experiment E1: without `gateway_mode_ipv4:
# isolated` the bridge keeps an address on the host and a worker reaches every host
# service listening on all interfaces). With it, Docker assigns the network no gateway
# and the host holds no address in its subnet; `.1` may then belong to a container (the
# first to join), so it is not probed as "the host".
echo "== the plugin networks have no host-side address =="
for net in redamon-plugins-net redamon-plugins-edge; do
    info="$(docker network inspect "$net" -f '{{range .IPAM.Config}}{{.Subnet}}|{{.Gateway}} {{end}}' 2>/dev/null | awk '{print $1}')"
    subnet="${info%%|*}"; gw="${info#*|}"
    if [[ -z "$subnet" ]]; then leak "$net: no subnet found"; continue; fi
    # An absent gateway prints as empty or as "invalid IP", depending on the Docker version.
    if [[ "$gw" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        leak "$net ($subnet): gateway $gw on the host"
    else
        ok "$net ($subnet): Docker assigned no gateway"
    fi
    if command -v ip >/dev/null 2>&1; then
        held="$(ip -4 -o addr 2>/dev/null | awk '{print $4}' | python3 -c 'import ipaddress,sys
net = ipaddress.ip_network(sys.argv[1])
print(" ".join(a for a in sys.stdin.read().split() if ipaddress.ip_interface(a).ip in net))' "$subnet")"
        [[ -z "$held" ]] && ok "$net: the host holds no address in $subnet" || leak "$net: the host holds $held"
    else
        echo "  SKIP $net: no \`ip\` command on this host to list its addresses"
    fi
done

# The host's own addresses on the stack's network and on docker0: not routable from the
# plugin networks at all.
gateways=()
for net in redamon-network bridge; do
    gw="$(docker network inspect "$net" -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' 2>/dev/null | awk '{print $1}')"
    if [[ "$gw" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        gateways+=(--host-gateway "$gw")
        echo "  host address probed for $net: $gw"
    else
        leak "$net: could not read the host's address on it (probe incomplete)"
    fi
done
# Running workers (the supervisor's children), so the probe can try their /proc entries.
workers=()
for pid in $(docker exec redamon-plugin-runner sh -c 'for p in /proc/[0-9]*; do u=$(awk "/^Uid:/{print \$2}" $p/status 2>/dev/null); [ -n "$u" ] && [ "$u" -ge 20000 ] 2>/dev/null && echo ${p#/proc/}; done' 2>/dev/null); do
    workers+=(--worker-pid "$pid")
done

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
