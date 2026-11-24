"""
Django settings for the INPACT / Ireland GHG Policy Impact Explorer platform.

Designed to run both locally and on Vercel's zero-configuration Django runtime.
"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------
# In production (Vercel), set SECRET_KEY as an environment variable.
SECRET_KEY = os.environ.get(
    "SECRET_KEY",
    "dev-only-insecure-key-change-me-in-production",
)

# DEBUG is off by default. Locally you can export DEBUG=1 to turn it on.
DEBUG = os.environ.get("DEBUG", "0") == "1"

# Vercel serves your app on *.vercel.app. Localhost covers local development.
# On AWS Lightsail, list the server's IP / domain in the ALLOWED_HOSTS environment
# variable (comma separated), e.g. ALLOWED_HOSTS=3.255.130.100,inpact.example.ie
_extra_hosts = [h.strip() for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h.strip()]
ALLOWED_HOSTS = [".vercel.app", "localhost", "127.0.0.1", *_extra_hosts]

# Vercel sits behind a proxy that terminates HTTPS. Extra origins (e.g. the AWS
# site once it has HTTPS) come from CSRF_TRUSTED_ORIGINS, comma separated.
CSRF_TRUSTED_ORIGINS = ["https://*.vercel.app", *[o.strip() for o in
    os.environ.get("CSRF_TRUSTED_ORIGINS", "").split(",") if o.strip()]]

# ---------------------------------------------------------------------------
# Applications
# ---------------------------------------------------------------------------
# Kept intentionally lean: the platform only serves a self-contained HTML page,
# so we avoid auth/sessions/DB machinery entirely.
INSTALLED_APPS = [
    "django.contrib.staticfiles",
    "explorer",
    # Ireland Climate Policy Timeline — mounted under /policy/ and shown in the
    # Explorer's "Policy Timeline" tab (see explorer/page/index.html).
    "policies",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    # WhiteNoise serves the files in explorer/static/ (e.g. /static/img/*.jpg)
    # directly from the app, so images work locally regardless of DEBUG and on
    # any host. On Vercel it coexists happily with the CDN that serves /static/.
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.middleware.common.CommonMiddleware",
    # The JSON endpoints (feedback, trend fit) are csrf_exempt and use no cookies;
    # the middleware protects anything added later by default.
    "django.middleware.csrf.CsrfViewMiddleware",
    # Clickjacking: pages may only be framed by this site (the Policy Timeline and
    # the map are shown in same-origin iframes).
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

# ---------------------------------------------------------------------------
# HTTPS and security headers
# ---------------------------------------------------------------------------
# nginx (AWS) and Vercel terminate HTTPS and always set X-Forwarded-Proto, so
# Django can tell a secure request apart. The HTTPS-only settings are switched on
# by environment variables, so local development over plain HTTP keeps working:
#   SECURE_SSL_REDIRECT=1  SECURE_HSTS_SECONDS=31536000   (in /etc/inpact/inpact.env)
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = os.environ.get("SECURE_SSL_REDIRECT", "0") == "1"
SECURE_HSTS_SECONDS = int(os.environ.get("SECURE_HSTS_SECONDS", "0") or 0)
SECURE_HSTS_INCLUDE_SUBDOMAINS = False      # only this host; subdomains are not ours to commit
SECURE_HSTS_PRELOAD = False
SESSION_COOKIE_SECURE = CSRF_COOKIE_SECURE = SECURE_SSL_REDIRECT
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
SECURE_CROSS_ORIGIN_OPENER_POLICY = "same-origin"
X_FRAME_OPTIONS = "SAMEORIGIN"
# Deliberate choices reported by `manage.py check --deploy`:
#   W019 X_FRAME_OPTIONS is SAMEORIGIN, not DENY: the Explorer frames its own Policy Timeline and map
#   W005/W021 HSTS covers this host only and is not preloaded: both are hard to undo, and a future
#   subdomain (or a move to a University / EPA address) should not be bound by them
SILENCED_SYSTEM_CHECKS = ["security.W019", "security.W005", "security.W021"]
# Largest request body Django will read (the feedback form checks its own 64 KB limit)
DATA_UPLOAD_MAX_MEMORY_SIZE = 1024 * 1024

ROOT_URLCONF = "inpact_platform.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": ["django.template.context_processors.request"]},
    },
]

WSGI_APPLICATION = "inpact_platform.wsgi.application"

# ---------------------------------------------------------------------------
# Database (read-only policy dataset)
# ---------------------------------------------------------------------------
# The Explorer itself needs no database. The Policy Timeline app reads a
# pre-built SQLite file that ships with the repo; the site never writes to it,
# so it also works on read-only serverless filesystems such as Vercel.
# Rebuild it with:  python manage.py load_policy_data
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "data" / "policy_timeline" / "policy_timeline.sqlite3",
    }
}

# Folder holding the Ireland core policy release (CSV/XLSX files) that the
# Policy Timeline loader and CSV download read from.
POLICY_DATA_DIR = Path(os.environ.get("POLICY_DATA_DIR", BASE_DIR / "data" / "policy_timeline"))

# Public attribution shown on the Policy Timeline's About page and citation.
SITE_INFO = {
    "title": "Ireland Climate Policy Timeline",
    "project": os.environ.get("SITE_PROJECT", "INPACT"),
    "authors": os.environ.get("SITE_AUTHORS", ""),
    "institution": os.environ.get("SITE_INSTITUTION", ""),
    "contact": os.environ.get("SITE_CONTACT", ""),
    "version": os.environ.get("SITE_DATA_VERSION", "25 September 2026"),
    "url": os.environ.get("SITE_URL", ""),
}

# ---------------------------------------------------------------------------
# Internationalization
# ---------------------------------------------------------------------------
LANGUAGE_CODE = "en-ie"
TIME_ZONE = "Europe/Dublin"
USE_I18N = True
USE_TZ = True

# ---------------------------------------------------------------------------
# Static files
# ---------------------------------------------------------------------------
# Vercel automatically runs collectstatic during the build when STATIC_ROOT
# is set, and serves the result from its CDN. The page itself inlines its
# images, so there is little to collect, but this keeps the build happy.
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

# Let WhiteNoise resolve static files via the staticfiles finders at runtime,
# so /static/img/*.jpg is served straight from explorer/static/ without having
# to run `collectstatic` first during local development. Vercel still runs
# collectstatic during its build, which keeps production serving from STATIC_ROOT.
WHITENOISE_USE_FINDERS = True

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
