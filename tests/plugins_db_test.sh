#!/usr/bin/env bash
# =============================================================================
# Plugin platform tables on real Postgres: constraints, cascades, races
# =============================================================================
# What Prisma cannot show a unit test: the partial unique index and the CHECK
# constraints of webapp/scripts/apply-plugin-constraints.mjs, the cascades that make
# plugin rows die with their user, project or plugin, and compare-and-swap races
# between two real sessions.
#
# The constraint and cascade cases run inside ONE transaction that is rolled back.
# The race cases need two sessions, so they run on copies of the plugin tables in a
# throwaway schema (`plugins_dbtest_<pid>`, dropped on exit). No real row is read or
# written; the row counts of the existing tables are compared before and after.
#
# Requires the stack's postgres container, and a webapp that has pushed the schema:
#   docker compose up -d postgres webapp
# Usage: tests/plugins_db_test.sh
# =============================================================================
set -uo pipefail

cd "$(dirname "$0")/.."

PSQL=(docker compose exec -T postgres psql -U redamon -d redamon -qtAX -v ON_ERROR_STOP=1)

pass=0
fail=0

ok()   { echo "  PASS  $1"; pass=$((pass + 1)); }
bad()  { echo "  FAIL  $1"; echo "        $2"; fail=$((fail + 1)); }

expect_eq() { # desc expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$2' got '$3'"; fi
}

echo "== Plugin platform tables on Postgres =="

if ! "${PSQL[@]}" -c "select 1" >/dev/null 2>&1; then
  echo "  SKIP  postgres container not reachable (docker compose up -d postgres)"
  exit 0
fi
TABLES=$("${PSQL[@]}" -c "select count(*) from pg_tables where schemaname = 'public' and tablename in
  ('plugin_installs', 'plugin_data', 'plugin_overrides', 'plugin_platform_state')" 2>/dev/null)
if [ "$TABLES" != "4" ]; then
  echo "  SKIP  plugin tables absent (start a webapp built from this branch to push the schema)"
  exit 0
fi

COUNTS_SQL="select string_agg(t || '=' || n, ' ' order by t) from (
  select 'users' t, count(*) n from users union all
  select 'projects', count(*) from projects union all
  select 'conversations', count(*) from conversations union all
  select 'chat_messages', count(*) from chat_messages union all
  select 'user_settings', count(*) from user_settings union all
  select 'plugin_installs', count(*) from plugin_installs union all
  select 'plugin_data', count(*) from plugin_data union all
  select 'plugin_overrides', count(*) from plugin_overrides union all
  select 'plugin_platform_state', count(*) from plugin_platform_state) c"
COUNTS_BEFORE=$("${PSQL[@]}" -c "$COUNTS_SQL")

# Columns every override insert below shares; each case varies the rest.
OV="INSERT INTO plugin_overrides (id, plugin_id, extension_point, scope_type, scope_id, user_id,
  project_id, target_group, target_key, change_set_id, value, base_sha256, status, created_by,
  updated_at) VALUES"
DA="INSERT INTO plugin_data (id, plugin_id, owner_type, owner_id, user_id, project_id, collection,
  key, value, size_bytes, updated_at) VALUES"
H=$(printf 'a%.0s' $(seq 64))

OUT=$("${PSQL[@]}" <<SQL 2>&1
BEGIN;
-- Runs one statement and reports 'ok' or its SQLSTATE, so a refused insert does not
-- abort the transaction the other cases run in.
CREATE FUNCTION pg_temp.try(sql text) RETURNS text LANGUAGE plpgsql AS \$f\$
BEGIN
  EXECUTE sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END \$f\$;

SELECT 'index_def:' || coalesce(pg_get_indexdef(to_regclass('public.plugin_overrides_one_active')), 'absent');
SELECT 'checks:' || coalesce(string_agg(conname, ',' ORDER BY conname), '') FROM pg_constraint
 WHERE contype = 'c' AND conname LIKE 'plugin\_%\_ck%';

INSERT INTO users (id, name, email, updated_at) VALUES
  ('pdbt-user', 'plugins db test', 'pdbt-user@example.invalid', now()),
  ('pdbt-other', 'plugins db test', 'pdbt-other@example.invalid', now());
INSERT INTO projects (id, user_id, name, updated_at) VALUES ('pdbt-project', 'pdbt-user', 'pdbt', now());
INSERT INTO plugin_installs (plugin_id, updated_at) VALUES ('pdbt-a', now()), ('pdbt-b', now());

-- One active override per point, scope and target, whatever plugin proposed it.
SELECT 'active_first:' || pg_temp.try(\$q\$ $OV ('o1','pdbt-a','skill.text','user','pdbt-user','pdbt-user',NULL,'sqli','sqli/workflow','cs1','x','$H','active','t',now()) \$q\$);
SELECT 'active_second:' || pg_temp.try(\$q\$ $OV ('o2','pdbt-a','skill.text','user','pdbt-user','pdbt-user',NULL,'sqli','sqli/workflow','cs2','x','$H','active','t',now()) \$q\$);
SELECT 'active_other_plugin:' || pg_temp.try(\$q\$ $OV ('o3','pdbt-b','skill.text','user','pdbt-user','pdbt-user',NULL,'sqli','sqli/workflow','cs3','x','$H','active','t',now()) \$q\$);
SELECT 'superseded_same_target:' || pg_temp.try(\$q\$ $OV ('o4','pdbt-a','skill.text','user','pdbt-user','pdbt-user',NULL,'sqli','sqli/workflow','cs4','x','$H','superseded','t',now()) \$q\$);
SELECT 'active_project_scope:' || pg_temp.try(\$q\$ $OV ('o5','pdbt-a','skill.text','project','pdbt-project',NULL,'pdbt-project','sqli','sqli/workflow','cs5','x','$H','active','t',now()) \$q\$);
SELECT 'active_other_user:' || pg_temp.try(\$q\$ $OV ('o6','pdbt-b','skill.text','user','pdbt-other','pdbt-other',NULL,'sqli','sqli/workflow','cs6','x','$H','active','t',now()) \$q\$);

-- Scope columns must name exactly the scope's owner.
SELECT 'scope_user_with_project:' || pg_temp.try(\$q\$ $OV ('o7','pdbt-a','skill.text','user','pdbt-user','pdbt-user','pdbt-project','xss','xss/workflow','cs7','x','$H','proposed','t',now()) \$q\$);
SELECT 'scope_user_mismatch:' || pg_temp.try(\$q\$ $OV ('o8','pdbt-a','skill.text','user','pdbt-user','pdbt-other',NULL,'xss','xss/workflow','cs8','x','$H','proposed','t',now()) \$q\$);
SELECT 'scope_project_with_user:' || pg_temp.try(\$q\$ $OV ('o9','pdbt-a','skill.text','project','pdbt-project','pdbt-user','pdbt-project','xss','xss/workflow','cs9','x','$H','proposed','t',now()) \$q\$);
SELECT 'scope_unknown_type:' || pg_temp.try(\$q\$ $OV ('o10','pdbt-a','skill.text','team','pdbt-user','pdbt-user',NULL,'xss','xss/workflow','cs10','x','$H','proposed','t',now()) \$q\$);
SELECT 'override_bad_status:' || pg_temp.try(\$q\$ $OV ('o11','pdbt-a','skill.text','user','pdbt-user','pdbt-user',NULL,'xss','xss/workflow','cs11','x','$H','deleted','t',now()) \$q\$);
SELECT 'install_bad_status:' || pg_temp.try(\$q\$ INSERT INTO plugin_installs (plugin_id, status, updated_at) VALUES ('pdbt-c', 'installed', now()) \$q\$);

-- Owner columns of plugin data must name exactly the owner.
SELECT 'data_user:' || pg_temp.try(\$q\$ $DA ('d1','pdbt-a','user','pdbt-user','pdbt-user',NULL,'c','k1','{}',2,now()) \$q\$);
SELECT 'data_user_with_project:' || pg_temp.try(\$q\$ $DA ('d2','pdbt-a','user','pdbt-user','pdbt-user','pdbt-project','c','k2','{}',2,now()) \$q\$);
SELECT 'data_user_mismatch:' || pg_temp.try(\$q\$ $DA ('d3','pdbt-a','user','pdbt-user','pdbt-other',NULL,'c','k3','{}',2,now()) \$q\$);
SELECT 'data_project:' || pg_temp.try(\$q\$ $DA ('d4','pdbt-a','project','pdbt-project',NULL,'pdbt-project','c','k4','{}',2,now()) \$q\$);
SELECT 'data_project_with_user:' || pg_temp.try(\$q\$ $DA ('d5','pdbt-a','project','pdbt-project','pdbt-user','pdbt-project','c','k5','{}',2,now()) \$q\$);
SELECT 'data_duplicate_key:' || pg_temp.try(\$q\$ $DA ('d6','pdbt-a','user','pdbt-user','pdbt-user',NULL,'c','k1','{}',2,now()) \$q\$);
SELECT 'data_other_user:' || pg_temp.try(\$q\$ $DA ('d7','pdbt-b','user','pdbt-other','pdbt-other',NULL,'c','k1','{}',2,now()) \$q\$);

-- Cascades. pdbt-other owns d7 and o6; pdbt-project owns d4 and o5; plugin pdbt-b
-- owns o3 (refused above, so nothing) and d7, o6.
SELECT 'other_rows_before:' || ((SELECT count(*) FROM plugin_data WHERE user_id = 'pdbt-other')
  + (SELECT count(*) FROM plugin_overrides WHERE user_id = 'pdbt-other'));
DELETE FROM users WHERE id = 'pdbt-other';
SELECT 'other_rows_after:' || ((SELECT count(*) FROM plugin_data WHERE owner_id = 'pdbt-other')
  + (SELECT count(*) FROM plugin_overrides WHERE scope_id = 'pdbt-other'));

SELECT 'project_rows_before:' || ((SELECT count(*) FROM plugin_data WHERE project_id = 'pdbt-project')
  + (SELECT count(*) FROM plugin_overrides WHERE project_id = 'pdbt-project'));
DELETE FROM projects WHERE id = 'pdbt-project';
SELECT 'project_rows_after:' || ((SELECT count(*) FROM plugin_data WHERE owner_id = 'pdbt-project')
  + (SELECT count(*) FROM plugin_overrides WHERE scope_id = 'pdbt-project'));
SELECT 'user_rows_kept:' || ((SELECT count(*) FROM plugin_data WHERE user_id = 'pdbt-user')
  + (SELECT count(*) FROM plugin_overrides WHERE user_id = 'pdbt-user'));

INSERT INTO plugin_data (id, plugin_id, owner_type, owner_id, user_id, collection, key, value, size_bytes, updated_at)
  VALUES ('d8', 'pdbt-b', 'user', 'pdbt-user', 'pdbt-user', 'c', 'k8', '{}', 2, now());
SELECT 'plugin_rows_before:' || ((SELECT count(*) FROM plugin_data WHERE plugin_id = 'pdbt-b')
  + (SELECT count(*) FROM plugin_overrides WHERE plugin_id = 'pdbt-b'));
DELETE FROM plugin_installs WHERE plugin_id = 'pdbt-b';
SELECT 'plugin_rows_after:' || ((SELECT count(*) FROM plugin_data WHERE plugin_id = 'pdbt-b')
  + (SELECT count(*) FROM plugin_overrides WHERE plugin_id = 'pdbt-b'));
SELECT 'other_plugin_kept:' || ((SELECT count(*) FROM plugin_data WHERE plugin_id = 'pdbt-a')
  + (SELECT count(*) FROM plugin_overrides WHERE plugin_id = 'pdbt-a'));
ROLLBACK;
SQL
)
rc=$?
if [ $rc -ne 0 ]; then
  bad "the constraint and cascade cases run on Postgres" "$OUT"
  echo "== $pass passed, $fail failed =="
  exit 1
fi
ok "the constraint and cascade cases run on Postgres"

field() { printf '%s\n' "$OUT" | sed -n "s/^$1://p" | head -1; }

expect_eq "the one-active index exists, unique and partial on status active" \
  "CREATE UNIQUE INDEX plugin_overrides_one_active ON public.plugin_overrides USING btree (extension_point, scope_type, scope_id, target_key) WHERE (status = 'active'::text)" \
  "$(field index_def)"
expect_eq "the four CHECK constraints exist" \
  "plugin_data_owner_ck1,plugin_installs_status_ck1,plugin_overrides_scope_ck1,plugin_overrides_status_ck1" \
  "$(field checks)"

expect_eq "a first active override is accepted" "ok" "$(field active_first)"
expect_eq "a second active override for the same target is refused" "23505" "$(field active_second)"
expect_eq "...also when another plugin proposed it" "23505" "$(field active_other_plugin)"
expect_eq "a superseded row for the same target is accepted" "ok" "$(field superseded_same_target)"
expect_eq "the same target in a project scope is a different key" "ok" "$(field active_project_scope)"
expect_eq "the same target in another user's scope is a different key" "ok" "$(field active_other_user)"

expect_eq "a user-scope override carrying a project id is refused" "23514" "$(field scope_user_with_project)"
expect_eq "a user-scope override whose user id is not its scope id is refused" "23514" "$(field scope_user_mismatch)"
expect_eq "a project-scope override carrying a user id is refused" "23514" "$(field scope_project_with_user)"
expect_eq "an unknown scope type is refused" "23514" "$(field scope_unknown_type)"
expect_eq "an unknown override status is refused" "23514" "$(field override_bad_status)"
expect_eq "an unknown install status is refused" "23514" "$(field install_bad_status)"

expect_eq "a user-owned data row is accepted" "ok" "$(field data_user)"
expect_eq "a user-owned data row carrying a project id is refused" "23514" "$(field data_user_with_project)"
expect_eq "a user-owned data row whose user id is not its owner is refused" "23514" "$(field data_user_mismatch)"
expect_eq "a project-owned data row is accepted" "ok" "$(field data_project)"
expect_eq "a project-owned data row carrying a user id is refused" "23514" "$(field data_project_with_user)"
expect_eq "the same plugin, namespace, owner, collection and key twice is refused" "23505" "$(field data_duplicate_key)"
expect_eq "the same collection and key for another owner and plugin is accepted" "ok" "$(field data_other_user)"

expect_eq "the deleted user owned plugin rows" "2" "$(field other_rows_before)"
expect_eq "deleting a user deletes its plugin data and overrides" "0" "$(field other_rows_after)"
expect_eq "the deleted project owned plugin rows" "2" "$(field project_rows_before)"
expect_eq "deleting a project deletes its plugin data and overrides" "0" "$(field project_rows_after)"
expect_eq "another owner's rows survive both deletions" "3" "$(field user_rows_kept)"
expect_eq "the deleted plugin owned rows" "1" "$(field plugin_rows_before)"
expect_eq "deleting a plugin_installs row deletes its data and overrides" "0" "$(field plugin_rows_after)"
expect_eq "another plugin's rows survive" "3" "$(field other_plugin_kept)"

# --- Races between two real sessions ------------------------------------------
# Copies of the plugin tables (indexes and CHECKs included) in a throwaway schema,
# committed so two sessions can see them, dropped on exit.
S="plugins_dbtest_$$"
cleanup() { "${PSQL[@]}" -c "DROP SCHEMA IF EXISTS $S CASCADE" >/dev/null 2>&1; }
trap cleanup EXIT
"${PSQL[@]}" -c "CREATE SCHEMA $S;
  CREATE TABLE $S.plugin_installs (LIKE public.plugin_installs INCLUDING ALL);
  CREATE TABLE $S.plugin_overrides (LIKE public.plugin_overrides INCLUDING ALL);
  CREATE TABLE $S.plugin_platform_state (LIKE public.plugin_platform_state INCLUDING ALL);" >/dev/null

# race <name> <sql-first> <sql-second>: runs the first statement block in session A,
# holding its transaction open for 3 s; starts session B once A is sleeping, and
# records whether B then waited on a lock. Each block prints `A:...`/`B:...` lines.
race() {
  local name=$1 sqlA=$2 sqlB=$3 outA outB
  outA=$(mktemp); outB=$(mktemp)
  docker compose exec -T -e PGAPPNAME="pdbt_A_$$" postgres psql -U redamon -d redamon -qtAX \
    -v ON_ERROR_STOP=1 -c "BEGIN" -c "$sqlA" -c "SELECT pg_sleep(3)" -c "COMMIT" >"$outA" 2>&1 &
  local pidA=$!
  for _ in $(seq 1 50); do
    [ "$("${PSQL[@]}" -c "select count(*) from pg_stat_activity where application_name = 'pdbt_A_$$' and query like '%pg_sleep%'")" = 1 ] && break
    sleep 0.2
  done
  docker compose exec -T -e PGAPPNAME="pdbt_B_$$" postgres psql -U redamon -d redamon -qtAX \
    -v ON_ERROR_STOP=1 -c "BEGIN" -c "$sqlB" -c "COMMIT" >"$outB" 2>&1 &
  local pidB=$! waited=no
  for _ in $(seq 1 25); do
    if [ "$("${PSQL[@]}" -c "select count(*) from pg_stat_activity where application_name = 'pdbt_B_$$' and wait_event_type = 'Lock'")" = 1 ]; then
      waited=yes; break
    fi
    sleep 0.2
  done
  wait $pidA; wait $pidB
  RACE_OUT="$(cat "$outA" "$outB")
${name}_waited:$waited"
  rm -f "$outA" "$outB"
}
rfield() { printf '%s\n' "$RACE_OUT" | sed -n "s/^$1://p" | head -1; }

# Two installs of one plugin, the registry's compare-and-swap: one UPDATE per side.
"${PSQL[@]}" -c "INSERT INTO $S.plugin_installs (plugin_id, status, updated_at) VALUES ('race', 'available', now())" >/dev/null
CAS="UPDATE $S.plugin_installs SET status = 'installing', operation_id = '%s',
  lease_expires_at = now() + interval '10 minutes', updated_at = now()
  WHERE plugin_id = 'race' AND status IN ('available')
    AND (operation_id IS NULL OR lease_expires_at < now()) RETURNING 1"
race cas "WITH u AS ($(printf "$CAS" A)) SELECT 'A:' || count(*) FROM u" \
         "WITH u AS ($(printf "$CAS" B)) SELECT 'B:' || count(*) FROM u"
expect_eq "install race: session B waited on A's row lock" "yes" "$(rfield cas_waited)"
expect_eq "install race: the first compare-and-swap updates the row" "1" "$(rfield A)"
expect_eq "install race: the second, re-checked after A commits, updates nothing" "0" "$(rfield B)"
expect_eq "install race: the row belongs to the winner" "A" \
  "$("${PSQL[@]}" -c "select operation_id from $S.plugin_installs where plugin_id = 'race'")"

# --- What Prisma sends to Postgres -----------------------------------------------
# The data store relies on two facts about the Prisma client in the webapp image,
# checked here through Prisma itself, inside a transaction that is always rolled back:
# `startsWith` is an UNESCAPED LIKE pattern (so `_` is a wildcard and the store must
# escape: likePrefix), and the escaped form matches literally.
if docker compose exec -T webapp true >/dev/null 2>&1; then
  PRISMA_PROBE=$(cat <<'JS'
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
const ROLLBACK = new Error('rollback')
const notLike = (prefix) => ({ pluginId: 'pdbt-like', NOT: { collection: { startsWith: prefix } } })
p.$transaction(async (tx) => {
  await tx.user.create({ data: { id: 'pdbt-like-u', name: 'pdbt', email: 'pdbt-like@example.invalid' } })
  await tx.pluginInstall.create({ data: { pluginId: 'pdbt-like' } })
  for (const collection of ['ab', '__jobs']) {
    await tx.pluginData.create({ data: { pluginId: 'pdbt-like', ownerType: 'user', ownerId: 'pdbt-like-u',
      userId: 'pdbt-like-u', collection, key: 'k', value: 1, sizeBytes: 1 } })
  }
  console.log('like_raw:' + await tx.pluginData.count({ where: notLike('__') }))
  console.log('like_escaped:' + await tx.pluginData.count({ where: notLike('\\_\\_') }))
  throw ROLLBACK
}).catch((e) => { if (e !== ROLLBACK) { console.log('like_error:' + e.message); process.exitCode = 1 } })
  .finally(() => p.$disconnect())
JS
)
  PROBE_OUT=$(docker compose exec -T webapp node -e "$PRISMA_PROBE" 2>&1)
  pfield() { printf '%s\n' "$PROBE_OUT" | sed -n "s/^$1://p" | head -1; }
  expect_eq "Prisma sends startsWith unescaped: '__' also matches 'ab'" "0" "$(pfield like_raw)"
  expect_eq "the escaped prefix the data store sends matches literally" "1" "$(pfield like_escaped)"
  [ -n "$(pfield like_error)" ] && bad "the Prisma probe runs" "$(pfield like_error)"
else
  echo "  SKIP  Prisma LIKE probe: webapp container not running"
fi

COUNTS_AFTER=$("${PSQL[@]}" -c "$COUNTS_SQL")
expect_eq "existing tables' row counts are unchanged" "$COUNTS_BEFORE" "$COUNTS_AFTER"

echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
