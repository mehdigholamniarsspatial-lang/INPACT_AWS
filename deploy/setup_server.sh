#!/usr/bin/env bash
# First-time setup on a fresh Ubuntu 24.04 Lightsail instance. Run from the repo folder:
#   cd ~/INPACT_AWS && bash deploy/setup_server.sh
# Safe to run again: it only adds what is missing.
set -euo pipefail
APP=/home/ubuntu/INPACT_AWS
DOMAIN=inpact-epa.ie                               # and www.$DOMAIN; HTTPS: deploy/enable_https.sh
cd "$APP"

# 1 GB of RAM is tight for pip-installing scipy/pandas: add a 2 GB swap file once
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

# SSH: keys only (Lightsail default), no root login, no X11 forwarding, few attempts per connection
printf 'PermitRootLogin no\nX11Forwarding no\nMaxAuthTries 3\nPasswordAuthentication no\n' \
  | sudo tee /etc/ssh/sshd_config.d/60-inpact-hardening.conf >/dev/null
sudo sshd -t && sudo systemctl reload ssh

sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv python3-pip nginx
# nginx buffers large responses (the ~1 MB page, images) in these folders; if they are not owned
# by its worker user (www-data), every large file is cut off and the dashboard loads half-empty
sudo chown -R www-data:root /var/lib/nginx/body /var/lib/nginx/proxy /var/lib/nginx/fastcgi \
  /var/lib/nginx/uwsgi /var/lib/nginx/scgi 2>/dev/null || true

# Python environment
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

# Settings outside the repo (secret key, allowed hosts)
sudo mkdir -p /etc/inpact
if [ ! -f /etc/inpact/inpact.env ]; then
  IP=$(curl -s --max-time 5 https://checkip.amazonaws.com || true)
  KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))")
  printf 'SECRET_KEY=%s\nDEBUG=0\nALLOWED_HOSTS=%s\nCSRF_TRUSTED_ORIGINS=%s\n' "$KEY" \
    "${IP:+$IP,}$DOMAIN,www.$DOMAIN" "https://$DOMAIN,https://www.$DOMAIN" \
    | sudo tee /etc/inpact/inpact.env >/dev/null
  sudo chmod 640 /etc/inpact/inpact.env && sudo chown root:www-data /etc/inpact/inpact.env
fi

.venv/bin/python manage.py collectstatic --noinput
bash deploy/ensure_feedback.sh                     # survey storage, download key, daily backup
# Deployment check with the real settings (the env file is readable by root only)
sudo bash -c 'set -a; . /etc/inpact/inpact.env; set +a; .venv/bin/python manage.py check --deploy' || true

# gunicorn service + nginx site
sudo cp deploy/inpact.service /etc/systemd/system/inpact.service
# Keep HTTPS if enable_https.sh already got a certificate; otherwise the HTTP-only site
if sudo test -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem"; then
  sudo cp deploy/nginx-inpact-https.conf /etc/nginx/sites-available/inpact
else
  sudo cp deploy/nginx-inpact.conf /etc/nginx/sites-available/inpact
fi
sudo ln -sf /etc/nginx/sites-available/inpact /etc/nginx/sites-enabled/inpact
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now inpact
sudo systemctl restart inpact nginx
if sudo test -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem"; then
  echo "Done. Open https://$DOMAIN/"
else
  echo "Done. Open http://$(sudo grep ^ALLOWED_HOSTS /etc/inpact/inpact.env | cut -d= -f2 | cut -d, -f1)/"
  echo "For HTTPS on $DOMAIN (DNS pointing here, port 443 open in Lightsail): bash deploy/enable_https.sh"
fi
