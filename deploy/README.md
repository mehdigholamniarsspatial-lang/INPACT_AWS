# Running INPACT on AWS Lightsail

The dashboard runs on an Ubuntu 24.04 Lightsail instance as:

    browser --> nginx (port 80) --> gunicorn (127.0.0.1:8000) --> Django

| File | Goes to | Purpose |
|---|---|---|
| `inpact.service` | `/etc/systemd/system/` | keeps gunicorn running, restarts it on failure and at boot |
| `nginx-inpact.conf` | `/etc/nginx/sites-available/inpact` | public web server on port 80 |
| `setup_server.sh` | run once | swap file, packages, virtualenv, settings, services |
| `update.sh` | run after each push | `git pull`, install requirements, restart |

Settings that must not be in Git live in `/etc/inpact/inpact.env` on the server
(`SECRET_KEY`, `DEBUG=0`, `ALLOWED_HOSTS`, optional `CSRF_TRUSTED_ORIGINS`,
`GITHUB_TOKEN` for the feedback form). After editing it: `sudo systemctl restart inpact`.

## First install

    ssh inpact-aws
    git clone https://github.com/mehdigholamniarsspatial-lang/INPACT_AWS.git ~/INPACT_AWS
    cd ~/INPACT_AWS && bash deploy/setup_server.sh

## Updating

Commit and push from the `InpactAWS` folder, then:

    ssh inpact-aws 'cd ~/INPACT_AWS && bash deploy/update.sh'

## Logs

    sudo journalctl -u inpact -f          # Django / gunicorn
    sudo tail -f /var/log/nginx/error.log # nginx

If the instance's public IP changes (no static IP attached), update `ALLOWED_HOSTS`
in `/etc/inpact/inpact.env` and restart the service.
