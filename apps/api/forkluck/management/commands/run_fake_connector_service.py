"""Start the standalone synthetic supplier connector HTTP service."""

from django.core.management.base import BaseCommand, CommandParser

from ...fake_connector_service import serve


class Command(BaseCommand):
    help = "Run the synthetic supplier connector service for local/acceptance testing"

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--host", default="127.0.0.1")
        parser.add_argument("--port", type=int, default=9123)
        parser.add_argument("--client-id", default="public-app")
        parser.add_argument("--client-secret", default="public-secret")
        parser.add_argument(
            "--failures",
            default="",
            help=(
                "Comma-separated: expired_state, lockout, callback_origin, "
                "authorization_rejected, transient, timeout, malformed, ack_once"
            ),
        )

    def handle(self, *args, **options) -> None:
        if not 1 <= options["port"] <= 65535:
            raise ValueError("Port must be between 1 and 65535")
        failures = {item.strip() for item in options["failures"].split(",") if item.strip()}
        self.stdout.write(f"Fake connector listening on http://{options['host']}:{options['port']}")
        serve(
            host=options["host"],
            port=options["port"],
            client_id=options["client_id"],
            client_secret=options["client_secret"],
            failures=failures,
        )
