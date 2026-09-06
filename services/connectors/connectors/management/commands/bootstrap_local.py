"""One-shot local setup: env file, encryption key, migrations, service client.

Development only. Prints the three settings the Forkluck API needs; writing
them into apps/api/.env is the root `pnpm connectors:setup` script's job, so
this service never learns the application's file layout.
"""

import secrets
import shutil

from django.conf import settings
from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError

from connectors.management.commands.provision_service_client import provision_client

ENV_PATH = settings.BASE_DIR / ".env"
EXAMPLE_PATH = settings.BASE_DIR / ".env.example"
KEY_NAME = "CONNECTORS_ENCRYPTION_KEY"
CALLBACK_PATH = "/api/integrations/connectors/callback"


def ensure_encryption_key(env_path=None) -> bool:
    """Create the env file from the example if needed and fill in a key once.

    Returns True when a key was generated. The key is persisted here rather
    than exported in a shell: credentials stored locally are unreadable
    without it.
    """
    env_path = env_path or ENV_PATH
    if not env_path.exists():
        shutil.copyfile(EXAMPLE_PATH, env_path)
    lines = env_path.read_text().splitlines()
    for index, line in enumerate(lines):
        if line.split("=", 1)[0].strip() == KEY_NAME:
            if line.split("=", 1)[1].strip():
                return False
            lines[index] = f"{KEY_NAME}={secrets.token_hex(32)}"
            break
    else:
        lines.append(f"{KEY_NAME}={secrets.token_hex(32)}")
    env_path.write_text("\n".join(lines) + "\n")
    return True


class Command(BaseCommand):
    help = "Set up this checkout for local development and print the app's settings."

    def add_arguments(self, parser):
        parser.add_argument("--client-id", default="forkluck-local")
        parser.add_argument(
            "--app-origin",
            default="http://localhost:3000",
            help="The Forkluck app origin the callback is registered under",
        )

    def handle(self, *args, **options):
        if settings.CONNECTORS_ENVIRONMENT == "production":
            raise CommandError("bootstrap_local is for development checkouts only")
        if ensure_encryption_key():
            self.stdout.write(f"Wrote a new {KEY_NAME} to {ENV_PATH}. Keep it.")
        call_command("migrate", interactive=False, verbosity=0)
        client_id = options["client_id"]
        redirect_uri = options["app_origin"].rstrip("/") + CALLBACK_PATH
        secret = provision_client(client_id, redirect_uri, rotate=True)
        self.stdout.write(
            f"FORKLUCK_CONNECTOR_SERVICE_URL={settings.CONNECTORS_PUBLIC_BASE_URL}\n"
            f"FORKLUCK_CONNECTOR_CLIENT_ID={client_id}\n"
            f"FORKLUCK_CONNECTOR_CLIENT_SECRET={secret}"
        )
