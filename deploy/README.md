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

## Policy consultation (Feedback tab)

The questionnaires are defined in `explorer/feedback_survey.py` (one place for the form, the
validation, the results and the export codebook; bump `SURVEY_VERSION` when questions change).
Respondents choose one of five groups, each with its own questionnaire. Members of the public
need no key; stakeholders, researchers, experts and policy makers enter their group's access key
(`FEEDBACK_KEY_STAKEHOLDER`, `_RESEARCHER`, `_EXPERT`, `_POLICYMAKER` in `/etc/inpact/inpact.env`,
created by `deploy/ensure_feedback.sh`). The same keys open the results dashboard; a group's answers
are charted from `FEEDBACK_MIN_CELL` responses (default 3).

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

## Logs

    sudo journalctl -u inpact -f          # Django / gunicorn
    sudo tail -f /var/log/nginx/error.log # nginx

If the instance's public IP changes (no static IP attached), update `ALLOWED_HOSTS`
in `/etc/inpact/inpact.env` and restart the service.
