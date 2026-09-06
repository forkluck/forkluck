import io
from unittest import skipUnless

from django.contrib.auth import authenticate
from django.db import connection
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings

from .demo_data import ALIASES, DEMO_EMAIL, DEMO_PASSWORD, INGREDIENTS, RECIPES
from .models import (
    BenchCostRecipe,
    BenchCostTiming,
    Ingredient,
    RecipeLineMatch,
    IngredientPrice,
    Recipe,
    RecipeShare,
    User,
)


class DemoDataTests(TestCase):
    # The setting is env-derived and unset in CI; the guard has its own test.
    # The command also refuses non-SQLite databases by design, so the seed can
    # only be exercised on the local engine.
    @skipUnless(connection.vendor == "sqlite", "demo seeding is SQLite-only")
    @override_settings(FORKLUCK_ALLOW_DEMO_ACCOUNT=True)
    def test_seed_command_creates_login_and_is_idempotent(self):
        for _ in range(2):
            call_command("seed_demo_data", stdout=io.StringIO())

        user = User.objects.get(email=DEMO_EMAIL)
        self.assertEqual(authenticate(email=DEMO_EMAIL, password=DEMO_PASSWORD), user)
        self.assertEqual(Ingredient.objects.filter(user=user).count(), len(INGREDIENTS))
        self.assertTrue(Ingredient.objects.filter(user=user, name="Flour").exists())
        self.assertFalse(
            Ingredient.objects.filter(user=user, name="All-Purpose Flour").exists()
        )
        self.assertEqual(
            IngredientPrice.objects.filter(ingredient__user=user).count(),
            len(INGREDIENTS) * 2,
        )
        # The demo set plus the shared recipe the acceptance suite opens.
        self.assertEqual(Recipe.objects.filter(user=user).count(), len(RECIPES) + 1)
        self.assertEqual(BenchCostRecipe.objects.filter(user=user).count(), 4)
        self.assertEqual(BenchCostTiming.objects.filter(step__recipe__user=user).count(), 52)
        self.assertEqual(
            RecipeLineMatch.objects.filter(user=user).count(), len(ALIASES)
        )
        editor_share = RecipeShare.objects.select_related("recipient").get()
        self.assertIsNotNone(editor_share.recipient.email_verified_at)

    @override_settings(FORKLUCK_ALLOW_DEMO_ACCOUNT=False)
    def test_seed_command_is_blocked_outside_local_development(self):
        with self.assertRaises(CommandError):
            call_command("seed_demo_data", stdout=io.StringIO())
