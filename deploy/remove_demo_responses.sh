#!/usr/bin/env bash
# Remove the demonstration responses (client_id "demo-seed-...") from the survey data, keeping
# every real response. A copy of the file before the change is kept in /var/lib/inpact/backup.
#   ssh inpact-aws 'bash ~/INPACT_AWS/deploy/remove_demo_responses.sh'
set -euo pipefail
F=/var/lib/inpact/feedback/responses.jsonl
[ -f "$F" ] || { echo "No responses file."; exit 0; }
cp "$F" "/var/lib/inpact/backup/before_demo_removal_$(date +%Y%m%d_%H%M%S).jsonl"
python3 - "$F" <<'EOF'
import json, sys
path = sys.argv[1]
keep, removed = [], 0
for line in open(path, encoding="utf-8"):
    if not line.strip():
        continue
    try:
        demo = str(json.loads(line).get("client_id") or "").startswith("demo-seed-")
    except ValueError:
        demo = False
    if demo:
        removed += 1
    else:
        keep.append(line if line.endswith("\n") else line + "\n")
open(path, "w", encoding="utf-8").writelines(keep)
print(f"Removed {removed} demo responses; {len(keep)} real responses kept.")
EOF
