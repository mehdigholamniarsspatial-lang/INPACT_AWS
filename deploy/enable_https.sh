#!/usr/bin/env bash
# Serve the site on https://inpact-epa.ie (and www) with a free Let's Encrypt certificate.
#   cd ~/INPACT_AWS && bash deploy/enable_https.sh
# Before running: the domain's A records (@ and www) point to this server's static IP
# (DNS zone at Blacknight), and Lightsail's firewall allows HTTPS (TCP 443) as well as HTTP (80).
# Optional: CERTBOT_EMAIL=you@example.org bash deploy/enable_https.sh  (certificate expiry warnings)
# Safe to run again: it only adds what is missing. Certbot renews the certificate on its own.
set -euo pipefail
APP=/home/ubuntu/INPACT_AWS
DOMAIN=inpact-epa.ie
ENV=/etc/inpact/inpact.env
CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem
cd "$APP"

# 1. Django must accept the domain and trust form posts (Feedback tab) from its HTTPS origin
add_to_list() {   # add_to_list VAR value: append value to the comma-separated VAR line in $ENV
  local var=$1 val=$2
  if ! sudo grep -q "^$var=" "$ENV"; then
    echo "$var=$val" | sudo tee -a "$ENV" >/dev/null
  elif ! sudo grep "^$var=" "$ENV" | cut -d= -f2- | tr ',' '\n' | grep -qxF "$val"; then
    sudo sed -i "s#^$var=\(.\+\)\$#$var=\1,$val#; s#^$var=\$#$var=$val#" "$ENV"
  fi
}
for h in "$DOMAIN" "www.$DOMAIN"; do
  add_to_list ALLOWED_HOSTS "$h"
  add_to_list CSRF_TRUSTED_ORIGINS "https://$h"
done

# 2. Certificate (the nginx plugin answers Let's Encrypt's check on port 80)
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y certbot python3-certbot-nginx
if ! sudo test -f "$CERT"; then
  if [ -n "${CERTBOT_EMAIL:-}" ]; then ACCOUNT=(-m "$CERTBOT_EMAIL"); else ACCOUNT=(--register-unsafely-without-email); fi
  sudo certbot certonly --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos "${ACCOUNT[@]}"
fi
for f in /etc/letsencrypt/options-ssl-nginx.conf /etc/letsencrypt/ssl-dhparams.pem; do
  sudo test -f "$f" || { echo "Missing $f (normally written by certbot's nginx plugin)" >&2; exit 1; }
done

# 3. Django's HTTPS-only settings (redirect, HSTS for one year, secure cookies): see settings.py
for kv in SECURE_SSL_REDIRECT=1 SECURE_HSTS_SECONDS=31536000; do
  sudo grep -q "^${kv%%=*}=" "$ENV" || echo "$kv" | sudo tee -a "$ENV" >/dev/null
done

# 4. HTTPS site; port 80 (domain, www and the bare IP) redirects to it
sudo cp deploy/nginx-inpact-https.conf /etc/nginx/sites-available/inpact
sudo ln -sf /etc/nginx/sites-available/inpact /etc/nginx/sites-enabled/inpact
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl restart inpact
echo "Done. Open https://$DOMAIN/  (renewal test: sudo certbot renew --dry-run)"
