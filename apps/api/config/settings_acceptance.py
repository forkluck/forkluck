"""Process-isolated settings for browser acceptance tests.

This module refuses to start without the acceptance guard and a database path
inside the operating system's temporary directory. External integrations are
disabled before the regular settings module reads the developer's local env.
"""

import os
import tempfile
from pathlib import Path


if os.environ.get("FORKLUCK_ACCEPTANCE") != "1":
    raise RuntimeError("Acceptance settings require FORKLUCK_ACCEPTANCE=1")

os.environ.update(
    {
        "DATABASE_URL": "",
        "DJANGO_DEBUG": "1",
        "FORKLUCK_ENVIRONMENT": "test",
        "FORKLUCK_ALLOW_DEMO_ACCOUNT": "1",
        "FORKLUCK_REQUIRE_EMAIL_VERIFICATION": "0",
        "FORKLUCK_ADMIN_CODE_LOGIN": "0",
        "FORKLUCK_REGISTRATION_NOTIFICATION_EMAIL": "",
        "FORKLUCK_MASTER_PRICE_CATALOG_PATH": "",
        "ACS_CONNECTION_STRING": "",
        "FORKLUCK_MAIL_BRIDGE_URL": "",
        "FORKLUCK_MAIL_BRIDGE_API_KEY": "",
        "FORKLUCK_FEEDBACK_CLIENT_SECRET": "",
        "FORKLUCK_FEEDBACK_API_KEY": "",
        "SQUARE_APPLICATION_ID": "",
        "SQUARE_APPLICATION_SECRET": "",
        "SHOPIFY_API_KEY": "",
        "SHOPIFY_API_SECRET": "",
        "TURNSTILE_SITE_KEY": "",
        "TURNSTILE_SECRET_KEY": "",
        # Billing off, as in CI: no trial clock, no gating, no Stripe calls.
        "STRIPE_SECRET_KEY": "",
        "STRIPE_WEBHOOK_SECRET": "",
        "STRIPE_PRICE_ID": "",
        "STRIPE_PRODUCT_ID": "",
        "STRIPE_WEBHOOK_ENDPOINT_ID": "",
        "FORKLUCK_TOKEN_ENCRYPTION_KEY": "aa" * 32,
        "FORKLUCK_TOKEN_ENCRYPTION_KEY_ID": "acceptance",
        "FORKLUCK_TOKEN_ENCRYPTION_KEYS": "",
    }
)

from .settings import *  # noqa: E402,F403


database_value = os.environ.get("FORKLUCK_ACCEPTANCE_DB")
if not database_value:
    raise RuntimeError("FORKLUCK_ACCEPTANCE_DB is required")

database_path = Path(database_value).resolve()
temporary_root = Path(tempfile.gettempdir()).resolve()
if temporary_root not in database_path.parents:
    raise RuntimeError("Acceptance SQLite database must live under the OS temp directory")

DATABASES = {  # noqa: F405
    "default": {
        **DATABASES["default"],  # noqa: F405
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": database_path,
    }
}
EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
