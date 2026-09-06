"""What a pantry category and an archived ingredient change.

Archiving is a list filter, not a deletion: the lines that already name an
ingredient keep costing from it, so these tests pin both halves: what drops
out of the pickers, and what stays.
"""

from decimal import Decimal

from django.test import Client

from .domains.ingredients.serializers import ingredient_json
from .domains.shared.ingredient_identity import saved_line_match_map
from .models import (
    Ingredient,
    IngredientCategory,
    Recipe,
    RecipeItem,
    RecipeLineMatch,
    User,
)
from .testing import InternalApiTestCase


class IngredientCategoryAndStatusTests(InternalApiTestCase):
    @classmethod
    def setUpTestData(cls) -> None:
        cls.user = User.objects.create_user(
            email="pantry-status@example.com",
            name="Pantry Chef",
            password="a-long-test-passphrase-2468",
        )

    def setUp(self) -> None:
        self.client = Client()
        self.client.force_login(self.user)

    def ingredient(self, name: str, **fields) -> Ingredient:
        return Ingredient.objects.create(
            user=self.user,
            name=name,
            normalized_name=name.lower(),
            purchase_cost_cents=1000,
            purchase_size=1,
            purchase_unit="kg",
            **fields,
        )

    def line(self, recipe: Recipe, ingredient: Ingredient, position, quantity, unit):
        return RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.INGREDIENT,
            position=position,
            display_name=ingredient.name,
            quantity=Decimal(quantity),
            unit=unit,
            ingredient=ingredient,
        )

    def test_saving_a_category_name_creates_it_once_and_null_clears_it(self):
        response = self.post_internal(
            "save-ingredient",
            {"name": "Butter", "purchaseCostCents": 1000, "category": "Dairy"},
        )
        self.assertEqual(response.status_code, 200)
        row = Ingredient.objects.get(id=response.json()["id"])
        self.assertEqual(row.category.name, "Dairy")

        # A second ingredient under the same spelling reuses the row.
        self.post_internal(
            "save-ingredient",
            {"name": "Cream", "purchaseCostCents": 900, "category": "dairy"},
        )
        self.assertEqual(
            IngredientCategory.objects.filter(user=self.user).count(), 1
        )

        # An absent key leaves the category alone; an explicit null clears it.
        self.post_internal(
            "save-ingredient",
            {"id": str(row.id), "name": "Butter", "purchaseCostCents": 1100},
        )
        row.refresh_from_db()
        self.assertIsNotNone(row.category_id)
        self.post_internal(
            "save-ingredient",
            {
                "id": str(row.id),
                "name": "Butter",
                "purchaseCostCents": 1100,
                "category": None,
            },
        )
        row.refresh_from_db()
        self.assertIsNone(row.category_id)

    def test_a_create_can_mark_the_row_as_a_supply(self):
        """/supplies/new saves a supply in one write, not a create then a flag."""
        response = self.post_internal(
            "save-ingredient",
            {"name": "Takeout boxes", "purchaseCostCents": 4200, "nonEdible": True},
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(Ingredient.objects.get(id=response.json()["id"]).non_edible)

    def test_renaming_a_category_merges_into_an_existing_name(self):
        dairy = IngredientCategory.objects.create(
            user=self.user, name="Dairy", normalized_name="dairy"
        )
        chilled = IngredientCategory.objects.create(
            user=self.user, name="Chilled", normalized_name="chilled"
        )
        row = self.ingredient("Butter", category=chilled)
        response = self.post_internal(
            "rename-ingredient-category",
            {"currentName": "Chilled", "name": "Dairy"},
        )
        self.assertEqual(response.status_code, 200)
        row.refresh_from_db()
        self.assertEqual(row.category_id, dairy.id)
        self.assertFalse(IngredientCategory.objects.filter(id=chilled.id).exists())

    def test_deleting_a_category_leaves_its_ingredients_uncategorized(self):
        dairy = IngredientCategory.objects.create(
            user=self.user, name="Dairy", normalized_name="dairy"
        )
        row = self.ingredient("Butter", category=dairy)
        response = self.post_internal(
            "delete-ingredient-category", {"name": "Dairy"}
        )
        self.assertEqual(response.status_code, 200)
        row.refresh_from_db()
        self.assertIsNone(row.category_id)
        self.assertFalse(IngredientCategory.objects.filter(id=dairy.id).exists())

    def test_an_ingredient_starts_active_and_the_action_archives_it(self):
        row = self.ingredient("Butter")
        self.assertEqual(row.status, Ingredient.STATUS_ACTIVE)
        response = self.post_internal(
            "archive-ingredient", {"id": str(row.id), "archived": True}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["item"]["status"], "archived")
        row.refresh_from_db()
        self.assertEqual(row.status, Ingredient.STATUS_ARCHIVED)
        self.post_internal(
            "archive-ingredient", {"id": str(row.id), "archived": False}
        )
        row.refresh_from_db()
        self.assertEqual(row.status, Ingredient.STATUS_ACTIVE)

    def test_browse_hides_archived_rows_unless_asked(self):
        self.ingredient("Butter")
        self.ingredient("Lard", status=Ingredient.STATUS_ARCHIVED)
        default = self.get_internal("ingredients/")
        self.assertEqual(
            [row["name"] for row in default.json()["items"]], ["Butter"]
        )
        archived = self.get_internal("ingredients/", {"status": "archived"})
        self.assertEqual(
            [row["name"] for row in archived.json()["items"]], ["Lard"]
        )
        both = self.get_internal("ingredients/", {"status": "all"})
        # Which rows the filter admits, not the order they lead in.
        self.assertEqual(
            sorted(row["name"] for row in both.json()["items"]),
            ["Butter", "Lard"],
        )
        self.assertEqual(
            self.get_internal("ingredients/", {"status": "retired"}).status_code, 400
        )

    def test_browse_filters_and_counts_categories(self):
        dairy = IngredientCategory.objects.create(
            user=self.user, name="Dairy", normalized_name="dairy"
        )
        self.ingredient("Butter", category=dairy)
        self.ingredient("Flour")
        response = self.get_internal("ingredients/", {"category": str(dairy.id)})
        self.assertEqual(
            [row["name"] for row in response.json()["items"]], ["Butter"]
        )
        self.assertEqual(
            response.json()["facets"]["category"],
            [{"id": str(dairy.id), "name": "Dairy", "count": 1}],
        )
        listed = self.get_internal("ingredient-categories/").json()["items"]
        self.assertEqual(
            listed, [{"id": str(dairy.id), "name": "Dairy", "count": 1}]
        )

    def test_archived_rows_leave_the_pickers_but_keep_costing(self):
        lard = self.ingredient("Lard", status=Ingredient.STATUS_ARCHIVED)
        RecipeLineMatch.objects.create(user=self.user, text="pork fat", ingredient=lard)
        options = self.get_internal("ingredient-options/").json()["items"]
        self.assertEqual(options, [])
        self.assertEqual(saved_line_match_map(self.user), {})
        entries = self.get_internal("pricing-entries/").json()["items"]
        self.assertEqual(
            [(row["name"], row["status"]) for row in entries], [("Lard", "archived")]
        )

    def test_used_in_recipes_sums_one_unit_and_puts_active_first(self):
        butter = self.ingredient("Butter")
        summed = Recipe.objects.create(user=self.user, title="Brioche")
        self.line(summed, butter, 0, "100", "g")
        self.line(summed, butter, 1, "50", "g")
        mixed = Recipe.objects.create(user=self.user, title="Croissant")
        self.line(mixed, butter, 0, "1", "kg")
        self.line(mixed, butter, 1, "200", "g")
        archived = Recipe.objects.create(
            user=self.user, title="Ancienne", status=Recipe.STATUS_ARCHIVED
        )
        self.line(archived, butter, 0, "300", "g")
        other = User.objects.create_user(
            email="other-pantry@example.com",
            name="Other Chef",
            password="another-long-passphrase-2468",
        )
        foreign = Recipe.objects.create(user=other, title="Foreign")
        self.line(foreign, butter, 0, "10", "g")

        usage = ingredient_json(butter)["usedInRecipes"]
        self.assertEqual(
            usage,
            [
                {
                    "id": str(summed.id),
                    "publicId": summed.public_id,
                    "title": "Brioche",
                    "status": "active",
                    "quantity": 150.0,
                    "unit": "g",
                },
                {
                    "id": str(mixed.id),
                    "publicId": mixed.public_id,
                    "title": "Croissant",
                    "status": "active",
                    "quantity": 1.0,
                    "unit": "kg",
                },
                {
                    "id": str(archived.id),
                    "publicId": archived.public_id,
                    "title": "Ancienne",
                    "status": "archived",
                    "quantity": 300.0,
                    "unit": "g",
                },
            ],
        )
