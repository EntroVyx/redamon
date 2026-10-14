#!/usr/bin/env bash
# Latest Skiller job: status | progress | result/error message.
# Usage: skiller_job.sh [poll]   (poll: wait until the job finishes, up to ~6 min)
q() {
  docker exec -i redamon-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F" | "' <<'SQL'
select value->>'status',
       coalesce(value->'progress'->>'message', value->'progress'->>'label', ''),
       left(coalesce(value->'error'->>'message', value->'result'->>'message', ''), 160)
from plugin_data where plugin_id='skiller' and collection='__jobs'
order by value->>'createdAt' desc limit 1;
SQL
}
if [ "${1:-}" != "poll" ]; then q; exit 0; fi
for i in $(seq 1 24); do
  row=$(q); echo "[$((i*15))s] $row"
  case "$row" in succeeded*|failed*|cancelled*|no_improvement*) exit 0;; esac
  sleep 15
done
