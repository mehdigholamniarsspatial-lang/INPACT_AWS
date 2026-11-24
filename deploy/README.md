# Running INPACT on AWS Lightsail

The dashboard runs on an Ubuntu 24.04 Lightsail instance at **https://inpact-epa.ie** as:

    browser --> nginx (443, HTTPS; 80 redirects) --> gunicorn (127.0.0.1:8000) --> Django

| File | Goes to | Purpose |
|---|---|---|
| `inpact.service` | `/etc/systemd/system/` | keeps gunicorn running, restarts it on failure and at boot |
| `nginx-inpact.conf` | `/etc/nginx/sites-available/inpact` | HTTP-only site, used until a certificate exists |
| `nginx-inpact-https.conf` | `/etc/nginx/sites-available/inpact` | HTTPS site; port 80 (domain, www, bare IP) redirects to `https://inpact-epa.ie` |
| `setup_server.sh` | run once | swap file, packages, virtualenv, settings, services |
| `enable_https.sh` | run once, after DNS | domain in the settings, Let's Encrypt certificate, HTTPS site |
| `update.sh` | run after each push | `git pull`, install requirements, restart (leaves nginx alone) |

Settings that must not be in Git live in `/etc/inpact/inpact.env` on the server
(`SECRET_KEY`, `DEBUG=0`, `ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, the feedback keys).
After editing it: `sudo systemctl restart inpact`. `CSRF_TRUSTED_ORIGINS` must list
`https://inpact-epa.ie,https://www.inpact-epa.ie`, or Feedback submissions over HTTPS fail with 403.

## First install

    ssh inpact-aws
    git clone https://github.com/mehdigholamniarsspatial-lang/INPACT_AWS.git ~/INPACT_AWS
    cd ~/INPACT_AWS && bash deploy/setup_server.sh

## Domain and HTTPS (inpact-epa.ie)

1. **Lightsail:** attach a static IP to the instance; in *Networking → IPv4 Firewall* allow HTTP (80)
   and HTTPS (443).
2. **Blacknight DNS zone** for inpact-epa.ie: A record `@` and A record `www`, both to the static IP.
   Check from a PC: `Resolve-DnsName inpact-epa.ie`.
3. **Server:** `cd ~/INPACT_AWS && bash deploy/enable_https.sh` (optionally with
   `CERTBOT_EMAIL=...` in front for expiry warnings).

`enable_https.sh` also sets `SECURE_SSL_REDIRECT=1` and `SECURE_HSTS_SECONDS=31536000` in the env file.
The certificate (Let's Encrypt, 90 days) renews itself through `certbot.timer`; test with
`sudo certbot renew --dry-run`. If the static IP changes, update both A records and `ALLOWED_HOSTS`.

## Updating

Commit and push from the `InpactAWS` folder, then:

    ssh inpact-aws 'cd ~/INPACT_AWS && bash deploy/update.sh'

## Policy consultation (Feedback tab)

The questionnaires are defined in `explorer/feedback_survey.py` (one place for the form, the
validation, the results and the export codebook; bump `SURVEY_VERSION` when questions change).
Respondents choose one of five groups, each with its own questionnaire. Members of the public
need no key; stakeholders, researchers, experts and policy makers enter their group's access key
(`FEEDBACK_KEY_STAKEHOLDER`, `_RESEARCHER`, `_EXPERT`, `_POLICYMAKER` in `/etc/inpact/inpact.env`,
created by `deploy/ensure_feedback.sh`). Key holders see the results dashboard as the last step, once
they have submitted (the server then issues a results pass kept in their browser for 90 days); members
of the public do not see results. A group's answers are charted from `FEEDBACK_MIN_CELL` responses (default 3).

* **The group keys:** `ssh inpact-aws 'sudo grep FEEDBACK_KEY_ /etc/inpact/inpact.env'`. To change a key,
  edit (or delete) its line, run `bash deploy/ensure_feedback.sh` to create a missing one, then
  `sudo systemctl restart inpact`. Access granted with an old key ends within 12 hours.
Responses are appended to `/var/lib/inpact/feedback/responses.jsonl`, outside the code folder,
and copied daily to `/var/lib/inpact/backup/` (30 days). `deploy/ensure_feedback.sh` sets this up.

* **Download:** Feedback tab → *Research team: download the responses* → enter the key →
  Excel (README, Responses, MultiSelect, MatrixRatings, PolicyRatings, PolicyComments, Codebook,
  Contacts; every table has a `group` column) or CSV tables in a zip.
* **The key:** `ssh inpact-aws 'sudo grep FEEDBACK_ADMIN_KEY /etc/inpact/inpact.env'`. To change it,
  edit that line and run `sudo systemctl restart inpact`.
* **Copy the raw file to your PC:** `scp inpact-aws:/var/lib/inpact/feedback/responses.jsonl .`
* The `Contacts` sheet holds personal data (e-mails of interview volunteers): keep it apart from
  the analysis files and delete it when the follow-up is done.

## Security

* **Django** (`inpact_platform/settings.py`): `DEBUG=0`, secret key only in the env file, CSRF and
  clickjacking middleware, HTTPS redirect, HSTS (1 year, this host only), secure cookies, nosniff,
  `Referrer-Policy: same-origin`. Check with the real settings:
  `sudo bash -c 'set -a; . /etc/inpact/inpact.env; set +a; .venv/bin/python manage.py check --deploy'`
  (W005, W019 and W021 are silenced on purpose; the reasons are in settings.py).
* **Feedback keys:** wrong group or research-team keys lock an address out for 15 minutes after 8
  attempts; nginx also limits `/api/feedback/` to 30 requests a minute per address (burst 30).
  The client address comes from `X-Real-IP`, which nginx overwrites, so it cannot be faked.
* **nginx:** TLS 1.2/1.3 only (certbot options), version hidden (`server_tokens off`), 2 MB body
  limit, `Permissions-Policy`; gunicorn listens on 127.0.0.1 only.
* **Server:** SSH keys only, no root login (`/etc/ssh/sshd_config.d/60-inpact-hardening.conf`),
  automatic security updates (`unattended-upgrades`). Reboot when `/var/run/reboot-required` exists.
  In Lightsail's firewall keep only 22, 80 and 443 open; ideally restrict 22 to known addresses.
* **Data:** `/etc/inpact/inpact.env` is `root:www-data 640`; `/var/lib/inpact` is `750`.

## Logs

    sudo journalctl -u inpact -f          # Django / gunicorn
    sudo tail -f /var/log/nginx/error.log # nginx
    sudo tail /var/log/letsencrypt/letsencrypt.log  # certificate renewals
