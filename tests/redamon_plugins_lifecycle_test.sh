#!/usr/bin/env bash
# =============================================================================
# Plugin platform in redamon.sh: install, update, up, up dev, down, clean,
# purge and status stay compatible for everyone (master plan R-75 to R-79).
# Run:  bash tests/redamon_plugins_lifecycle_test.sh
#
# WHY THIS MATTERS: the platform is optional and off by default. A user who
# never turns it on must get no plugin container, network or volume on any
# path, and nothing plugin-related may make install, update or up fail. A user
# who turns it on gets a working platform or a named reason, never a broken
# stack: an Engine older than 28.0.0 (no `gateway_mode_ipv4: isolated`), a weak
# internal key, a missing secret or a runner image that does not build turns
# the platform off for that run and starts everything else as usual.
#
# The real cmd_* functions run against a stubbed `docker` (a bash function that
# logs every call with the COMPOSE_FILE and PLUGINS_ENABLED it would see),
# a stubbed `git`, a stubbed compose_build, and no-op stand-ins for the helpers
# that need a daemon. No Docker, no network.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1090
source "$REPO_ROOT/redamon.sh"
set +e

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s (got: %s want: %s)\n' "$1" "$2" "$3"; }
eq()  { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }
has()   { if grep -qF -- "$2" <<<"$3"; then ok "$1"; else bad "$1" "absent" "$2"; fi; }
hasnt() { if grep -qF -- "$2" <<<"$3"; then bad "$1" "present" "absent: $2"; else ok "$1"; fi; }
section() { printf '\n== %s ==\n' "$1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SCRIPT_DIR="$WORK"
CALLS="$WORK/calls.log"
MSGS="$WORK/messages.log"

info()    { echo "INFO $*" >> "$MSGS"; }
success() { echo "OK $*" >> "$MSGS"; }
warn()    { echo "WARN $*" >> "$MSGS"; }
error()   { echo "ERROR $*" >> "$MSGS"; }
print_banner() { :; }
record() { echo "$* | CF=${COMPOSE_FILE:-} | PE=${PLUGINS_ENABLED:-}" >> "$CALLS"; }

# --- stubs: the daemon side --------------------------------------------------
STUB_ENGINE="29.8.0"
STUB_RUNNER_IMAGE=present        # present | missing
STUB_RUNNER_BUILD_RC=0
docker() {
    record "docker $*"
    case "$1" in
        version) [[ "$*" == *Server.Version* ]] && printf '%s\n' "$STUB_ENGINE"; return 0 ;;
        image)
            if [[ "$2" == inspect && "$*" == *redamon-plugin-runner* ]]; then
                [[ "$STUB_RUNNER_IMAGE" == present ]]; return
            fi
            return 0 ;;
    esac
    return 0
}
compose_build() {
    record "compose_build $*"
    if [[ "$*" == *plugin-runner* ]]; then
        if [[ "$STUB_RUNNER_BUILD_RC" -eq 0 ]]; then STUB_RUNNER_IMAGE=present; fi
        return "$STUB_RUNNER_BUILD_RC"
    fi
    return 0
}
STUB_CHANGED=""
git() {
    case "$*" in
        *"rev-parse HEAD"*) echo "newhead" ;;
        *"diff --name-only"*) printf '%s\n' "$STUB_CHANGED" ;;
        *) : ;;
    esac
    return 0
}
for fn in _migrate_reorg_layout _migrate_legacy_kbase_flag _kb_export_env _gpu_export_env \
          check_prerequisites setup_zram ensure_tool_images ensure_volume_ownership ensure_osv_db \
          ensure_sca_intel ensure_db_secrets ensure_gvm_secret pull_gvm_images ensure_admin \
          ensure_capture_proxy_running _reconcile_capture_if_running export_version \
          _assert_checkout_writable _warn_root_owned_runtime_files reconcile_gvm_admin_password \
          prune_stale_build_cache export_resource_caps; do
    eval "$fn() { :; }"
done
preflight_ram_gate() { return 0; }
preflight_disk_gate() { return 0; }
ensure_core_images() { return 0; }
verify_core_running() { return 0; }
_service_running() { return 0; }
is_gvm_enabled() { return 1; }
is_kb_enabled() { return 1; }
get_version() { echo "6.0.0"; }

# fresh <env lines...>: a clean run with this .env
fresh() {
    : > "$CALLS"; : > "$MSGS"
    printf '%s\n' "$@" > "$WORK/.env"
    unset COMPOSE_FILE PLUGINS_ENABLED PLUGINS_EFFECTIVE PLUGINS_OFF_REASON
    PLUGINS_COMPOSE_ARGS=""; GPU_COMPOSE_ARGS=""; PLUGINS_IMAGE_REBUILT=false
    STUB_ENGINE="29.8.0"; STUB_RUNNER_IMAGE=present; STUB_RUNNER_BUILD_RC=0; STUB_CHANGED=""
}
STRONG="INTERNAL_API_KEY=$(printf 'a%.0s' {1..64})"
KEYS=("PLUGIN_RUNNER_KEY=$(printf 'b%.0s' {1..64})" "PLUGIN_CALL_TOKEN_SECRET=$(printf 'c%.0s' {1..64})")

calls()       { cat "$CALLS"; }
core_up()     { grep -E '^docker compose .*up -d .*webapp' "$CALLS" | head -1; }
plugin_ups()  { grep -E '^docker compose .*up .*plugin-(runner|gateway)' "$CALLS"; }
plugin_rms()  { grep -E '^docker compose .*rm .*plugin-runner' "$CALLS"; }
line_of()     { grep -nE "$1" "$CALLS" | head -1 | cut -d: -f1; }
errors()      { grep -c '^ERROR' "$MSGS"; }

# =============================================================================
section "(vii) the switch is parsed like pluginsEnabled(): trimmed, any case, true or 1"
for v in true TRUE True " true " 1 " 1"; do
    fresh "PLUGINS_ENABLED=$v"
    plugins_switch_on && ok "PLUGINS_ENABLED='$v' is on" || bad "PLUGINS_ENABLED='$v'" "off" "on"
done
for v in false yes on 0 "" "  " truex; do
    fresh "PLUGINS_ENABLED=$v"
    plugins_switch_on && bad "PLUGINS_ENABLED='$v'" "on" "off" || ok "PLUGINS_ENABLED='$v' is off"
done
fresh "OTHER=1"
plugins_switch_on && bad "absent" "on" "off" || ok "an absent switch is off"

# =============================================================================
section "(vi) appending keys never glues them onto an operator's last line (R-79)"
printf 'MCP_SERVER_ENABLED=true' > "$WORK/.env"
( ensure_auth_secrets ) >/dev/null 2>&1
eq "the operator's last line is byte-identical" "$(sed -n 1p "$WORK/.env")" "MCP_SERVER_ENABLED=true"
eq "no key was glued onto it" "$(grep -c 'truePLUGIN\|trueAUTH' "$WORK/.env")" "0"
eq "every line is a KEY=value line" "$(grep -cvE '^[A-Z_]+=' "$WORK/.env")" "0"
for k in PLUGIN_RUNNER_KEY PLUGIN_CALL_TOKEN_SECRET PLUGINS_ENABLED; do
    eq "$k appended once on its own line" "$(grep -c "^$k=" "$WORK/.env")" "1"
done
eq "the runner key is 64 hex characters" "$(grep '^PLUGIN_RUNNER_KEY=' "$WORK/.env" | cut -d= -f2 | grep -cE '^[0-9a-f]{64}$')" "1"
before="$(cat "$WORK/.env")"
( ensure_auth_secrets ) >/dev/null 2>&1
eq "a second run changes nothing" "$(cat "$WORK/.env")" "$before"
printf '' > "$WORK/.env"
( ensure_auth_secrets ) >/dev/null 2>&1
eq "an empty .env gets no leading blank line" "$(head -c1 "$WORK/.env" | grep -c '^$')" "0"

# =============================================================================
section "(iv) an old clone's end state: no plugin keys, no runner image (R-77)"
fresh "$STRONG" "PLUGINS_ENABLED=false"
STUB_RUNNER_IMAGE=missing
( cmd_up ) >/dev/null 2>&1; rc=$?
eq "switch off: up exits 0" "$rc" "0"
eq "switch off: up seeds the runner key" "$(grep -c '^PLUGIN_RUNNER_KEY=' "$WORK/.env")" "1"
eq "switch off: up seeds the token secret" "$(grep -c '^PLUGIN_CALL_TOKEN_SECRET=' "$WORK/.env")" "1"
eq "switch off: nothing is built" "$(grep -c '^compose_build' "$CALLS")" "0"
eq "switch off: no up names a plugin service" "$(plugin_ups | wc -l | tr -d ' ')" "0"
hasnt "switch off: the core up has no overlay" "docker-compose.plugins.yml" "$(core_up)"

fresh "$STRONG" "PLUGINS_ENABLED=true"
STUB_RUNNER_IMAGE=missing
( cmd_up ) >/dev/null 2>&1; rc=$?
eq "switch on: up exits 0" "$rc" "0"
eq "switch on: up seeds both keys" "$(grep -cE '^PLUGIN_(RUNNER_KEY|CALL_TOKEN_SECRET)=.' "$WORK/.env")" "2"
eq "switch on: the runner image is built once" "$(grep -c '^compose_build build plugin-runner' "$CALLS")" "1"
has "switch on: the core up loads the overlay" "docker-compose.plugins.yml" "$(core_up)"
eq "switch on: one profile up of both services" "$(plugin_ups | grep -c 'plugin-runner plugin-gateway')" "1"
[[ "$(line_of 'compose_build build plugin-runner')" -lt "$(line_of '^docker compose .*up -d .*webapp')" ]] \
    && ok "the image is built before the core up" || bad "build order" "after" "before"

# =============================================================================
section "(v) a host that cannot run the platform degrades to off, never fails (R-78)"
check_degraded() {   # label, then the .env lines
    local label="$1"; shift
    fresh "$@"
    STUB_ENGINE="${ENGINE_FOR_CASE:-29.8.0}"
    ( cmd_up ) >/dev/null 2>&1; local rc=$?
    eq "$label: up exits 0" "$rc" "0"
    has "$label: the core up runs with the switch off" "PE=false" "$(core_up)"
    hasnt "$label: no overlay" "docker-compose.plugins.yml" "$(core_up)"
    eq "$label: no profile up" "$(plugin_ups | wc -l | tr -d ' ')" "0"
    eq "$label: the plugin services are removed instead" "$(plugin_rms | wc -l | tr -d ' ')" "1"
    eq "$label: exactly one error names the cause" "$(grep '^ERROR' "$MSGS" | grep -c "$EXPECT_CAUSE")" "1"
}
ENGINE_FOR_CASE=27.5.1 EXPECT_CAUSE="27.5.1" check_degraded "Engine 27.5.1" "$STRONG" "PLUGINS_ENABLED=true" "${KEYS[@]}"
ENGINE_FOR_CASE=garbage EXPECT_CAUSE="Docker Engine" check_degraded "unparseable Engine version" "$STRONG" "PLUGINS_ENABLED=true" "${KEYS[@]}"
EXPECT_CAUSE="INTERNAL_API_KEY" check_degraded "INTERNAL_API_KEY=changeme" "INTERNAL_API_KEY=changeme" "PLUGINS_ENABLED=true" "${KEYS[@]}"
EXPECT_CAUSE="PLUGIN_RUNNER_KEY" check_degraded "an empty runner key" "$STRONG" "PLUGINS_ENABLED=true" "PLUGIN_RUNNER_KEY=" "${KEYS[1]}"
EXPECT_CAUSE="PLUGIN_CALL_TOKEN_SECRET" check_degraded "an empty token secret" "$STRONG" "PLUGINS_ENABLED=true" "${KEYS[0]}" "PLUGIN_CALL_TOKEN_SECRET="
fresh "$STRONG" "PLUGINS_ENABLED=true" "${KEYS[@]}"
STUB_RUNNER_IMAGE=missing; STUB_RUNNER_BUILD_RC=1
( cmd_up ) >/dev/null 2>&1; rc=$?
eq "a runner image that does not build: up exits 0" "$rc" "0"
has "a runner image that does not build: the core up runs with the switch off" "PE=false" "$(core_up)"
eq "a runner image that does not build: one error names it" "$(grep '^ERROR' "$MSGS" | grep -c 'image')" "1"
fresh "$STRONG" "PLUGINS_ENABLED=true" "${KEYS[@]}"
STUB_ENGINE=28.0.0
( cmd_up ) >/dev/null 2>&1
has "Engine 28.0.0 exactly is enough" "docker-compose.plugins.yml" "$(core_up)"

# =============================================================================
section "(iii) switch on, Engine 28.1.0: the overlay before the core up, the profile after"
fresh "$STRONG" "PLUGINS_ENABLED=true" "${KEYS[@]}"
STUB_ENGINE=28.1.0
( cmd_up ) >/dev/null 2>&1
has "the overlay is in COMPOSE_FILE at the core up" "docker-compose.plugins.yml" "$(core_up)"
has "the overlay keeps the base file first" "CF=$WORK/docker-compose.yml:$WORK/docker-compose.plugins.yml" "$(core_up)"
[[ "$(line_of '^docker compose .*up -d .*webapp')" -lt "$(line_of 'up -d plugin-runner plugin-gateway')" ]] \
    && ok "the profile up comes after the core up" || bad "profile up order" "before" "after"
has "the profile up names the profile" "--profile plugins up -d plugin-runner plugin-gateway" "$(plugin_ups)"
hasnt "a plain up does not force a recreate" "force-recreate" "$(plugin_ups)"

COMPOSE_FILE_BEFORE="docker-compose.yml:/srv/overlay/docker-compose.prod.yml"
fresh "$STRONG" "PLUGINS_ENABLED=true" "${KEYS[@]}"
export COMPOSE_FILE="$COMPOSE_FILE_BEFORE"
( cmd_up ) >/dev/null 2>&1
has "a deploy's exported COMPOSE_FILE keeps its production overlay first" \
    "CF=$COMPOSE_FILE_BEFORE:$WORK/docker-compose.plugins.yml" "$(core_up)"
unset COMPOSE_FILE

fresh "$STRONG" "PLUGINS_ENABLED=true" "${KEYS[@]}"
_plugins_prepare >/dev/null 2>&1; _plugins_prepare >/dev/null 2>&1
eq "preparing twice adds the overlay once" "$(tr ':' '\n' <<<"${COMPOSE_FILE:-}" | grep -c plugins.yml)" "1"
unset COMPOSE_FILE

# =============================================================================
section "(i) update across a docker-compose.yml change, switch off (R-76)"
fresh "$STRONG" "PLUGINS_ENABLED=false" "${KEYS[@]}"
STUB_CHANGED=$'docker-compose.yml\nwebapp/src/app/page.tsx'
( REDAMON_UPDATE_FROM=oldhead cmd_update ) >/dev/null 2>&1; rc=$?
eq "update exits 0" "$rc" "0"
eq "the runner image is built once" "$(grep -c '^compose_build build plugin-runner' "$CALLS")" "1"
eq "the core build does not name it" "$(grep '^compose_build build ' "$CALLS" | grep -v '^compose_build build plugin-runner' | grep -c plugin-runner)" "0"
eq "no up names a plugin service" "$(plugin_ups | wc -l | tr -d ' ')" "0"
eq "only the converge removes them" "$(plugin_rms | wc -l | tr -d ' ')" "1"
hasnt "no overlay anywhere" "plugins.yml" "$(calls)"
eq "the per-service restart loop never names the runner" "$(grep -cE '^docker compose up -d --no-deps (--force-recreate )?plugin' "$CALLS")" "0"

section "(i') update of plugin code only, switch off: build, never start"
fresh "$STRONG" "PLUGINS_ENABLED=false" "${KEYS[@]}"
STUB_CHANGED="services/plugin_runner/supervisor/app.py"
( REDAMON_UPDATE_FROM=oldhead cmd_update ) >/dev/null 2>&1
eq "the runner image is rebuilt" "$(grep -c '^compose_build build plugin-runner' "$CALLS")" "1"
eq "no core image is rebuilt for it" "$(grep '^compose_build' "$CALLS" | grep -vc plugin-runner)" "0"
eq "nothing names it in an up" "$(plugin_ups | wc -l | tr -d ' ')" "0"

section "(i'') an update that changed nothing of the platform builds nothing of it"
fresh "$STRONG" "PLUGINS_ENABLED=false" "${KEYS[@]}"
STUB_CHANGED="agentic/api.py"
( REDAMON_UPDATE_FROM=oldhead cmd_update ) >/dev/null 2>&1
eq "no runner build when the image exists and its sources did not change" "$(grep -c '^compose_build build plugin-runner' "$CALLS")" "0"
fresh "$STRONG" "PLUGINS_ENABLED=false" "${KEYS[@]}"
STUB_CHANGED="agentic/api.py"; STUB_RUNNER_IMAGE=missing
( REDAMON_UPDATE_FROM=oldhead cmd_update ) >/dev/null 2>&1
eq "a missing image is built even if nothing changed" "$(grep -c '^compose_build build plugin-runner' "$CALLS")" "1"

# =============================================================================
section "(ii) the same update with the runner build failing (X30)"
fresh "$STRONG" "PLUGINS_ENABLED=false" "${KEYS[@]}"
STUB_CHANGED="docker-compose.yml"; STUB_RUNNER_BUILD_RC=1
( REDAMON_UPDATE_FROM=oldhead cmd_update ) >/dev/null 2>&1; rc=$?
eq "update still exits 0" "$rc" "0"
eq "the core services are recreated" "$(grep -cE '^docker compose up -d .*webapp' "$CALLS")" "1"
eq "one warning names the fix" "$(grep '^WARN' "$MSGS" | grep -c 'docker compose build plugin-runner')" "1"

section "(iii') switch on: an update that rebuilt the runner recreates both services"
fresh "$STRONG" "PLUGINS_ENABLED=true" "${KEYS[@]}"
STUB_CHANGED="services/plugin_runner/worker/bootstrap.py"
( REDAMON_UPDATE_FROM=oldhead cmd_update ) >/dev/null 2>&1; rc=$?
eq "update exits 0" "$rc" "0"
has "the converge recreates both" "--profile plugins up -d --force-recreate plugin-runner plugin-gateway" "$(plugin_ups)"
eq "the image is built once (the update, not also the preflight)" "$(grep -c '^compose_build build plugin-runner' "$CALLS")" "1"

# =============================================================================
section "up dev passes the overlay with its own -f files"
fresh "$STRONG" "PLUGINS_ENABLED=true" "${KEYS[@]}"
( cmd_up_dev ) >/dev/null 2>&1; rc=$?
eq "up dev exits 0" "$rc" "0"
has "the dev up lists the plugins overlay after the dev file" \
    "-f docker-compose.yml -f docker-compose.dev.yml -f $WORK/docker-compose.plugins.yml up -d" "$(core_up)"
eq "up dev starts the profile" "$(plugin_ups | grep -c 'plugin-runner plugin-gateway')" "1"
fresh "$STRONG" "PLUGINS_ENABLED=false" "${KEYS[@]}"
( cmd_up_dev ) >/dev/null 2>&1
hasnt "up dev with the switch off has no overlay" "plugins.yml" "$(core_up)"

section "install: the fatal build unchanged, then a separate non-fatal runner build (ix)"
fresh "$STRONG" "PLUGINS_ENABLED=false" "${KEYS[@]}"
STUB_RUNNER_BUILD_RC=1
( cmd_install ) >/dev/null 2>&1; rc=$?
eq "install exits 0 when only the runner build fails" "$rc" "0"
eq "the full build is the first build" "$(grep '^compose_build' "$CALLS" | head -1 | cut -d'|' -f1 | sed 's/ *$//')" \
   "compose_build --profile tools --profile capture build"
eq "the runner is built in its own call" "$(grep -c '^compose_build build plugin-runner' "$CALLS")" "1"
eq "one warning names the fix" "$(grep '^WARN' "$MSGS" | grep -c 'docker compose build plugin-runner')" "1"
install_body="$(sed -n '/^cmd_install()/,/^}/p' "$REPO_ROOT/redamon.sh")"
has "install keeps its fatal build line byte for byte" $'\n    compose_build --profile tools --profile capture build\n' "$install_body"

# =============================================================================
section "(ix) down, clean and purge pass the plugins profile"
for fn in cmd_down cmd_clean cmd_purge; do
    body="$(sed -n "/^$fn()/,/^}/p" "$REPO_ROOT/redamon.sh")"
    eq "$fn: every compose down passes --profile plugins" \
       "$(grep -E 'docker compose .*down' <<<"$body" | grep -vc -- '--profile plugins')" "0"
    has "$fn: has a compose down" "down" "$(grep -E 'docker compose .*down' <<<"$body")"
done
has "purge removes volumes, so the plugins volume goes too" "--profile plugins down --volumes" \
    "$(sed -n '/^cmd_purge()/,/^}/p' "$REPO_ROOT/redamon.sh")"

# =============================================================================
section "(viii) where the platform is decided and converged, per command (S2)"
for fn in cmd_install cmd_update cmd_up cmd_up_dev; do
    body="$(sed -n "/^$fn()/,/^}/p" "$REPO_ROOT/redamon.sh")"
    eq "$fn prepares exactly once" "$(grep -c '^ *_plugins_prepare' <<<"$body")" "1"
    eq "$fn converges exactly once" "$(grep -c '^ *plugins_converge' <<<"$body")" "1"
    p="$(grep -n '^ *_plugins_prepare' <<<"$body" | cut -d: -f1)"
    s="$(grep -n '^ *ensure_auth_secrets' <<<"$body" | cut -d: -f1)"
    u="$(grep -nE 'docker compose .*up -d|gvm_up_or_diagnose ' <<<"$body" | grep -vE '^[0-9]+:[[:space:]]*#' | grep -v plugins | head -1 | cut -d: -f1)"
    [[ -n "$p" && -n "$s" && "$s" -lt "$p" ]] && ok "$fn: after ensure_auth_secrets" || bad "$fn order" "p=$p s=$s" "secrets first"
    [[ -n "$u" && "$p" -lt "$u" ]] && ok "$fn: before the first compose up" || bad "$fn order" "p=$p up=$u" "prepare first"
done
for fn in cmd_kb_build cmd_kb_update cmd_kb_rebuild cmd_kb_stats _kb_bootstrap; do
    body="$(sed -n "/^$fn()/,/^}/p" "$REPO_ROOT/redamon.sh")"
    eq "$fn neither prepares nor converges" "$(grep -cE '_plugins_prepare|plugins_converge' <<<"$body")" "0"
done
up_body="$(sed -n '/^cmd_update()/,/^}/p' "$REPO_ROOT/redamon.sh")"
p="$(grep -n '^ *_plugins_prepare' <<<"$up_body" | cut -d: -f1)"
x="$(grep -n 'exec bash' <<<"$up_body" | cut -d: -f1)"
[[ "$x" -lt "$p" ]] && ok "update prepares only after the re-exec of the pulled script" || bad "update order" "p=$p exec=$x" "after"
map="$(sed -n '/^_map_core_changes()/,/^}/p' "$REPO_ROOT/redamon.sh")"
eq "the runner is never in _map_core_changes" "$(grep -c 'plugin' <<<"$map")" "0"
eq "the runner is never in the literal rebuild_core list" "$(grep -E 'rebuild_core=\(' <<<"$up_body" | grep -c plugin)" "0"

# =============================================================================
section "converge: off removes the services and their networks, silently"
fresh "$STRONG" "PLUGINS_ENABLED=false" "${KEYS[@]}"
PLUGINS_EFFECTIVE=off plugins_converge >/dev/null 2>&1; rc=$?
eq "exit 0" "$rc" "0"
has "removes both services" "docker compose --profile plugins rm -sf plugin-runner plugin-gateway" "$(calls)"
has "removes both networks" "docker network rm redamon-plugins-net redamon-plugins-edge" "$(calls)"
eq "and says nothing" "$(grep -c . "$MSGS")" "0"

# =============================================================================
section "memory governor and CPU caps"
fresh "$STRONG" "PLUGINS_ENABLED=false"
hasnt "switch off: no runner spec" "PLUGIN_RUNNER" "$(_mem_specs)"
fresh "$STRONG" "PLUGINS_ENABLED=true"
has "switch on, not yet decided: the runner spec is budgeted" "$_MEM_SPEC_PLUGINS" "$(_mem_specs)"
PLUGINS_EFFECTIVE=off
hasnt "decided off (degraded): no runner spec" "PLUGIN_RUNNER" "$(_mem_specs)"
PLUGINS_EFFECTIVE=on
has "decided on: the runner spec" "PLUGIN_RUNNER" "$(_mem_specs)"
eq "the spec is a burst-tier PLUGIN_RUNNER" "$(cut -d: -f1,4 <<<"$_MEM_SPEC_PLUGINS")" "PLUGIN_RUNNER:b"
unset PLUGINS_EFFECTIVE
has "the managed vars include PLUGIN_RUNNER_MEM when on" "PLUGIN_RUNNER_MEM" "$(_mem_managed_vars)"
BUILD_NCPU=1; unset PLUGIN_RUNNER_CPUS
_export_cpu_cap PLUGIN_RUNNER_CPUS 2
eq "the runner CPU cap is clamped to the cores" "${PLUGIN_RUNNER_CPUS:-}" "1"
has "export_cpu_caps covers the runner" "PLUGIN_RUNNER_CPUS 2" "$(sed -n '/^export_cpu_caps()/,/^}/p' "$REPO_ROOT/redamon.sh")"
eq "status maps the runner's container to its spec" "$(sed -n '/^_status_expected_mb()/,/^}/p' "$REPO_ROOT/redamon.sh" | grep -c 'plugin-runner) key=PLUGIN_RUNNER')" "1"

# =============================================================================
section "status names the platform's state and why it is off"
fresh "$STRONG" "PLUGINS_ENABLED=false" "${KEYS[@]}"
plain() { sed 's/\x1b\[[0-9;]*m//g' | tr -s ' '; }
eq "off" "$(_status_plugins_report | plain)" " PLUGINS: off"
fresh "$STRONG" "PLUGINS_ENABLED=true" "${KEYS[@]}"
STUB_ENGINE=27.5.1
out="$(_status_plugins_report | plain)"
has "switch on but degraded: says so" "off (PLUGINS_ENABLED=true, but" "$out"
has "and names the cause" "27.5.1" "$out"
eq "status builds nothing" "$(grep -c '^compose_build' "$CALLS")" "0"
fresh "$STRONG" "PLUGINS_ENABLED=true" "${KEYS[@]}"
out="$(_status_plugins_report | plain)"
has "switch on and able: on" "PLUGINS: on" "$out"
has "status asks compose for the two services" "--profile plugins ps" "$(calls)"

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
