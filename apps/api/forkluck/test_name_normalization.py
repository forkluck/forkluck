"""One comparison key, derived on write, folding accents.

The three-string parity block below is mirrored verbatim in
`apps/web/tests/pricing.test.ts`; a fold added on one side and not the other is the
silent-miss bug this whole module exists to prevent.
"""

from decimal import Decimal

from django.test import SimpleTestCase, TestCase


from .domains.recipes.health import RecipeHealthReadModel
from .models import (
    BenchCostSettings,
    CatalogIngredient,
    Ingredient,
    Recipe,
    User,
    normalized_name,
)

# Relative: a dotted "forkluck.…" literal would register this module as a
# mock.patch target in test_contract.PatchTargetInventoryTests.

# Same inputs, same outputs, as apps/web/tests/pricing.test.ts "folds accents".
ACCENT_PARITY = (
    ("Crème Fraîche", "creme fraiche"),
    ("Jalapeño", "jalapeno"),
    ("püree", "puree"),
)


class NormalizedNameTests(SimpleTestCase):
    def test_accents_fold_to_the_unaccented_spelling(self):
        for written, expected in ACCENT_PARITY:
            with self.subTest(written=written):
                self.assertEqual(normalized_name(written), expected)

    def test_the_two_spellings_are_the_same_key(self):
        self.assertEqual(
            normalized_name("Crème Fraîche"), normalized_name("Creme Fraiche")
        )

    def test_folding_leaves_the_existing_collapse_rules_alone(self):
        self.assertEqual(normalized_name("  Bread Flour "), "bread flour")
        self.assertEqual(normalized_name("Extra-Virgin  Olive Oil"), "extra virgin olive oil")


class DerivedNormalizedNameTests(TestCase):
    @classmethod
    def setUpTestData(cls) -> None:
        cls.user = User.objects.create_user(
            email="derive@example.com",
            name="Derive Chef",
            password="a-long-test-passphrase-2468",
        )

    def test_an_ingredient_derives_its_key_and_ignores_a_supplied_one(self):
        row = Ingredient.objects.create(
            user=self.user,
            name="Crème Fraîche",
            normalized_name="whatever the caller thought",
            purchase_cost_cents=1000,
            purchase_size=1000,
            purchase_unit="g",
        )
        row.refresh_from_db()
        self.assertEqual(row.normalized_name, "creme fraiche")

    def test_a_catalog_ingredient_derives_its_key(self):
        row = CatalogIngredient.objects.create(name="Jalapeño")
        row.refresh_from_db()
        self.assertEqual(row.normalized_name, "jalapeno")

    def test_a_partial_save_that_renames_rewrites_the_key(self):
        row = Ingredient.objects.create(
            user=self.user,
            name="Butter",
            purchase_cost_cents=1000,
            purchase_size=1,
            purchase_unit="kg",
        )
        row.name = "Beurre Doux"
        # The rename travels with a price save, which names its columns.
        row.save(update_fields=["name", "updated_at"])
        row.refresh_from_db()
        self.assertEqual(row.normalized_name, "beurre doux")


class AccentedPantryPricingTests(TestCase):
    """Parity with "prices a line against an accented pantry name" in
    apps/web/tests/pricing.test.ts: the chef types the plain spelling, the pantry holds
    the accented one, and the line is priced rather than reported unpriced."""

    @classmethod
    def setUpTestData(cls) -> None:
        cls.user = User.objects.create_user(
            email="accent-pricing@example.com",
            name="Accent Chef",
            password="a-long-test-passphrase-2468",
        )
        BenchCostSettings.objects.create(user=cls.user)
        Ingredient.objects.create(
            user=cls.user,
            name="Crème Fraîche",
            purchase_cost_cents=1000,
            purchase_size=Decimal("1"),
            purchase_unit="kg",
        )
        cls.recipes = [
            Recipe.objects.create(
                user=cls.user,
                title=title,
                code=code,
                body=f"200 g {line}",
                yield_amount=200.0,
                yield_unit="g",
                serving_amount=1,
                serving_unit="kg",
            )
            for title, code, line in (
                ("Plain tart", "R1", "creme fraiche"),
                ("Accented tart", "R2", "Crème Fraîche"),
            )
        ]

    def test_either_spelling_prices_against_the_accented_pantry_row(self):
        plain, accented = RecipeHealthReadModel(self.user).rows(self.recipes)
        self.assertEqual(plain["issues"], accented["issues"])
        self.assertNotIn("1 unpriced", plain["issues"])
        self.assertEqual(plain["ingredientCents"], accented["ingredientCents"])
        self.assertIsNotNone(plain["ingredientCents"])
