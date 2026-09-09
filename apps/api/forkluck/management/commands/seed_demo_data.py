from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from django.utils import timezone

from forkluck.demo_data import (
    DEMO_EMAIL,
    DEMO_NAME,
    DEMO_PASSWORD,
    _demo_id,
    seed_demo_workspace,
)
from forkluck.domains.recipes.guest_links import hash_guest_token
from forkluck.models import (
    Recipe,
    RecipeBook,
    RecipeBookRecipe,
    RecipeGuestLink,
    RecipeItem,
    RecipeShare,
    RecipeStep,
    User,
)

# A fixed capability token so the acceptance suite can open /shared/<token>
# with no session; only ever minted into the throwaway demo database.
ACCEPTANCE_GUEST_TOKEN = "acceptance-guest-token"

# The same for a book, so /shared/book/<token> can be opened without sending
# an invite first; also only ever minted into the throwaway demo database.
ACCEPTANCE_BOOK_TOKEN = "acceptance-book-token"

# A fixed second account holding an editor share, so the acceptance suite can
# put two people on one recipe; only ever created in the throwaway database.
ACCEPTANCE_EDITOR_EMAIL = "playwright-editor@example.test"
ACCEPTANCE_EDITOR_PASSWORD = "Synthetic acceptance 2026!"
ACCEPTANCE_SHARED_RECIPE = "Sea Salt Chocolate Chip Cookies"


class Command(BaseCommand):
    help = "Create or refresh the local demo account and bogus workspace data"

    def add_arguments(self, parser):
        parser.add_argument("--email", default=DEMO_EMAIL)
        parser.add_argument("--password", default=DEMO_PASSWORD)

    def handle(self, *args, **options):
        if not settings.FORKLUCK_ALLOW_DEMO_ACCOUNT:
            raise CommandError(
                "Demo seeding is disabled. Set FORKLUCK_ALLOW_DEMO_ACCOUNT=1 "
                "only in local development."
            )
        if connection.vendor != "sqlite":
            raise CommandError(
                "Demo seeding is restricted to the local SQLite database."
            )

        email = options["email"].strip().lower()
        password = options["password"]
        if not email or not password:
            raise CommandError("Email and password cannot be blank.")

        with transaction.atomic():
            user, created = User.objects.get_or_create(
                email=email,
                defaults={"name": DEMO_NAME},
            )
            if not user.name:
                user.name = DEMO_NAME
            user.set_password(password)
            user.save(update_fields=["name", "password"])
            summary = seed_demo_workspace(user)
            # The legacy demo recipes carry no normalized lines, so the
            # guest link gets one small real recipe of its own.
            recipe, _ = Recipe.objects.get_or_create(
                user=user,
                title="Shared Lemonade",
                defaults={"code": "GST1", "yield_amount": 4.0, "yield_unit": "cup"},
            )
            recipe.items.all().delete()
            RecipeItem.objects.bulk_create(
                [
                    RecipeItem(
                        recipe=recipe,
                        kind=RecipeItem.INGREDIENT,
                        position=position,
                        display_name=name,
                        quantity=quantity,
                        unit=unit,
                    )
                    for position, (name, quantity, unit) in enumerate(
                        [
                            ("Water", 4, "cup"),
                            ("Lemon juice", 1, "cup"),
                            ("Sugar", 0.75, "cup"),
                        ]
                    )
                ]
            )
            recipe.steps.all().delete()
            RecipeStep.objects.bulk_create(
                [
                    RecipeStep(
                        recipe=recipe,
                        kind=RecipeStep.INSTRUCTION,
                        position=position,
                        body=body,
                    )
                    for position, body in enumerate(
                        [
                            "Stir the sugar into the lemon juice.",
                            "Add the water and chill.",
                        ]
                    )
                ]
            )
            editor, _ = User.objects.get_or_create(
                email=ACCEPTANCE_EDITOR_EMAIL,
                defaults={"name": "Acceptance Editor"},
            )
            editor.set_password(ACCEPTANCE_EDITOR_PASSWORD)
            editor.email_verified_at = timezone.now()
            editor.save(update_fields=["password", "email_verified_at"])
            shared_recipe = Recipe.objects.get(
                id=_demo_id(user.email, "recipe", ACCEPTANCE_SHARED_RECIPE)
            )
            RecipeShare.objects.update_or_create(
                recipe=shared_recipe,
                recipient=editor,
                defaults={"role": RecipeShare.EDITOR},
            )
            RecipeGuestLink.objects.update_or_create(
                recipe=recipe,
                email="guest@example.test",
                defaults={
                    "token_hash": hash_guest_token(ACCEPTANCE_GUEST_TOKEN)
                },
            )
            # One viewer book over two recipes, so the acceptance suite has an
            # accordion to open. Replaced rather than updated: a book carries
            # no (user, email) uniqueness, because every share writes a new one.
            RecipeBook.objects.filter(
                user=user, email="guest@example.test"
            ).delete()
            book = RecipeBook.objects.create(
                user=user,
                email="guest@example.test",
                token_hash=hash_guest_token(ACCEPTANCE_BOOK_TOKEN),
                role=RecipeShare.VIEWER,
            )
            RecipeBookRecipe.objects.bulk_create(
                [
                    RecipeBookRecipe(book=book, recipe=row, position=position)
                    for position, row in enumerate([recipe, shared_recipe])
                ]
            )

        action = "Created" if created else "Refreshed"
        self.stdout.write(
            self.style.SUCCESS(
                f"{action} demo workspace for {email}: "
                f"ingredients={summary.ingredients}, recipes={summary.recipes}, "
                f"cost_recipes={summary.cost_recipes}"
            )
        )
