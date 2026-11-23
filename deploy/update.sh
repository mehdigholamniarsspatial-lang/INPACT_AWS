#!/usr/bin/env bash
# Pull the latest code from GitHub and restart the site:  cd ~/INPACT_AWS && bash deploy/update.sh
set -euo pipefail
cd /home/ubuntu/INPACT_AWS
git pull --ff-only
.venv/bin/pip install -r requirements.txt --quiet
.venv/bin/python manage.py collectstatic --noinput
sudo systemctl restart inpact
echo "Updated to $(git log -1 --format='%h %s')"
