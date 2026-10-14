#!/usr/bin/env bash
# Report an agent session's progress from Postgres: phase/iteration, the
# per-turn skill_workflow record (built-in playbook + revision Skiller reads),
# the last few tool calls and their outcome, and human/assistant messages.
# Usage: skiller_progress.sh <session_id_substring>
SID="${1:?session id substring}"
docker exec -i -e SIDV="%${SID}%" redamon-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
\set q `echo "$SIDV"`
\echo === conversation ===
select session_id, current_phase, iteration_count, agent_running from conversations where session_id like :'q';
\echo === skill_workflow per turn (what Skiller counts) ===
select m.data->>'iteration_count' it, m.data->>'current_phase' ph, m.data->>'attack_path_type' label, m.data->'skill_workflow' wf
  from chat_messages m join conversations c on c.id=m.conversation_id
  where c.session_id like :'q' and m.type='phase_update' and m.member_id_key is null
  order by m.sequence_num, m.created_at, m.id;
\echo === last 14 tool calls ===
select m.type t, m.data->>'tool_name' tool, m.data->>'success' ok, left(coalesce(m.data->>'output_summary',''),80) summ
  from chat_messages m join conversations c on c.id=m.conversation_id
  where c.session_id like :'q' and m.type in ('tool_start','tool_complete')
  order by m.sequence_num desc, m.id desc limit 14;
\echo === user + assistant + approvals ===
select m.type t, left(regexp_replace(coalesce(m.data->>'content',m.data->>'message',''),'\s+',' ','g'),140) txt
  from chat_messages m join conversations c on c.id=m.conversation_id
  where c.session_id like :'q' and m.type in ('user_message','assistant_message','approval_request')
  order by m.sequence_num, m.id;
SQL
