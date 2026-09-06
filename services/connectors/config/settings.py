import json
import os
from pathlib import Path
from urllib.parse import urlparse

BASE_DIR = Path(__file__).resolve().parent.parent
CONNECTORS_ENVIRONMENT = os.getenv("CONNECTORS_ENVIRONMENT", "development").lower()
SECRET_KEY = os.getenv("CONNECTORS_DJANGO_SECRET_KEY", "unsafe-local-only")
DEBUG = os.getenv("CONNECTORS_DEBUG", "").lower() in {"1", "true"}
ALLOWED_HOSTS = [
    value
    for value in os.getenv(
        "CONNECTORS_ALLOWED_HOSTS", "localhost,127.0.0.1,testserver"
    ).split(",")
    if value
]
INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "connectors",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
ROOT_URLCONF = "config.urls"
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "connectors" / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": ["django.template.context_processors.request"]
        },
    }
]
WSGI_APPLICATION = "config.wsgi.application"
DATABASE_URL = os.getenv("CONNECTORS_DATABASE_URL", "")
if DATABASE_URL:
    parsed = urlparse(DATABASE_URL)
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": parsed.path.lstrip("/"),
            "USER": parsed.username or "",
            "PASSWORD": parsed.password or "",
            "HOST": parsed.hostname or "",
            "PORT": str(parsed.port or 5432),
            "CONN_MAX_AGE": 60,
        }
    }
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "db.sqlite3",
        }
    }
USE_TZ = True
TIME_ZONE = "UTC"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
STATIC_URL = "/static/"
SESSION_COOKIE_SECURE = os.getenv("CONNECTORS_SECURE_COOKIES", "").lower() in {
    "1",
    "true",
}
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SECURE = SESSION_COOKIE_SECURE
CSRF_COOKIE_SAMESITE = "Lax"
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
CONNECTORS_ENCRYPTION_KEY = os.getenv("CONNECTORS_ENCRYPTION_KEY", "")
CONNECTORS_ENCRYPTION_KEY_ID = os.getenv("CONNECTORS_ENCRYPTION_KEY_ID", "default")
CONNECTORS_ALLOWED_SUBJECTS = {
    item.strip()
    for item in os.getenv("CONNECTORS_ALLOWED_SUBJECTS", "").split(",")
    if item.strip()
}
try:
    CONNECTORS_PROVIDER_ALLOWLIST = json.loads(
        os.getenv("CONNECTORS_PROVIDER_ALLOWLIST", "{}")
    )
except json.JSONDecodeError as exc:
    raise RuntimeError("CONNECTORS_PROVIDER_ALLOWLIST must be JSON") from exc
if not isinstance(CONNECTORS_PROVIDER_ALLOWLIST, dict) or any(
    not isinstance(key, str)
    or not isinstance(value, list)
    or any(not isinstance(subject, str) or not subject for subject in value)
    for key, value in CONNECTORS_PROVIDER_ALLOWLIST.items()
):
    raise RuntimeError(
        "CONNECTORS_PROVIDER_ALLOWLIST must map provider keys to subject-id arrays, "
        'where ["*"] opens a provider to every subject'
    )
CONNECTORS_PUBLIC_BASE_URL = os.getenv(
    "CONNECTORS_PUBLIC_BASE_URL", "http://localhost:8010"
).rstrip("/")
CONNECTORS_LOGIN_TTL_SECONDS = int(os.getenv("CONNECTORS_LOGIN_TTL_SECONDS", "600"))
CONNECTORS_CODE_TTL_SECONDS = int(os.getenv("CONNECTORS_CODE_TTL_SECONDS", "60"))
CONNECTORS_PAGE_TTL_HOURS = int(os.getenv("CONNECTORS_PAGE_TTL_HOURS", "24"))
CONNECTORS_RUN_STALE_SECONDS = int(os.getenv("CONNECTORS_RUN_STALE_SECONDS", "900"))
CONNECTORS_AUTH_ATTEMPTS_PER_MINUTE = int(
    os.getenv("CONNECTORS_AUTH_ATTEMPTS_PER_MINUTE", "6")
)
CONNECTORS_RUNS_PER_MINUTE = int(os.getenv("CONNECTORS_RUNS_PER_MINUTE", "6"))
# Consecutive runs of one provider are spaced out so a burst of manual syncs
# reaches the supplier's site as a queue rather than all at once.
CONNECTORS_PROVIDER_RUN_GAP_SECONDS = float(
    os.getenv("CONNECTORS_PROVIDER_RUN_GAP_SECONDS", "30")
)
if CONNECTORS_PROVIDER_RUN_GAP_SECONDS < 0:
    raise RuntimeError("CONNECTORS_PROVIDER_RUN_GAP_SECONDS must be zero or more")
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {
        "handlers": ["console"],
        "level": os.getenv("CONNECTORS_LOG_LEVEL", "INFO"),
    },
}

if CONNECTORS_ENVIRONMENT == "production":
    SECURE_SSL_REDIRECT = True
    SECURE_HSTS_SECONDS = 31_536_000
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True
    SECURE_CONTENT_TYPE_NOSNIFF = True
    SECURE_REFERRER_POLICY = "same-origin"
    failures = []
    if SECRET_KEY == "unsafe-local-only" or len(SECRET_KEY) < 32:
        failures.append("CONNECTORS_DJANGO_SECRET_KEY")
    if DEBUG:
        failures.append("CONNECTORS_DEBUG must be false")
    if not DATABASE_URL or not DATABASE_URL.startswith(
        ("postgres://", "postgresql://")
    ):
        failures.append("CONNECTORS_DATABASE_URL PostgreSQL")
    if not CONNECTORS_PUBLIC_BASE_URL.startswith("https://"):
        failures.append("CONNECTORS_PUBLIC_BASE_URL HTTPS")
    if not SESSION_COOKIE_SECURE or not CSRF_COOKIE_SECURE:
        failures.append("CONNECTORS_SECURE_COOKIES")
    try:
        encryption_key_valid = len(bytes.fromhex(CONNECTORS_ENCRYPTION_KEY)) == 32
    except ValueError:
        encryption_key_valid = False
    if not encryption_key_valid:
        failures.append("CONNECTORS_ENCRYPTION_KEY (64 hex characters)")
    if not CONNECTORS_PROVIDER_ALLOWLIST:
        failures.append("CONNECTORS_PROVIDER_ALLOWLIST")
    if "*" in ALLOWED_HOSTS or not ALLOWED_HOSTS:
        failures.append("CONNECTORS_ALLOWED_HOSTS")
    if failures:
        raise RuntimeError(
            "Unsafe connector production configuration: " + ", ".join(failures)
        )
