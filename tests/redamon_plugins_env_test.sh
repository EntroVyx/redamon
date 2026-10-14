#!/usr/bin/env bash
# =============================================================================
# Plugin platform: the .env that redamon.sh leaves behind.
# Run:  bash tests/redamon_plugins_env_test.sh
#
# WHY THIS MATTERS: the platform always runs, so its two secrets must exist after
# every install/update/up, including on a .env copied from an older .env.example
# that holds them empty, and a generated secret must survive later runs (rotating
# one mid-flight breaks every token in use). A PLUGINS_ENABLED line left by a
# release that had a switch reads as a working switch to whoever opens .env, so it
# is removed, in every form compose accepts, without touching any other line.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s (got: %s want: %s)\n' "$1" "$2" "$3"; }
eq()  { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }

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

echo "== both plugin secrets are generated on a fresh .env and kept afterwards =="
D="$(mktemp -d)"
seed "$D"
for key in PLUGIN_RUNNER_KEY PLUGIN_CALL_TOKEN_SECRET; do
    eq "$key is generated, once" "$(grep -cE "^$key=[0-9a-f]{64}\$" "$D/.env"):$(grep -c "^$key=" "$D/.env")" "1:1"
done
BEFORE="$(grep -E '^PLUGIN_(RUNNER_KEY|CALL_TOKEN_SECRET)=' "$D/.env")"
seed "$D"
eq "a second run keeps both" "$(grep -E '^PLUGIN_(RUNNER_KEY|CALL_TOKEN_SECRET)=' "$D/.env")" "$BEFORE"
eq "the two are different" \
   "$(grep -E '^PLUGIN_(RUNNER_KEY|CALL_TOKEN_SECRET)=' "$D/.env" | cut -d= -f2 | sort -u | wc -l | tr -d ' ')" "2"
eq "no PLUGINS_ENABLED line is written" "$(grep -c 'PLUGINS_ENABLED' "$D/.env")" "0"
rm -rf "$D"

echo
echo "== an empty plugin secret (a .env copied from an older .env.example) is generated =="
D="$(mktemp -d)"
printf 'PLUGIN_RUNNER_KEY=\nPLUGIN_CALL_TOKEN_SECRET=   \n' > "$D/.env"
seed "$D"
for key in PLUGIN_RUNNER_KEY PLUGIN_CALL_TOKEN_SECRET; do
    eq "$key is generated, once" "$(grep -cE "^$key=[0-9a-f]{64}\$" "$D/.env"):$(grep -c "^$key=" "$D/.env")" "1:1"
done
rm -rf "$D"

echo
echo "== a leftover PLUGINS_ENABLED line is removed, and nothing else =="
for line in 'PLUGINS_ENABLED=false' 'PLUGINS_ENABLED=true' 'export PLUGINS_ENABLED=1' '  PLUGINS_ENABLED="true"'; do
    D="$(mktemp -d)"
    printf 'OPERATOR_KEY=keep-me\n%s\nOTHER_PLUGINS_ENABLED_NOTE=keep-me-too\n' "$line" > "$D/.env"
    seed "$D"
    eq "removed: $line" "$(grep -cE '^[[:space:]]*(export[[:space:]]+)?PLUGINS_ENABLED=' "$D/.env")" "0"
    eq "the neighbours of '$line' survive" \
       "$(grep -cxE 'OPERATOR_KEY=keep-me|OTHER_PLUGINS_ENABLED_NOTE=keep-me-too' "$D/.env")" "2"
    rm -rf "$D"
done

echo
echo "== .env.example =="
# compose reads `KEY=   # note` as the text of the note, and a typed field (pids_limit)
# then fails every compose command.
eq "no plugin key's value is a comment" \
   "$(grep -cE '^PLUGINS?_[A-Z_]*=[[:space:]]*#' "$REPO_ROOT/.env.example")" "0"
grep -q '28\.0\.0' "$REPO_ROOT/.env.example" && ok ".env.example states the Docker Engine requirement" \
    || bad ".env.example states the Docker Engine requirement" "absent" "28.0.0"

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
