#!/usr/bin/env bash
# Confirm the agent's settings payload carries the active skill-text override.
# Usage: skiller_verify_override.sh <project_id>
PID="${1:?project id}"
K=$(grep -E '^INTERNAL_API_KEY=' "$(dirname "$0")/../../.env" | cut -d= -f2- | tr -d '"'"'"'"'"'"'"')
curl -s -H "X-Internal-Key: $K" \
  "http://localhost:3000/api/projects/${PID}?includeSkillContent=true&includeSkillOverrides=true" \
| python3 -c '
import sys,json
d=json.load(sys.stdin)
o=d.get("skillTextOverrides") or {}
print("skillTextOverrides keys:", list(o.keys()))
for k,v in o.items():
    print("  ", k, "-> revision", v.get("revision"), "plugin", v.get("pluginId"), "len", len(v.get("value","")))
'
