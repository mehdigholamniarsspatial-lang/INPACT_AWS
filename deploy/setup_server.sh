#!/usr/bin/env bash
# First-time setup on a fresh Ubuntu 24.04 Lightsail instance. Run from the repo folder:
#   cd ~/INPACT_AWS && bash deploy/setup_server.sh
# Safe to run again: it only adds what is missing.
set -euo pipefail
APP=/home/ubuntu/INPACT_AWS
cd "$APP"

# 1 GB of RAM is tight for pip-installing scipy/pandas: add a 2 GB swap file once
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv python3-pip nginx

# Python environment
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

# Settings outside the repo (secret key, allowed hosts)
sudo mkdir -p /etc/inpact
if [ ! -f /etc/inpact/inpact.env ]; then
  IP=$(curl -s --max-time 5 https://checkip.amazonaws.com || true)
  KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))")
  printf 'SECRET_KEY=%s\nDEBUG=0\nALLOWED_HOSTS=%s\n' "$KEY" "$IP" | sudo tee /etc/inpact/inpact.env >/dev/null
  sudo chmod 640 /etc/inpact/inpact.env && sudo chown root:www-data /etc/inpact/inpact.env
fi

.venv/bin/python manage.py collectstatic --noinput
# Deployment check with the real settings (the env file is readable by root only)
sudo bash -c 'set -a; . /etc/inpact/inpact.env; set +a; .venv/bin/python manage.py check --deploy' || true

# gunicorn service + nginx site
sudo cp deploy/inpact.service /etc/systemd/system/inpact.service
sudo cp deploy/nginx-inpact.conf /etc/nginx/sites-available/inpact
sudo ln -sf /etc/nginx/sites-available/inpact /etc/nginx/sites-enabled/inpact
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now inpact
sudo systemctl restart inpact nginx
echo "Done. Open http://$(sudo grep ^ALLOWED_HOSTS /etc/inpact/inpact.env | cut -d= -f2 | cut -d, -f1)/"
