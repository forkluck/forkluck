"""One bench-cost record per recipe.

Opening a recipe's cost sheet used to read-then-create, so two concurrent
opens could each see nothing and each create a record. The pairing being
tested is the database constraint plus the get_or_create that leans on it.
"""

import json

from django.conf import settings
from django.db import IntegrityError, transaction
from django.test import Client, TestCase

from .models import BenchCostRecipe, Recipe, User


class BenchCostRecipeUniquenessTests(TestCase):
    def setUp(self) -> None:
        self.client = Client()
        self.user = User.objects.create_user(
            email="bench@example.com",
            name="Bench Chef",
            password="a-long-test-passphrase-2468",
        )
        self.client.force_login(self.user)
        self.recipe = Recipe.objects.create(
            user=self.user, title="Focaccia", yield_amount=12, yield_unit="pcs"
        )

    def open_cost(self, recipe: Recipe):
        return self.client.post(
            "/internal/v1/actions/open-cost-for-recipe/",
            data=json.dumps({"recipeId": str(recipe.id)}),
            content_type="application/json",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )

    def test_opening_a_cost_sheet_twice_returns_the_same_record(self):
        first = self.open_cost(self.recipe)
        second = self.open_cost(self.recipe)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.json()["id"], second.json()["id"])
        self.assertEqual(
            BenchCostRecipe.objects.filter(user=self.user, recipe=self.recipe).count(),
            1,
        )

    def test_database_refuses_a_second_record_for_the_same_recipe(self):
        BenchCostRecipe.objects.create(
            user=self.user, recipe=self.recipe, name="Focaccia", batch_yield=12
        )

        with self.assertRaises(IntegrityError), transaction.atomic():
            BenchCostRecipe.objects.create(
                user=self.user, recipe=self.recipe, name="Focaccia again", batch_yield=12
            )

    def test_detached_records_are_not_constrained(self):
        # recipe is nullable, and rows detached by migration 0054 or by a
        # deleted recipe (on_delete=SET_NULL) must stay legal in any number.
        BenchCostRecipe.objects.create(user=self.user, name="Loose one", batch_yield=1)
        BenchCostRecipe.objects.create(user=self.user, name="Loose two", batch_yield=1)

        self.assertEqual(
            BenchCostRecipe.objects.filter(user=self.user, recipe=None).count(), 2
        )

    def test_another_workspace_may_hold_its_own_record(self):
        # The constraint is per (user, recipe), so it must not leak across
        # workspaces even when a recipe id is shared by reference.
        other = User.objects.create_user(
            email="other@example.com",
            name="Other Chef",
            password="a-long-test-passphrase-1357",
        )
        BenchCostRecipe.objects.create(
            user=self.user, recipe=self.recipe, name="Focaccia", batch_yield=12
        )
        BenchCostRecipe.objects.create(
            user=other, recipe=self.recipe, name="Focaccia", batch_yield=12
        )

        self.assertEqual(BenchCostRecipe.objects.filter(recipe=self.recipe).count(), 2)

    def test_losing_side_of_a_race_reads_the_winners_row(self):
        # Simulate the interleaving directly: the handler's get_or_create finds
        # nothing, and a competing record lands before its INSERT. The handler
        # must return the winner rather than surfacing the IntegrityError.
        winner = BenchCostRecipe.objects.create(
            user=self.user, recipe=self.recipe, name="Focaccia", batch_yield=12
        )
        original = BenchCostRecipe.objects.get_or_create

        def racing_get_or_create(*args, **kwargs):
            raise IntegrityError("duplicate key value violates unique constraint")

        BenchCostRecipe.objects.get_or_create = racing_get_or_create
        try:
            response = self.open_cost(self.recipe)
        finally:
            BenchCostRecipe.objects.get_or_create = original

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["id"], str(winner.id))
