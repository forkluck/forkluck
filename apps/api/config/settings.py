import os
import sys
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


BASE_DIR = Path(__file__).resolve().parent.parent

# Local development reads backend/.env (gitignored); production supplies env
# through systemd's EnvironmentFile, which takes precedence via setdefault.
# A process that already declares itself production skips the file outright —
# a stray .env on a deployed host must never quietly satisfy the startup guard
# below.
_env_file = BASE_DIR / ".env"
if os.getenv("FORKLUCK_ENVIRONMENT", "").lower() != "production" and _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _key, _value = _line.split("=", 1)
            os.environ.setdefault(_key.strip(), _value.strip())


def env_bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).lower() in {"1", "true", "yes", "on"}


def env_list(name: str, default: str = "") -> list[str]:
    return [value.strip() for value in os.getenv(name, default).split(",") if value.strip()]


DEV_SECRET_KEY = "dev-only-forkluck-secret"
DEV_INTERNAL_SECRET = "dev-internal-secret"
DEV_ALLOWED_HOSTS = "localhost,127.0.0.1,testserver"
DEV_CSRF_TRUSTED_ORIGINS = "http://localhost:3000"
DEV_APP_ORIGIN = "http://localhost:3000"

SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", DEV_SECRET_KEY)
DEBUG = env_bool("DJANGO_DEBUG")
ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", DEV_ALLOWED_HOSTS)
CSRF_TRUSTED_ORIGINS = env_list(
    "DJANGO_CSRF_TRUSTED_ORIGINS", DEV_CSRF_TRUSTED_ORIGINS
)

INSTALLED_APPS = [
    "forkluck.apps.ForkluckAdminConfig",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "forkluck",
]

MIDDLEWARE = [
    "forkluck.http.timing.SlowRequestMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "timestamped": {
            "format": "{asctime} {levelname} {name} {message}",
            "style": "{",
        }
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "timestamped",
        }
    },
    "loggers": {"forkluck": {"handlers": ["console"], "level": "INFO"}},
}

ROOT_URLCONF = "config.urls"
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    }
]
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"


def database_from_url(url: str) -> dict[str, object]:
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    options: dict[str, str] = {}
    if query.get("sslmode"):
        options["sslmode"] = query["sslmode"][0]
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": unquote(parsed.path.lstrip("/")),
        "USER": unquote(parsed.username or ""),
        "PASSWORD": unquote(parsed.password or ""),
        "HOST": parsed.hostname or "",
        "PORT": str(parsed.port or 5432),
        "CONN_MAX_AGE": 60,
        "OPTIONS": options,
    }


DATABASE_URL = os.getenv("DATABASE_URL")
FORKLUCK_ENVIRONMENT = os.getenv(
    "FORKLUCK_ENVIRONMENT", "production" if DATABASE_URL else "development"
).lower()
FORKLUCK_ALLOW_DEMO_ACCOUNT = env_bool(
    "FORKLUCK_ALLOW_DEMO_ACCOUNT",
    FORKLUCK_ENVIRONMENT == "development" and not DATABASE_URL,
)
DATABASES = {
    "default": database_from_url(DATABASE_URL)
    if DATABASE_URL
    else {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
        # A DEFERRED transaction upgrading its lock mid-write fails instantly;
        # busy_timeout only applies to IMMEDIATE, so writers queue instead.
        "OPTIONS": {
            "transaction_mode": "IMMEDIATE",
            "init_command": "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;",
        },
    }
}

AUTH_USER_MODEL = "forkluck.User"
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "/django-static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
# Large CSVs are parsed and validated by Next.js before the normalized JSON is
# sent over the private loopback API. Keep this aligned with the 10 MB limits
# in next.config.ts and nginx.
DATA_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024

SESSION_COOKIE_NAME = "forkluck_session"
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_SECURE = env_bool("DJANGO_SECURE_COOKIES")
CSRF_COOKIE_NAME = "forkluck_csrf"
CSRF_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SECURE = env_bool("DJANGO_SECURE_COOKIES")
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"

# HSTS is emitted only on requests Django resolves as https (via the proxy
# header above), so the plain-HTTP loopback plane between Next and Django is
# unaffected. Off outside production so local http:// development still works.
if FORKLUCK_ENVIRONMENT == "production":
    SECURE_HSTS_SECONDS = 31536000
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True

# security.W008 wants SECURE_SSL_REDIRECT. It must stay off: nginx already
# redirects http->https at the edge, while Next reaches Django over plain
# loopback (http://127.0.0.1:8001) and the deploy health check curls that same
# origin. Turning it on would 301 every internal call and fail every deploy.
SILENCED_SYSTEM_CHECKS = ["security.W008"]

FORKLUCK_INTERNAL_SECRET = os.getenv("FORKLUCK_INTERNAL_SECRET", DEV_INTERNAL_SECRET)

# POS / commerce integrations (Square + Shopify OAuth apps). App-level
# credentials live in env; per-user tokens live encrypted in the database
# (token_crypto.py, keyed by FORKLUCK_TOKEN_ENCRYPTION_KEY).
SQUARE_APPLICATION_ID = os.getenv("SQUARE_APPLICATION_ID", "")
SQUARE_APPLICATION_SECRET = os.getenv("SQUARE_APPLICATION_SECRET", "")
SQUARE_ENVIRONMENT = os.getenv("SQUARE_ENVIRONMENT", "sandbox").lower()
SHOPIFY_API_KEY = os.getenv("SHOPIFY_API_KEY", "")
SHOPIFY_API_SECRET = os.getenv("SHOPIFY_API_SECRET", "")
# The browser-facing origin of the app — builds OAuth redirect URIs and the
# post-callback redirects back into /settings.
FORKLUCK_APP_ORIGIN = os.getenv("FORKLUCK_APP_ORIGIN", DEV_APP_ORIGIN)

# One confidential OAuth client, our own feedback board. Empty secret disables
# the endpoints for ordinary self-hosted installations.
FORKLUCK_FEEDBACK_ORIGIN = os.getenv(
    "FORKLUCK_FEEDBACK_ORIGIN", "https://feedback.forkluck.com"
).rstrip("/")
FORKLUCK_FEEDBACK_CLIENT_SECRET = os.getenv("FORKLUCK_FEEDBACK_CLIENT_SECRET", "")
FORKLUCK_FEEDBACK_API_KEY = os.getenv("FORKLUCK_FEEDBACK_API_KEY", "")
if FORKLUCK_FEEDBACK_CLIENT_SECRET:
    from django.core.exceptions import ImproperlyConfigured

    _feedback_url = urlparse(FORKLUCK_FEEDBACK_ORIGIN)
    if (
        len(FORKLUCK_FEEDBACK_CLIENT_SECRET) < 32
        or _feedback_url.scheme != "https" or not _feedback_url.hostname
        or _feedback_url.username or _feedback_url.password
        or _feedback_url.path or _feedback_url.query or _feedback_url.fragment
    ):
        raise ImproperlyConfigured("Feedback requires an HTTPS origin and a strong client secret.")


def signed_in_cookie_domain(app_origin: str) -> str | None:
    """Parent domain the forkluck_signed_in cookie is shared on, or None.

    The marketing site (forkluck.com) and the app (app.forkluck.com) are one
    site, so the indicator cookie is set on ".forkluck.com". Anything without
    a subdomain to strip — a bare domain, an IP, localhost — stays host-only,
    which is what local development gets.
    """
    host = urlparse(app_origin).hostname or ""
    labels = host.split(".")
    if len(labels) < 3 or all(label.isdigit() for label in labels):
        return None
    return "." + ".".join(labels[1:])


# Not HttpOnly by design: the Ghost theme reads it to swap its Sign in / Sign
# up links for Log out / Dashboard. It carries no identity, only "1".
FORKLUCK_SIGNED_IN_COOKIE_NAME = "forkluck_signed_in"
FORKLUCK_SIGNED_IN_COOKIE_DOMAIN = os.getenv(
    "FORKLUCK_SIGNED_IN_COOKIE_DOMAIN"
) or signed_in_cookie_domain(FORKLUCK_APP_ORIGIN)

# Subscription billing for the hosted deployment. With none of the five set —
# the self-hosted default — no gating and no billing UI exist.
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "")
STRIPE_PRICE_ID = os.getenv("STRIPE_PRICE_ID", "")
STRIPE_PRODUCT_ID = os.getenv("STRIPE_PRODUCT_ID", "")
STRIPE_WEBHOOK_ENDPOINT_ID = os.getenv("STRIPE_WEBHOOK_ENDPOINT_ID", "")
STRIPE_BILLING_ENABLED = bool(
    STRIPE_SECRET_KEY
    and STRIPE_WEBHOOK_SECRET
    and STRIPE_PRICE_ID
    and STRIPE_PRODUCT_ID
    and STRIPE_WEBHOOK_ENDPOINT_ID
)

# Transactional email uses the Ghost mail bridge when configured, else ACS.
ACS_CONNECTION_STRING = os.getenv("ACS_CONNECTION_STRING", "")
FORKLUCK_MAIL_BRIDGE_URL = os.getenv("FORKLUCK_MAIL_BRIDGE_URL", "")
FORKLUCK_MAIL_BRIDGE_API_KEY = os.getenv("FORKLUCK_MAIL_BRIDGE_API_KEY", "")
# The test runner must never send real email or require verification, no
# matter what the machine's environment carries. Positional, not membership: a
# management command whose argument happens to be "test" must not disarm this.
if sys.argv[1:2] == ["test"]:
    ACS_CONNECTION_STRING = ""
    FORKLUCK_MAIL_BRIDGE_URL = ""
    FORKLUCK_MAIL_BRIDGE_API_KEY = ""
    os.environ["FORKLUCK_REQUIRE_EMAIL_VERIFICATION"] = "0"
    os.environ["FORKLUCK_ADMIN_CODE_LOGIN"] = "0"
    # Deterministic key so token-crypto tests never depend on machine env.
    os.environ["FORKLUCK_TOKEN_ENCRYPTION_KEY"] = "aa" * 32
    os.environ.pop("FORKLUCK_TOKEN_ENCRYPTION_KEY_ID", None)
    os.environ.pop("FORKLUCK_TOKEN_ENCRYPTION_KEYS", None)
if FORKLUCK_MAIL_BRIDGE_URL or FORKLUCK_MAIL_BRIDGE_API_KEY:
    from django.core.exceptions import ImproperlyConfigured

    _mail_bridge_url = urlparse(FORKLUCK_MAIL_BRIDGE_URL)
    if (
        not FORKLUCK_MAIL_BRIDGE_API_KEY or not _mail_bridge_url.hostname
        or _mail_bridge_url.username or _mail_bridge_url.password
        or _mail_bridge_url.query or _mail_bridge_url.fragment
        or not _mail_bridge_url.path.endswith("/messages")
        or not (
            _mail_bridge_url.scheme == "https"
            or (_mail_bridge_url.scheme == "http" and _mail_bridge_url.hostname in {"127.0.0.1", "::1", "localhost"})
        )
    ):
        raise ImproperlyConfigured("Mail bridge requires a key and an HTTPS or loopback messages URL.")
# ACS requires a bare sender address; the display name is configured on the
# ACS MailFrom username, not sent with the message.
FORKLUCK_EMAIL_FROM = os.getenv("FORKLUCK_EMAIL_FROM", "no-reply@forkluck.com")
# Optional owner alert after a new user verifies their address and enters the
# app. Kept separate from the sender so deployments can route alerts to the
# appropriate operator without putting a private address in source control.
FORKLUCK_REGISTRATION_NOTIFICATION_EMAIL = os.getenv(
    "FORKLUCK_REGISTRATION_NOTIFICATION_EMAIL", ""
)
# Where a custom nutrition request is announced. The request is stored
# either way; this only tells someone to go and apply it.
FORKLUCK_SUPPORT_EMAIL = os.getenv("FORKLUCK_SUPPORT_EMAIL", "")
# Signup requires an emailed code before a session is granted. Off by default
# so tests and bare dev environments keep the one-step flow.
FORKLUCK_REQUIRE_EMAIL_VERIFICATION = env_bool("FORKLUCK_REQUIRE_EMAIL_VERIFICATION")
# The admin (/mommy) asks for an emailed code after the password. Defaults to
# on whenever email sending is configured.
FORKLUCK_ADMIN_CODE_LOGIN = env_bool(
    "FORKLUCK_ADMIN_CODE_LOGIN", bool(ACS_CONNECTION_STRING or FORKLUCK_MAIL_BRIDGE_URL)
)

# Optional one-way sync of verified accounts into the self-hosted Ghost
# newsletter. Both empty disables it; production does not require them.
GHOST_ADMIN_URL = os.getenv("GHOST_ADMIN_URL", "")
GHOST_ADMIN_API_KEY = os.getenv("GHOST_ADMIN_API_KEY", "")

# Optional separately deployed supplier-connector service. All three are
# required before the public application exposes hosted supplier connectors.
# Its own credential encryption key and supplier allowlist live only in that
# service's environment.
FORKLUCK_CONNECTOR_SERVICE_URL = os.getenv("FORKLUCK_CONNECTOR_SERVICE_URL", "")
FORKLUCK_CONNECTOR_CLIENT_ID = os.getenv("FORKLUCK_CONNECTOR_CLIENT_ID", "")
FORKLUCK_CONNECTOR_CLIENT_SECRET = os.getenv("FORKLUCK_CONNECTOR_CLIENT_SECRET", "")


def _development_leftovers() -> list[str]:
    """Every way a production process could still be carrying a development
    default. Each entry is a operator-facing sentence naming the variable to
    set — these are read at boot and turned into ImproperlyConfigured."""
    problems: list[str] = []

    if DEBUG:
        problems.append("DJANGO_DEBUG is enabled; production must run with it off.")
    if not os.getenv("DJANGO_SECRET_KEY") or SECRET_KEY == DEV_SECRET_KEY:
        problems.append(
            "DJANGO_SECRET_KEY is missing or still the development value."
        )
    elif len(SECRET_KEY) < 50 or len(set(SECRET_KEY)) < 5:
        # Same threshold Django's own security.W009 deploy check applies.
        problems.append(
            "DJANGO_SECRET_KEY must be at least 50 characters with at least 5 "
            "distinct characters."
        )
    if (
        not os.getenv("FORKLUCK_INTERNAL_SECRET")
        or FORKLUCK_INTERNAL_SECRET == DEV_INTERNAL_SECRET
    ):
        problems.append(
            "FORKLUCK_INTERNAL_SECRET is missing or still the development value."
        )
    elif not FORKLUCK_INTERNAL_SECRET.isascii():
        # secrets.compare_digest raises TypeError on non-ASCII str, which would
        # turn the internal route's designed 404 denial into a 500.
        problems.append("FORKLUCK_INTERNAL_SECRET must be ASCII.")
    if not SESSION_COOKIE_SECURE or not CSRF_COOKIE_SECURE:
        problems.append(
            "DJANGO_SECURE_COOKIES must be enabled so session and CSRF cookies "
            "are only sent over HTTPS."
        )
    if not FORKLUCK_REQUIRE_EMAIL_VERIFICATION:
        problems.append(
            "FORKLUCK_REQUIRE_EMAIL_VERIFICATION must be enabled in production."
        )
    if not ACS_CONNECTION_STRING and not FORKLUCK_MAIL_BRIDGE_URL:
        problems.append(
            "ACS_CONNECTION_STRING or FORKLUCK_MAIL_BRIDGE_URL must be set so production users can verify email."
        )

    # Provider OAuth tokens are unreadable without this key and are written
    # encrypted, so a missing key turns every POS reconnect into a silent
    # failure rather than a startup one.
    token_key = os.getenv("FORKLUCK_TOKEN_ENCRYPTION_KEY", "")
    if not token_key:
        problems.append("FORKLUCK_TOKEN_ENCRYPTION_KEY is not set.")
    else:
        try:
            if len(bytes.fromhex(token_key.strip())) != 32:
                raise ValueError
        except ValueError:
            problems.append(
                "FORKLUCK_TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex characters)."
            )

    # Billing is optional, but a half-configured deployment would take cards it
    # cannot reconcile against webhooks it cannot verify.
    stripe_values = [
        STRIPE_SECRET_KEY,
        STRIPE_WEBHOOK_SECRET,
        STRIPE_PRICE_ID,
        STRIPE_PRODUCT_ID,
        STRIPE_WEBHOOK_ENDPOINT_ID,
    ]
    provisioning_stripe = sys.argv[1:2] == ["provision_stripe_billing"]
    if any(stripe_values) and not all(stripe_values) and not provisioning_stripe:
        problems.append(
            "STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID, "
            "STRIPE_PRODUCT_ID and STRIPE_WEBHOOK_ENDPOINT_ID must be set "
            "together, or all left empty to disable billing."
        )

    connector_values = [
        FORKLUCK_CONNECTOR_SERVICE_URL,
        FORKLUCK_CONNECTOR_CLIENT_ID,
        FORKLUCK_CONNECTOR_CLIENT_SECRET,
    ]
    if any(connector_values) and not all(connector_values):
        problems.append(
            "FORKLUCK_CONNECTOR_SERVICE_URL, FORKLUCK_CONNECTOR_CLIENT_ID and "
            "FORKLUCK_CONNECTOR_CLIENT_SECRET must be set together, or all "
            "left empty to disable hosted supplier connectors."
        )
    if FORKLUCK_CONNECTOR_SERVICE_URL and not FORKLUCK_CONNECTOR_SERVICE_URL.startswith(
        "https://"
    ):
        problems.append("FORKLUCK_CONNECTOR_SERVICE_URL must use HTTPS in production.")

    development_hosts = {"localhost", "127.0.0.1", "testserver", "[::1]", "*"}
    real_hosts = sorted(set(ALLOWED_HOSTS).difference(development_hosts))
    if "*" in ALLOWED_HOSTS or not real_hosts:
        problems.append(
            "DJANGO_ALLOWED_HOSTS must name the deployment's real hostnames "
            f"(found {ALLOWED_HOSTS or ['nothing']})."
        )
    leftover_origins = sorted(
        origin
        for origin in CSRF_TRUSTED_ORIGINS
        if origin.startswith("http://") or "localhost" in origin
    )
    if leftover_origins or not CSRF_TRUSTED_ORIGINS:
        problems.append(
            "DJANGO_CSRF_TRUSTED_ORIGINS must be https origins for the real "
            f"deployment (found {leftover_origins or ['nothing']})."
        )
    if FORKLUCK_APP_ORIGIN == DEV_APP_ORIGIN or FORKLUCK_APP_ORIGIN.startswith(
        "http://"
    ):
        problems.append(
            "FORKLUCK_APP_ORIGIN must be the https origin the browser reaches."
        )
    return problems


# Fail closed: a production process missing any of these would boot as a
# silently weakened deployment, so refuse to start instead. Acceptance and
# unit test runs set FORKLUCK_ENVIRONMENT away from "production".
if FORKLUCK_ENVIRONMENT == "production" and sys.argv[1:2] != ["test"]:
    _problems = _development_leftovers()
    if _problems:
        from django.core.exceptions import ImproperlyConfigured

        raise ImproperlyConfigured(
            "Refusing to start in production with development configuration:\n"
            + "\n".join(f"  - {problem}" for problem in _problems)
        )
