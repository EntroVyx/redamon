#!/usr/bin/env bash
# =============================================================================
# Plugin platform switch: env wiring + seeding.
# Run:  bash tests/redamon_plugins_env_test.sh
#
# WHY THIS MATTERS: THE WEBAPP HAS NO env_file. A variable set only in .env
# never reaches it, so PLUGINS_ENABLED must also be listed in the webapp's
# compose `environment:` block, defaulting OFF (plugin code is third-party
# code; the platform is switched on deliberately, never by upgrading). And
# redamon.sh writes it into .env explicitly, so an operator can see the switch
# exists, without ever reverting an operator's opt-in.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$REPO_ROOT/docker-compose.yml"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s (got: %s want: %s)\n' "$1" "$2" "$3"; }
eq()  { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }
hasF()   { if grep -qF "$2" "$1"; then ok "$3"; else bad "$3" "absent" "$2"; fi; }

echo "== the switch is in the webapp compose environment block, defaulting OFF =="
# The webapp block runs from `  webapp:` to the next top-level service key.
WEBAPP_BLOCK="$(awk '/^  webapp:/{f=1} f&&/^  [a-z_-]+:$/&&!/^  webapp:/{f=0} f' "$COMPOSE")"
if grep -qE '^[[:space:]]+PLUGINS_ENABLED:' <<<"$WEBAPP_BLOCK"; then
    ok "PLUGINS_ENABLED reaches the webapp"
else
    bad "PLUGINS_ENABLED reaches the webapp" "absent from the environment block" "present"
fi
if grep -qE '^[[:space:]]+PLUGINS_ENABLED: \$\{PLUGINS_ENABLED:-false\}$' <<<"$WEBAPP_BLOCK"; then
    ok "compose default is false"
else
    bad "compose default is false" "not :-false" ':${PLUGINS_ENABLED:-false}'
fi
eq "listed exactly once in the webapp block" \
   "$(grep -cE '^[[:space:]]+PLUGINS_ENABLED:' <<<"$WEBAPP_BLOCK")" "1"

echo
echo "== ensure_auth_secrets writes the switch explicitly =="
seed() {   # seed <envdir>: run ensure_auth_secrets against <envdir>/.env
    ( cd "$REPO_ROOT" && ENVDIR="$1" bash -c '
        set -uo pipefail
        source ./redamon.sh
        set +e
        info(){ :; }; warn(){ :; }; error(){ :; }; success(){ :; }
        SCRIPT_DIR="$ENVDIR"
        ensure_auth_secrets
    ' >/dev/null 2>&1 )
}
D="$(mktemp -d)"
seed "$D"
hasF "$D/.env" "PLUGINS_ENABLED=false" "the switch is written, and written OFF"
eq "written exactly once" "$(grep -c '^PLUGINS_ENABLED=' "$D/.env")" "1"

seed "$D"
eq "a second run does not duplicate it" "$(grep -c '^PLUGINS_ENABLED=' "$D/.env")" "1"

# An operator's opt-in must survive every later install/update/up.
sed -i 's/^PLUGINS_ENABLED=false/PLUGINS_ENABLED=true/' "$D/.env"
seed "$D"
eq "still exactly one entry" "$(grep -c '^PLUGINS_ENABLED=' "$D/.env")" "1"
hasF "$D/.env" "PLUGINS_ENABLED=true" "an operator's opt-in is not reverted"
rm -rf "$D"

# A pre-existing .env that already holds the opt-in, before any seeding.
D="$(mktemp -d)"
printf 'PLUGINS_ENABLED=true\n' > "$D/.env"
seed "$D"
eq "an existing opt-in is kept as the only entry" "$(grep -c '^PLUGINS_ENABLED=' "$D/.env")" "1"
hasF "$D/.env" "PLUGINS_ENABLED=true" "an existing opt-in is kept"
rm -rf "$D"

echo
echo "== an empty plugin secret (a .env copied from an older .env.example) is generated =="
D="$(mktemp -d)"
printf 'PLUGINS_ENABLED=true\nPLUGIN_RUNNER_KEY=\nPLUGIN_CALL_TOKEN_SECRET=   \n' > "$D/.env"
seed "$D"
for key in PLUGIN_RUNNER_KEY PLUGIN_CALL_TOKEN_SECRET; do
    eq "$key is generated, once" "$(grep -cE "^$key=[0-9a-f]{64}\$" "$D/.env"):$(grep -c "^$key=" "$D/.env")" "1:1"
done
KEY_BEFORE="$(grep '^PLUGIN_RUNNER_KEY=' "$D/.env")"
seed "$D"
eq "a generated key is kept by the next run" "$(grep '^PLUGIN_RUNNER_KEY=' "$D/.env")" "$KEY_BEFORE"
rm -rf "$D"

echo
echo "== .env.example documents the switch =="
hasF "$REPO_ROOT/.env.example" "PLUGINS_ENABLED=false" ".env.example ships it OFF"
# compose reads `KEY=   # note` as the text of the note, and a typed field (pids_limit)
# then fails every compose command, plugins on or off.
eq "no plugin key's value is a comment" \
   "$(grep -cE '^PLUGINS?_[A-Z_]*=[[:space:]]*#' "$REPO_ROOT/.env.example")" "0"

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
