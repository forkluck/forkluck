"""Labor cost of a recipe: prep time, or the sum of timed active steps.

The same rule is implemented in apps/web/lib/benchcost/math.ts and apps/web/lib/recipe/health.ts
and must produce identical numbers, so the cases here are mirrored there.
"""

from datetime import timedelta
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from .domains.recipes.health import RecipeHealthReadModel
from .domains.workspace.views import business_settings
from .models import (
    Employee,
    LaborImport,
    Recipe,
    RecipeItem,
    RecipeStep,
    RecipeTiming,
    TimeEntry,
    User,
)
from .testing import internal_payload


class RecipeLaborTests(TestCase):
    @classmethod
    def setUpTestData(cls) -> None:
        cls.user = User.objects.create_user(
            email="labor@example.com",
            name="Labor Chef",
            password="a-long-test-passphrase-2468",
        )

    def health_row(self, **fields) -> dict:
        recipe = Recipe.objects.create(
            user=self.user,
            title="Loaf",
            yield_amount=10.0,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
            **fields,
        )
        RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.HEADER,
            position=0,
            display_name="Mise",
        )
        return recipe

    def row(self, recipe: Recipe) -> dict:
        recipe._has_normalized_items = True
        recipe._normalized_items = list(recipe.items.all())
        recipe._normalized_steps = list(recipe.steps.all())
        return RecipeHealthReadModel(self.user).rows([recipe])[0]

    def step(self, recipe: Recipe, position: int, kind: str, *seconds: int) -> None:
        step = RecipeStep.objects.create(
            recipe=recipe, position=position, labor_kind=kind
        )
        for value in seconds:
            RecipeTiming.objects.create(step=step, seconds=value)

    def test_prep_time_costs_the_batch_at_the_settings_wage(self):
        recipe = self.health_row(prep_time_amount=Decimal("2"), prep_time_unit="hours")
        row = self.row(recipe)
        self.assertEqual(row["labor"]["centsPerBatch"], 4000)
        self.assertEqual(row["issues"], [])

    def test_auto_sums_active_steps_and_ignores_passive_ones(self):
        recipe = self.health_row(auto_prep_time_enabled=True)
        self.step(recipe, 0, "active", 600)
        self.step(recipe, 1, "active", 300)
        self.step(recipe, 2, "passive", 1800)
        row = self.row(recipe)
        self.assertEqual(row["labor"]["centsPerBatch"], 500)
        self.assertEqual(row["issues"], [])

    def test_a_timing_records_one_batch_so_repeats_average(self):
        recipe = self.health_row(auto_prep_time_enabled=True)
        self.step(recipe, 0, "active", 600, 1200)
        self.assertEqual(self.row(recipe)["labor"]["centsPerBatch"], 500)

    def test_auto_without_a_timed_step_has_no_labor(self):
        recipe = self.health_row(auto_prep_time_enabled=True)
        self.step(recipe, 0, "active")
        row = self.row(recipe)
        self.assertIsNone(row["labor"])
        self.assertIn("No timed steps", row["issues"])

    def test_auto_reports_the_active_steps_it_could_not_time(self):
        recipe = self.health_row(auto_prep_time_enabled=True)
        self.step(recipe, 0, "active", 600)
        self.step(recipe, 1, "active")
        self.step(recipe, 2, "active")
        row = self.row(recipe)
        self.assertEqual(row["labor"]["centsPerBatch"], 333)
        self.assertIn("2 steps untimed", row["issues"])

    def test_blank_prep_time_has_no_labor(self):
        row = self.row(self.health_row())
        self.assertIsNone(row["labor"])
        self.assertIn("No prep time", row["issues"])

    def test_payroll_average_is_the_cost_of_an_hour_of_paid_time(self):
        labor_import = LaborImport.objects.create(
            user=self.user, file_name="hours.csv", timezone="America/New_York"
        )
        employee = Employee.objects.create(
            user=self.user, name="Baker", normalized_name="baker"
        )
        clock_in = timezone.now() - timedelta(days=2)
        for index, (seconds, cents) in enumerate(((3600, 2000), (7200, 5000))):
            TimeEntry.objects.create(
                user=self.user,
                employee=employee,
                labor_import=labor_import,
                source_position=index,
                source_fingerprint=f"fp-{index}",
                clock_in=clock_in,
                clock_out=clock_in + timedelta(seconds=seconds),
                paid_seconds=seconds,
                labor_cost_cents=cents,
            )
        payload = internal_payload(business_settings, self.user)
        self.assertEqual(payload["payrollAverageRateCents"], 2333)

    def test_payroll_average_ignores_shifts_older_than_the_window(self):
        labor_import = LaborImport.objects.create(
            user=self.user, file_name="hours.csv", timezone="America/New_York"
        )
        employee = Employee.objects.create(
            user=self.user, name="Baker", normalized_name="baker"
        )
        clock_in = timezone.now() - timedelta(days=120)
        TimeEntry.objects.create(
            user=self.user,
            employee=employee,
            labor_import=labor_import,
            source_position=0,
            source_fingerprint="fp-old",
            clock_in=clock_in,
            clock_out=clock_in + timedelta(hours=1),
            paid_seconds=3600,
            labor_cost_cents=2000,
        )
        payload = internal_payload(business_settings, self.user)
        self.assertIsNone(payload["payrollAverageRateCents"])
