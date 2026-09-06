"""Mirror already-tracked SKU decisions for workspaces that want them.

Mirroring runs when a merchant saves a product, so a workspace whose variants
predate the feature keeps its single-sided links until each one is next
touched. This walks the existing links once. It is the same predicate the save
path uses, so running it twice mirrors nothing the first run missed.
"""

from django.core.management.base import BaseCommand

from ...domains.sales.auto_match import auto_match_enabled, mirror_existing_links
from ...models import User


class Command(BaseCommand):
    help = "Mirror tracked SKU decisions across channels for every opted-in workspace."

    def add_arguments(self, parser):
        parser.add_argument(
            "--email",
            help="Restrict to one workspace. Defaults to every opted-in user.",
        )

    def handle(self, *args, **options):
        users = User.objects.all().order_by("email")
        if options["email"]:
            users = users.filter(email=options["email"])

        total = 0
        for user in users:
            if not auto_match_enabled(user):
                continue
            count = mirror_existing_links(user)
            if count:
                total += count
                self.stdout.write(f"{user.email}: {count} variants")
        self.stdout.write(self.style.SUCCESS(f"mirrored {total} variants"))
