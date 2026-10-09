#!/usr/bin/env bash
# =============================================================================
# The plugin platform's settings reach a single-host deploy (master plan 3.7).
# Run:  bash tests/deploy_plugins_env_chain_test.sh
#
# WHY THIS MATTERS, hop by hop (the same chain deploy_mcp_env_chain_test.sh pins
# for the inbound MCP server):
#   1. deploy.sh needs a default, or `set -u` aborts on a deploy .env without it;
#   2. build_deploy_env must ship it to the remote shell;
#   3. cmd_init AND cmd_update must seed it into the app .env BEFORE redamon.sh
#      runs: ensure_auth_secrets writes PLUGINS_ENABLED=false when the key is
#      absent, so a late seed would leave the server pinned off;
#   4. the webapp gets it through compose (it has no env_file).
# Plus what only a fronted deploy needs: nginx forwards `Host $host` without the
# port, so the plugin routes' same-origin check needs PLUGINS_ALLOWED_ORIGIN,
# seeded from the same derived origin as MCP_ALLOWED_ORIGIN; the runner's CPU cap
# is fitted to the server's cores like the others; and the update's explicit
# webapp recreate keeps the plugins overlay while the platform runs, or every
# deploy update would take the webapp off its plugin network.
# Static: no SSH, no Docker.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$REPO_ROOT/tooling/deploy/single-host/deploy.sh"
OVERLAY="$REPO_ROOT/tooling/deploy/single-host/compose/docker-compose.prod.yml"
ENV_EXAMPLE="$REPO_ROOT/tooling/deploy/single-host/.env.example"
README="$REPO_ROOT/tooling/deploy/single-host/README.md"
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

echo "== hop 1: a default, so set -u never trips =="
grep -qE ': "\$\{PLUGINS_ENABLED:=false\}"' "$DEPLOY" && ok "PLUGINS_ENABLED defaults to false" \
    || bad "PLUGINS_ENABLED defaults to false" "absent" ': "${PLUGINS_ENABLED:=false}"'

echo
echo "== hop 2: shipped to the remote shell =="
for k in PLUGINS_ENABLED MCP_PUBLIC_ORIGIN; do
    body_of build_deploy_env | grep -qw "$k" && ok "build_deploy_env ships $k" \
        || bad "build_deploy_env ships $k" "absent" "$k in the list"
done

echo
echo "== hop 3: seeded in init AND update, before redamon.sh runs =="
for fn in cmd_init cmd_update; do
    body="$(body_of "$fn")"
    seed_line="$(grep -nF 'seed PLUGINS_ENABLED "\${PLUGINS_ENABLED}"' <<<"$body" | head -1 | cut -d: -f1)"
    origin_line="$(grep -nF 'seed PLUGINS_ALLOWED_ORIGIN "\${MCP_PUBLIC_ORIGIN}"' <<<"$body" | head -1 | cut -d: -f1)"
    run_line="$(grep -nE 'drive_install|\./redamon\.sh (install|update)' <<<"$body" | head -1 | cut -d: -f1)"
    [[ -n "$seed_line" ]] && ok "$fn seeds PLUGINS_ENABLED" || bad "$fn seeds PLUGINS_ENABLED" "absent" "seed"
    [[ -n "$origin_line" ]] && ok "$fn seeds PLUGINS_ALLOWED_ORIGIN from the derived origin" \
        || bad "$fn seeds PLUGINS_ALLOWED_ORIGIN" "absent" 'seed PLUGINS_ALLOWED_ORIGIN "${MCP_PUBLIC_ORIGIN}"'
    if [[ -n "$seed_line" && -n "$run_line" && "$seed_line" -lt "$run_line" ]]; then
        ok "$fn seeds before redamon.sh runs"
    else
        bad "$fn seeds before redamon.sh runs" "seed=$seed_line run=$run_line" "seed first"
    fi
done
grep -qE '^  MCP_PUBLIC_ORIGIN="\$\{HTTP_SCHEME\}://\$\{PUBLIC_HOST\}:\$\{HTTPS_PORT\}"' "$DEPLOY" \
    && ok "the derived origin keeps a non-default port" || bad "the derived origin keeps its port" "absent" ":\${HTTPS_PORT}"

echo
echo "== hop 4: compose hands both to the webapp =="
WEBAPP_BLOCK="$(awk '/^  webapp:/{f=1} f&&/^  [a-z_-]+:$/&&!/^  webapp:/{f=0} f' "$COMPOSE")"
for k in PLUGINS_ENABLED PLUGINS_ALLOWED_ORIGIN; do
    grep -qE "^ +${k}: \\\$\{${k}" <<<"$WEBAPP_BLOCK" && ok "$k reaches the webapp" \
        || bad "$k reaches the webapp" "absent" "present"
done
grep -qE '^      PLUGINS_ALLOWED_ORIGIN: "\$\{PLUGINS_ALLOWED_ORIGIN:-\}"' "$OVERLAY" \
    && ok "the prod overlay passes PLUGINS_ALLOWED_ORIGIN (Host \$host drops the port)" \
    || bad "the prod overlay passes PLUGINS_ALLOWED_ORIGIN" "absent" 'PLUGINS_ALLOWED_ORIGIN: "${PLUGINS_ALLOWED_ORIGIN:-}"'

echo
echo "== the runner's CPU cap fits the server like the others =="
body_of cmd_init | grep -qE '^cap_cpus PLUGIN_RUNNER_CPUS 2$' && ok "cap_cpus PLUGIN_RUNNER_CPUS 2" \
    || bad "cap_cpus PLUGIN_RUNNER_CPUS 2" "absent" "present"
default_in_compose="$(grep -oE 'cpus: \$\{PLUGIN_RUNNER_CPUS:-[0-9]+\}' "$COMPOSE" | grep -oE '[0-9]+\}$' | tr -d '}')"
default_in_script="$(grep -oE '_export_cpu_cap PLUGIN_RUNNER_CPUS [0-9]+' "$REPO_ROOT/redamon.sh" | awk '{print $3}')"
[[ "$default_in_compose" == "2" && "$default_in_script" == "2" ]] \
    && ok "compose, redamon.sh and deploy.sh agree on 2" \
    || bad "the three defaults agree" "compose=$default_in_compose redamon.sh=$default_in_script" "2"

echo
echo "== an update's webapp recreate keeps the plugins overlay while the platform runs =="
upd="$(body_of cmd_update)"
recreate="$(grep -E 'docker compose -f docker-compose.yml -f .*docker-compose.prod.yml.* up -d webapp' <<<"$upd")"
grep -qF 'docker-compose.plugins.yml' <<<"$upd" && ok "the update knows the plugins overlay" \
    || bad "the update knows the plugins overlay" "absent" "docker-compose.plugins.yml"
grep -qF 'PLUGINS_ARGS' <<<"$recreate" && ok "the recreate passes it when present" \
    || bad "the recreate passes the plugins overlay" "$recreate" "\$PLUGINS_ARGS"
grep -qF 'redamon-plugin-runner' <<<"$upd" && ok "it follows the runner redamon.sh left running" \
    || bad "the overlay follows the running runner" "absent" "redamon-plugin-runner"

# The recreate runs as the update's remote shell runs it: the heredoc's lines, unescaped,
# with `sg` and `docker` stubbed. Whatever the exported deploy.env and .env say, a webapp
# recreated without the runner (redamon.sh turned plugins off for this run) gets them off.
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
awk '/^PLUGINS_ARGS=""/{on=1} on{print} on && /up -d webapp"$/{exit}' <<<"$upd" | sed 's/\\\$/$/g' > "$W/recreate.sh"
recreate_with() {   # recreate_with <running container names>: the compose call it makes
    : > "$W/log"
    ( export PLUGINS_ENABLED=true APP_PATH="$W" OVERLAY_DIR=/overlay RUNNING="$1" LOG="$W/log"
      docker() { if [[ "$1" == ps ]]; then printf '%s\n' $RUNNING; else echo "PE=${PLUGINS_ENABLED:-} docker $*" >> "$LOG"; fi; }
      sg() { shift 2; bash -c "$1"; }
      export -f docker
      source "$W/recreate.sh" ) >/dev/null 2>&1
    cat "$W/log"
}
out="$(recreate_with "")"
grep -q 'up -d webapp' <<<"$out" && ok "the recreate snippet runs" || bad "the recreate snippet runs" "$out" "a compose up"
grep -q '^PE=false ' <<<"$out" && ok "no runner: the webapp is recreated with plugins off" \
    || bad "no runner: plugins off" "$out" "PE=false"
grep -qF 'docker-compose.plugins.yml' <<<"$out" && bad "no runner: no overlay" "$out" "absent" || ok "no runner: no overlay"
out="$(recreate_with "redamon-webapp redamon-plugin-runner")"
grep -q '^PE=true ' <<<"$out" && grep -qF -- '-f docker-compose.plugins.yml up -d webapp' <<<"$out" \
    && ok "runner running: the webapp keeps the overlay and the switch" || bad "runner running" "$out" "PE=true + overlay"

echo
echo "== seeding never glues a key onto an operator's last line (R-79) =="
for fn in cmd_init cmd_update; do
    seed_def="$(body_of "$fn" | grep -E '^seed\(\) \{' | head -1 | sed 's/\\\$/$/g')"
    ( cd "$W" && printf 'OPERATOR_KEY=1' > .env && eval "$seed_def" && seed PLUGINS_ENABLED true && seed OPERATOR_KEY 2 ) >/dev/null 2>&1
    got="$(cat "$W/.env" 2>/dev/null | tr '\n' ' ')"
    [[ "$got" == "OPERATOR_KEY=2 PLUGINS_ENABLED=true " ]] && ok "$fn: seed keeps every key on its own line" \
        || bad "$fn: seed keeps every key on its own line" "$got" "OPERATOR_KEY=2 PLUGINS_ENABLED=true "
done

echo
echo "== documented where an operator looks =="
grep -qE '^PLUGINS_ENABLED=false' "$ENV_EXAMPLE" && ok "deploy .env.example ships it off" \
    || bad "deploy .env.example ships it off" "absent" "PLUGINS_ENABLED=false"
grep -q '28.0.0' "$ENV_EXAMPLE" && ok "deploy .env.example states the Docker Engine requirement" \
    || bad "deploy .env.example states the Engine" "absent" "28.0.0"
for needle in "PLUGINS_ENABLED" "28.0.0" "/api/plugin-gateway/"; do
    grep -qF "$needle" "$README" && ok "README mentions $needle" || bad "README mentions $needle" "absent" "$needle"
done

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
