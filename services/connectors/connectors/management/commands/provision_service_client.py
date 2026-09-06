import secrets

from django.core.management.base import BaseCommand, CommandError

from connectors.models import ServiceClient


def provision_client(client_id: str, redirect_uri: str, *, rotate: bool) -> str:
    """Create or, with `rotate`, re-key a service client. Returns the one-time secret."""
    secret = secrets.token_urlsafe(32)
    existing = ServiceClient.objects.filter(client_id=client_id).first()
    if existing and not rotate:
        raise CommandError(
            "A client with this id already exists; pass --rotate to replace its secret in place"
        )
    if existing:
        existing.redirect_uri, existing.secret_hash, existing.active = (
            redirect_uri,
            ServiceClient.hash_secret(secret),
            True,
        )
        existing.save(update_fields=["redirect_uri", "secret_hash", "active"])
    else:
        ServiceClient.objects.create(
            client_id=client_id,
            redirect_uri=redirect_uri,
            secret_hash=ServiceClient.hash_secret(secret),
        )
    return secret


class Command(BaseCommand):
    help = "Create a connector service client and print its secret once."

    def add_arguments(self, parser):
        parser.add_argument("client_id")
        parser.add_argument("redirect_uri")
        parser.add_argument("--rotate", action="store_true")

    def handle(self, *args, **options):
        client_id, redirect_uri = options["client_id"], options["redirect_uri"]
        secret = provision_client(client_id, redirect_uri, rotate=options["rotate"])
        self.stdout.write(f"client_id={client_id}\nclient_secret={secret}")
