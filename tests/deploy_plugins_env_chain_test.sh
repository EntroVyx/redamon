#!/usr/bin/env bash
# =============================================================================
# The plugin platform's settings reach a single-host deploy (master plan 3.7).
# Run:  bash tests/deploy_plugins_env_chain_test.sh
#
# WHY THIS MATTERS: the platform always runs, so a deploy has to carry it end to end.
#   1. nginx forwards `Host $host` without the port, so the plugin routes'
#      same-origin check needs PLUGINS_ALLOWED_ORIGIN: build_deploy_env ships the
#      derived origin, cmd_init AND cmd_update seed it before redamon.sh runs, and
#      compose (the webapp has no env_file) and the prod overlay hand it on;
#   2. the runner's CPU cap is fitted to the server's cores like the others;
#   3. the update's explicit webapp recreate passes the plugins overlay, or every
#      deploy update would take the webapp off its plugin network and volume;
#   4. the secrets gate refuses a public host with a weak plugin secret, like any other;
#   5. init, harden AND update bring Docker Engine to 28.0.0 or newer before redamon.sh
#      runs: the plugin networks need it and redamon.sh refuses to run below it.
# Static or stubbed: no SSH, no Docker.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/tooling/deploy/single-host"
DEPLOY="$DEPLOY_DIR/deploy.sh"
OVERLAY="$DEPLOY_DIR/compose/docker-compose.prod.yml"
ENV_EXAMPLE="$DEPLOY_DIR/.env.example"
README="$DEPLOY_DIR/README.md"
COMPOSE="$REPO_ROOT/docker-compose.yml"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s (got: %s want: %s)\n' "$1" "$2" "$3"; }

# A function's text. cmd_* bodies embed remote heredocs that define functions of their
# own (`cap_cpus() {` ... `}` at column 0), so they run to the next top-level cmd_* or
# the next banner comment instead of the first closing brace.
body_of() {
    if [[ "$1" == cmd_* ]]; then
        awk -v f="$1" '$0 ~ "^"f"\\(\\) \\{" {on=1; print; next}
                       on && (/^cmd_[a-z_]+\(\) \{/ || /^# ={20,}/) {exit} on {print}' "$DEPLOY"
    else
        awk -v f="$1" '$0 ~ "^"f"\\(\\) \\{" {on=1} on {print} on && /^}/ {exit}' "$DEPLOY"
    fi
}

echo "== hop 1: the derived origin reaches the webapp's plugin routes =="
body_of build_deploy_env | grep -qw MCP_PUBLIC_ORIGIN && ok "build_deploy_env ships MCP_PUBLIC_ORIGIN" \
    || bad "build_deploy_env ships MCP_PUBLIC_ORIGIN" "absent" "MCP_PUBLIC_ORIGIN in the list"
for fn in cmd_init cmd_update; do
    body="$(body_of "$fn")"
    origin_line="$(grep -nF 'seed PLUGINS_ALLOWED_ORIGIN "\${MCP_PUBLIC_ORIGIN}"' <<<"$body" | head -1 | cut -d: -f1)"
    run_line="$(grep -nE 'drive_install|\./redamon\.sh (install|update)' <<<"$body" | head -1 | cut -d: -f1)"
    [[ -n "$origin_line" ]] && ok "$fn seeds PLUGINS_ALLOWED_ORIGIN from the derived origin" \
        || bad "$fn seeds PLUGINS_ALLOWED_ORIGIN" "absent" 'seed PLUGINS_ALLOWED_ORIGIN "${MCP_PUBLIC_ORIGIN}"'
    if [[ -n "$origin_line" && -n "$run_line" && "$origin_line" -lt "$run_line" ]]; then
        ok "$fn seeds before redamon.sh runs"
    else
        bad "$fn seeds before redamon.sh runs" "seed=$origin_line run=$run_line" "seed first"
    fi
done
grep -qE '^  MCP_PUBLIC_ORIGIN="\$\{HTTP_SCHEME\}://\$\{PUBLIC_HOST\}:\$\{HTTPS_PORT\}"' "$DEPLOY" \
    && ok "the derived origin keeps a non-default port" || bad "the derived origin keeps its port" "absent" ":\${HTTPS_PORT}"
WEBAPP_BLOCK="$(awk '/^  webapp:/{f=1} f&&/^  [a-z_-]+:$/&&!/^  webapp:/{f=0} f' "$COMPOSE")"
grep -qE '^ +PLUGINS_ALLOWED_ORIGIN: \$\{PLUGINS_ALLOWED_ORIGIN' <<<"$WEBAPP_BLOCK" \
    && ok "PLUGINS_ALLOWED_ORIGIN reaches the webapp" || bad "PLUGINS_ALLOWED_ORIGIN reaches the webapp" "absent" "present"
grep -qE '^      PLUGINS_ALLOWED_ORIGIN: "\$\{PLUGINS_ALLOWED_ORIGIN:-\}"' "$OVERLAY" \
    && ok "the prod overlay passes PLUGINS_ALLOWED_ORIGIN (Host \$host drops the port)" \
    || bad "the prod overlay passes PLUGINS_ALLOWED_ORIGIN" "absent" 'PLUGINS_ALLOWED_ORIGIN: "${PLUGINS_ALLOWED_ORIGIN:-}"'

echo
echo "== hop 2: the runner's CPU cap fits the server like the others =="
body_of cmd_init | grep -qE '^cap_cpus PLUGIN_RUNNER_CPUS 2$' && ok "cap_cpus PLUGIN_RUNNER_CPUS 2" \
    || bad "cap_cpus PLUGIN_RUNNER_CPUS 2" "absent" "present"
default_in_compose="$(grep -oE 'cpus: \$\{PLUGIN_RUNNER_CPUS:-[0-9]+\}' "$COMPOSE" | grep -oE '[0-9]+\}$' | tr -d '}')"
default_in_script="$(grep -oE '_export_cpu_cap PLUGIN_RUNNER_CPUS [0-9]+' "$REPO_ROOT/redamon.sh" | awk '{print $3}')"
[[ "$default_in_compose" == "2" && "$default_in_script" == "2" ]] \
    && ok "compose, redamon.sh and deploy.sh agree on 2" \
    || bad "the three defaults agree" "compose=$default_in_compose redamon.sh=$default_in_script" "2"

echo
echo "== hop 3: an update's webapp recreate keeps the plugins overlay =="
# Run as the update's remote shell runs it: the heredoc line, unescaped, with `sg` and
# `docker` stubbed, so the assertion is on the compose call it makes.
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
body_of cmd_update | grep -E '^sg docker -c ".* up -d webapp"$' | sed 's/\\\$/$/g' > "$W/recreate.sh"
out="$( export APP_PATH="$W" OVERLAY_DIR=/overlay LOG="$W/log"
        docker() { echo "docker $*" >> "$LOG"; }
        sg() { shift 2; bash -c "$1"; }
        export -f docker
        source "$W/recreate.sh" >/dev/null 2>&1; cat "$LOG" 2>/dev/null )"
grep -q 'up -d webapp' <<<"$out" && ok "the recreate snippet runs" || bad "the recreate snippet runs" "${out:-nothing}" "a compose up"
grep -qF -- '-f /overlay/docker-compose.prod.yml -f docker-compose.plugins.yml up -d webapp' <<<"$out" \
    && ok "the webapp is recreated with the prod and plugins overlays" \
    || bad "the recreate passes both overlays" "${out:-nothing}" "-f docker-compose.plugins.yml"

echo
echo "== hop 4: the secrets gate covers both plugin secrets =="
gate() {   # gate <.env text>: the gate's exit status and FATAL lines
    printf '%s\n' "$1" > "$W/gate.env"
    ( step(){ :; }; success(){ :; }; err(){ echo "$*"; }
      source "$DEPLOY_DIR/modules/secrets_gate.sh"
      secrets_gate "$W/gate.env"; echo "rc=$?" ) 2>&1
}
STRONG="$(for v in AUTH_SECRET INTERNAL_API_KEY SCANNER_API_KEY ORCHESTRATOR_API_KEY MCP_AUTH_TOKEN \
              AGENT_WS_TICKET_SECRET TUNNEL_AUTH_TOKEN PLUGIN_RUNNER_KEY PLUGIN_CALL_TOKEN_SECRET \
              POSTGRES_PASSWORD NEO4J_PASSWORD; do printf '%s=%s\n' "$v" "$(printf 'x%.0s' {1..40})$v"; done)"
grep -q '^rc=0$' <<<"$(gate "$STRONG")" && ok "every secret strong: the gate passes" \
    || bad "every secret strong: the gate passes" "$(gate "$STRONG" | tr '\n' ' ')" "rc=0"
for key in PLUGIN_RUNNER_KEY PLUGIN_CALL_TOKEN_SECRET; do
    for weak in "" changeme short; do
        out="$(gate "$(sed "s/^$key=.*/$key=$weak/" <<<"$STRONG")")"
        grep -q '^rc=1$' <<<"$out" && grep -q "$key" <<<"$out" \
            && ok "$key='$weak' fails the gate, naming it" || bad "$key='$weak' fails the gate" "$(tr '\n' ' ' <<<"$out")" "rc=1 naming $key"
    done
done

echo
echo "== hop 5: the host bootstrap requires Docker Engine 28 =="
engine_ok() {   # engine_ok <server version or empty>: 0 when the bootstrap accepts it
    ( have(){ return 0; }; VERSION="$1"
      run_sudo() { [[ -n "$VERSION" ]] && echo "$VERSION"; }
      source "$DEPLOY_DIR/modules/host_bootstrap.sh"
      _docker_engine_ok ) >/dev/null 2>&1
}
for v in 28.0.0 28.5.1 29.1.0; do engine_ok "$v" && ok "Engine $v is accepted" || bad "Engine $v is accepted" "refused" "accepted"; done
for v in 27.5.1 20.10.24 ""; do engine_ok "$v" && bad "Engine '${v}' is refused" "accepted" "refused" || ok "Engine '${v}' is refused"; done
grep -A3 'if _docker_compose_v2_ok' "$DEPLOY_DIR/modules/host_bootstrap.sh" | grep -q '_docker_engine_ok' \
    && ok "an older engine takes the install path, which upgrades it" \
    || bad "an older engine takes the install path" "absent" "_docker_compose_v2_ok && _docker_engine_ok"
# A server bootstrapped before the requirement would otherwise stop after the pull.
for fn in cmd_init cmd_harden cmd_update; do
    body="$(body_of "$fn")"
    boot_line="$(grep -nE '^(host_bootstrap|bootstrap_docker)$' <<<"$body" | head -1 | cut -d: -f1)"
    run_line="$(grep -nE '\./redamon\.sh (install|update)|drive_install' <<<"$body" | head -1 | cut -d: -f1)"
    if [[ -n "$boot_line" && ( -z "$run_line" || "$boot_line" -lt "$run_line" ) ]]; then
        ok "$fn brings Docker up to date before redamon.sh runs"
    else
        bad "$fn brings Docker up to date first" "bootstrap=$boot_line run=$run_line" "bootstrap first"
    fi
done

echo
echo "== seeding never glues a key onto an operator's last line (R-79) =="
for fn in cmd_init cmd_update; do
    seed_def="$(body_of "$fn" | grep -E '^seed\(\) \{' | head -1 | sed 's/\\\$/$/g')"
    ( cd "$W" && printf 'OPERATOR_KEY=1' > .env && eval "$seed_def" \
        && seed PLUGINS_ALLOWED_ORIGIN https://h:8443 && seed OPERATOR_KEY 2 ) >/dev/null 2>&1
    got="$(cat "$W/.env" 2>/dev/null | tr '\n' ' ')"
    [[ "$got" == "OPERATOR_KEY=2 PLUGINS_ALLOWED_ORIGIN=https://h:8443 " ]] && ok "$fn: seed keeps every key on its own line" \
        || bad "$fn: seed keeps every key on its own line" "$got" "OPERATOR_KEY=2 PLUGINS_ALLOWED_ORIGIN=https://h:8443 "
done

echo
echo "== documented where an operator looks =="
grep -q '28.0.0' "$ENV_EXAMPLE" && ok "deploy .env.example states the Docker Engine requirement" \
    || bad "deploy .env.example states the Engine" "absent" "28.0.0"
for needle in "28.0.0" "/api/plugin-gateway/"; do
    grep -qF "$needle" "$README" && ok "README mentions $needle" || bad "README mentions $needle" "absent" "$needle"
done

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
