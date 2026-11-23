#!/usr/bin/env bash
# Survey storage on the server (safe to run any number of times; setup_server.sh and update.sh call it):
#  - responses go to /var/lib/inpact/feedback/responses.jsonl, outside the code folder, so a
#    git pull or a fresh clone never touches them
#  - FEEDBACK_DIR and a random FEEDBACK_ADMIN_KEY (the research team's download key) are added to
#    /etc/inpact/inpact.env if they are missing
#  - a daily copy of the responses is kept for 30 days in /var/lib/inpact/backup
set -euo pipefail
sudo mkdir -p /var/lib/inpact/feedback /var/lib/inpact/backup
sudo chown -R ubuntu:www-data /var/lib/inpact
sudo chmod 750 /var/lib/inpact /var/lib/inpact/feedback /var/lib/inpact/backup

ENV=/etc/inpact/inpact.env
if ! sudo grep -q '^FEEDBACK_DIR=' "$ENV"; then
  echo 'FEEDBACK_DIR=/var/lib/inpact/feedback' | sudo tee -a "$ENV" >/dev/null
fi
if ! sudo grep -q '^FEEDBACK_ADMIN_KEY=' "$ENV"; then
  KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(18))")
  echo "FEEDBACK_ADMIN_KEY=$KEY" | sudo tee -a "$ENV" >/dev/null
  echo "Created the research-team download key. Show it with:  sudo grep FEEDBACK_ADMIN_KEY $ENV"
fi
# Access keys of the four keyed respondent groups: 8 characters, a 2-letter group prefix
# (SH stakeholder, RS researcher, EX expert, PM policy maker) and 6 random characters without
# look-alikes (no 0/O, 1/I/L, 2/Z, 5/S, 8/B). Show them with:  sudo grep FEEDBACK_KEY_ $ENV
for pair in STAKEHOLDER:SH RESEARCHER:RS EXPERT:EX POLICYMAKER:PM; do
  NAME=${pair%%:*}; PFX=${pair##*:}
  if ! sudo grep -q "^FEEDBACK_KEY_${NAME}=" "$ENV"; then
    KEY=$(python3 -c "import secrets; a='ACDEFGHJKMNPQRTUVWXY34679'; print('$PFX' + ''.join(secrets.choice(a) for _ in range(6)))")
    echo "FEEDBACK_KEY_${NAME}=$KEY" | sudo tee -a "$ENV" >/dev/null
    echo "Created the access key for the ${NAME,,} group."
  fi
done

# Daily backup at 02:15 (keeps 30 days)
CRON=/etc/cron.d/inpact-feedback-backup
if [ ! -f "$CRON" ]; then
  sudo tee "$CRON" >/dev/null <<'EOF'
# INPACT survey: daily copy of the responses, kept for 30 days
15 2 * * * ubuntu [ -f /var/lib/inpact/feedback/responses.jsonl ] && cp /var/lib/inpact/feedback/responses.jsonl /var/lib/inpact/backup/responses_$(date +\%Y\%m\%d).jsonl && find /var/lib/inpact/backup -name 'responses_*.jsonl' -mtime +30 -delete
EOF
  sudo chmod 644 "$CRON"
fi
