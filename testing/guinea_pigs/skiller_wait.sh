#!/usr/bin/env bash
# Poll a session until the agent stops running (or timeout). Prints a status
# line each tick and exits 0 when agent_running is no longer true.
# Usage: skiller_wait.sh <session_id_substring> [max_seconds] [interval_seconds]
SID="${1:?session id substring}"
MAX="${2:-3000}"
INT="${3:-30}"
start=$(date +%s)
while :; do
  row=$(docker exec -i -e SIDV="%${SID}%" redamon-postgres sh -c \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F"|" -c "select agent_running, current_phase, iteration_count from conversations where session_id like '\''$SIDV'\'' order by created_at desc limit 1"')
  running=${row%%|*}
  now=$(date +%s); el=$((now-start))
  echo "[$(date +%H:%M:%S) +${el}s] $row"
  if [ "$running" != "t" ]; then echo "STOPPED"; exit 0; fi
  if [ "$el" -ge "$MAX" ]; then echo "TIMEOUT"; exit 2; fi
  sleep "$INT"
done
