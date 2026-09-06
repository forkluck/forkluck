from decimal import Decimal
import json
from importlib import import_module

from django.core.exceptions import ValidationError
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.db.models.deletion import ProtectedError
from django.test import RequestFactory, TestCase, TransactionTestCase
from django.utils import timezone

from .domains.ingredients.actions import action_delete_ingredient
from .domains.sales.core import action_delete_sales_product, action_save_sales_product
from .domains.sales.views import product_detail
from .domains.shared.versioning import StaleWriteError
from .models import (
    Menu,
    MenuItem,
    BenchCostSettings,
    Ingredient,
    IngredientConversion,
    Preparation,
    Recipe,
    RecipeItem,
    SalesCatalogItem,
    SalesChannelConnection,
    SalesProductVariant,
    SalesImport,
    SalesLine,
    SalesProduct,
    SalesProductComponent,
    SalesProductSku,
    User,
)
from .testing import InternalApiTestCase


class ProductIdentitySaveTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="product-identity@example.com", password="test-password"
        )

    def product(self) -> SalesProduct:
        return SalesProduct.objects.create(
            user=self.user,
            name="Cookie",
            normalized_name="cookie",
        )

    def test_a_product_is_created_sold_by_each(self) -> None:
        result = action_save_sales_product(self.user, {"name": "Loose tea"})
        product = SalesProduct.objects.get(id=result["id"])
        self.assertEqual(product.base_unit, "")

    def test_a_base_unit_is_saved_and_can_be_cleared(self) -> None:
        product = self.product()
        action_save_sales_product(
            self.user,
            {
                "id": str(product.id),
                "expectedEditVersion": product.edit_version,
                "baseUnit": "g",
            },
        )
        product.refresh_from_db()
        self.assertEqual(product.base_unit, "g")

        action_save_sales_product(
            self.user,
            {
                "id": str(product.id),
                "expectedEditVersion": product.edit_version,
                "baseUnit": "",
            },
        )
        product.refresh_from_db()
        self.assertEqual(product.base_unit, "")

    def test_each_is_stored_blank(self) -> None:
        # Blank already means each; accepting both spellings would leave two
        # products sold by the piece comparing as sold by different units.
        product = self.product()
        action_save_sales_product(
            self.user,
            {
                "id": str(product.id),
                "expectedEditVersion": product.edit_version,
                "baseUnit": "each",
            },
        )
        product.refresh_from_db()
        self.assertEqual(product.base_unit, "")

    def test_a_base_unit_survives_an_edit_that_does_not_name_it(self) -> None:
        product = self.product()
        product.base_unit = "g"
        product.save(update_fields=["base_unit", "updated_at"])
        action_save_sales_product(
            self.user,
            {
                "id": str(product.id),
                "expectedEditVersion": product.edit_version,
                "name": "Loose leaf",
            },
        )
        product.refresh_from_db()
        self.assertEqual(product.base_unit, "g")

    def test_a_unit_no_product_is_sold_by_is_refused(self) -> None:
        product = self.product()
        # "pinch" is a real catalog slug, which is the interesting case: the
        # check is against what a product may be sold by, not against the
        # vocabulary as a whole.
        for unit in ("pinch", "case", "not-a-unit"):
            with self.subTest(unit=unit):
                with self.assertRaisesMessage(
                    ValueError, "Unit is not one a product can be sold in"
                ):
                    action_save_sales_product(
                        self.user,
                        {
                            "id": str(product.id),
                            "expectedEditVersion": product.edit_version,
                            "baseUnit": unit,
                        },
                    )
                product.refresh_from_db()
                self.assertEqual(product.base_unit, "")

    def test_flat_scalar_edit_preserves_omitted_relations(self) -> None:
        product = self.product()
        recipe = Recipe.objects.create(
            user=self.user, title="Cookie recipe", code="COOKIE-1"
        )
        SalesProductComponent.objects.create(
            product=product, recipe=recipe, quantity=Decimal("1")
        )
        variant = SalesProductVariant.objects.create(
            user=self.user,
            product=product,
            channel="square",
            match_key="square:item:cookie",
            external_name="Cookie",
        )

        result = action_save_sales_product(
            self.user,
            {
                "id": str(product.id),
                "expectedEditVersion": 0,
                "description": "A crisp cookie",
            },
        )

        product.refresh_from_db()
        self.assertEqual(product.description, "A crisp cookie")
        self.assertEqual(product.edit_version, 1)
        self.assertEqual(result["publicId"], product.public_id)
        self.assertEqual(result["editVersion"], 1)
        self.assertTrue(
            SalesProductComponent.objects.filter(
                product=product, recipe=recipe
            ).exists()
        )
        self.assertTrue(SalesProductVariant.objects.filter(id=variant.id).exists())

    def test_nested_patch_is_not_a_product_edit_shape(self) -> None:
        product = self.product()
        with self.assertRaisesMessage(
            ValueError, "Product fields must be sent at the top level"
        ):
            action_save_sales_product(
                self.user,
                {
                    "id": str(product.id),
                    "expectedEditVersion": 0,
                    "patch": {"description": "ignored"},
                },
            )

    def test_every_edit_requires_expected_version_and_rejects_stale_version(
        self,
    ) -> None:
        product = self.product()
        for replacement in (
            {"description": "missing lock"},
            {"components": []},
            {"variants": []},
        ):
            with self.subTest(replacement=replacement):
                with self.assertRaisesMessage(ValueError, "Edit version is required"):
                    action_save_sales_product(
                        self.user, {"id": str(product.id), **replacement}
                    )
        with self.assertRaises(StaleWriteError):
            action_save_sales_product(
                self.user,
                {
                    "id": str(product.id),
                    "expectedEditVersion": 9,
                    "description": "stale",
                },
            )
        product.refresh_from_db()
        self.assertEqual(product.edit_version, 0)

    def test_sku_is_normalized_and_unique_per_user(self) -> None:
        first = action_save_sales_product(
            self.user,
            {
                "name": "First",
                "skus": [
                    {"sku": "  Cookie\t42 "},
                    {"sku": "Cookie-6", "quantityMultiplier": 6},
                ],
                "recipeLinks": [],
                "variants": [],
            },
        )
        product = SalesProduct.objects.get(id=first["id"])
        self.assertEqual(product.sku, "Cookie\t42")
        rows = list(product.skus.values_list("normalized_sku", "quantity_multiplier"))
        self.assertEqual(
            rows, [("cookie 42", Decimal("1")), ("cookie-6", Decimal("6"))]
        )

        for taken in ("cookie 42", "COOKIE-6"):
            with self.assertRaisesMessage(
                ValueError, "SKU is already used by another product"
            ):
                action_save_sales_product(
                    self.user,
                    {
                        "name": "Duplicate",
                        "skus": [{"sku": taken}],
                        "recipeLinks": [],
                        "variants": [],
                    },
                )
        with self.assertRaisesMessage(ValueError, "skus"):
            action_save_sales_product(
                self.user, {"name": "Old shape", "sku": "x", "variants": []}
            )
        for bad in (
            [{"sku": " "}],
            [{"sku": "A", "quantityMultiplier": 0}],
            [{"sku": "A"}, {"sku": " a ", "quantityMultiplier": 2}],
        ):
            with self.assertRaises(ValueError):
                action_save_sales_product(
                    self.user, {"name": "Bad", "skus": bad, "variants": []}
                )
        # No row at 1 and several rows at 1 are both ordinary lists.
        packs_only = action_save_sales_product(
            self.user,
            {
                "name": "Packs only",
                "skus": [
                    {"sku": "P6", "quantityMultiplier": 6},
                    {"sku": "P12", "quantityMultiplier": 12},
                ],
                "variants": [],
            },
        )
        self.assertEqual(
            SalesProduct.objects.get(id=packs_only["id"]).sku, "P6"
        )
        two_singles = action_save_sales_product(
            self.user,
            {
                "name": "Two singles",
                "skus": [{"sku": "S1"}, {"sku": "S2"}],
                "variants": [],
            },
        )
        self.assertEqual(
            SalesProduct.objects.get(id=two_singles["id"]).sku, "S1"
        )
        no_rows = action_save_sales_product(
            self.user, {"name": "No SKU", "skus": [], "variants": []}
        )
        self.assertEqual(SalesProduct.objects.get(id=no_rows["id"]).sku, "")
        # Replace-all: an omitted row is a removal.
        action_save_sales_product(
            self.user,
            {
                "id": first["id"],
                "expectedEditVersion": 0,
                "skus": [{"sku": "Cookie 42"}],
            },
        )
        self.assertEqual(
            list(product.skus.values_list("sku", flat=True)), ["Cookie 42"]
        )
        self.assertFalse(
            SalesProductSku.objects.filter(normalized_sku="cookie-6").exists()
        )

    def composed_product(self) -> tuple[SalesProduct, SalesProductComponent]:
        """A product with one recipe component and one ingredient component."""
        product = self.product()
        SalesProductComponent.objects.create(
            product=product,
            recipe=Recipe.objects.create(
                user=self.user, title="Old cookie", code="COOKIE-3"
            ),
            quantity=Decimal("1"),
        )
        return product, SalesProductComponent.objects.create(
            product=product,
            ingredient=Ingredient.objects.create(
                user=self.user,
                name="Butter",
                normalized_name="butter",
                purchase_cost_cents=500,
                purchase_size=1000,
                purchase_unit="g",
            ),
            quantity=Decimal("25"),
            unit="g",
            position=1,
        )

    def test_legacy_recipe_links_replace_only_recipe_components(self) -> None:
        product, kept = self.composed_product()
        replacement = Recipe.objects.create(
            user=self.user, title="New cookie", code="COOKIE-4"
        )

        action_save_sales_product(
            self.user,
            {
                "id": str(product.id),
                "expectedEditVersion": 0,
                "name": "Cookie deluxe",
                "recipeLinks": [{"recipeId": str(replacement.id), "quantity": 3}],
            },
        )

        product.refresh_from_db()
        self.assertEqual(product.name, "Cookie deluxe")
        rows = SalesProductComponent.objects.filter(product=product)
        self.assertEqual(
            {(row.recipe_id, row.ingredient_id) for row in rows},
            {(replacement.id, None), (None, kept.ingredient_id)},
        )
        self.assertTrue(rows.filter(id=kept.id).exists())

    def test_empty_legacy_recipe_links_keep_the_ingredient_components(self) -> None:
        product, kept = self.composed_product()

        action_save_sales_product(
            self.user,
            {"id": str(product.id), "expectedEditVersion": 0, "recipeLinks": []},
        )

        self.assertEqual(
            [row.id for row in SalesProductComponent.objects.filter(product=product)],
            [kept.id],
        )

    def test_components_replace_recipe_and_ingredient_rows(self) -> None:
        product = self.product()
        recipe = Recipe.objects.create(
            user=self.user, title="Cookie recipe", code="COOKIE-2"
        )
        ingredient = Ingredient.objects.create(
            user=self.user,
            name="Butter",
            normalized_name="butter",
            purchase_cost_cents=500,
            purchase_size=1000,
            purchase_unit="g",
        )
        result = action_save_sales_product(
            self.user,
            {
                "id": str(product.id),
                "expectedEditVersion": 0,
                "components": [
                    {
                        "recipeId": str(recipe.id),
                        "ingredientId": None,
                        "quantity": 2,
                        "unit": "",
                        "position": 0,
                    },
                    {
                        "recipeId": None,
                        "ingredientId": str(ingredient.id),
                        "quantity": 25,
                        "unit": "g",
                        "position": 1,
                    },
                ],
            },
        )
        self.assertEqual(result["editVersion"], 1)
        rows = list(
            SalesProductComponent.objects.filter(product=product).order_by("position")
        )
        self.assertEqual([(row.recipe_id, row.ingredient_id) for row in rows], [
            (recipe.id, None),
            (None, ingredient.id),
        ])

    def test_components_reject_unknown_ingredient_unit(self) -> None:
        ingredient = Ingredient.objects.create(
            user=self.user,
            name="Butter",
            normalized_name="butter",
            purchase_cost_cents=500,
            purchase_size=1000,
            purchase_unit="g",
        )
        with self.assertRaisesMessage(ValueError, "Invalid unit"):
            action_save_sales_product(
                self.user,
                {
                    "name": "Invalid unit product",
                    "components": [
                        {
                            "recipeId": None,
                            "ingredientId": str(ingredient.id),
                            "quantity": 1,
                            "unit": "furlong",
                            "position": 0,
                        }
                    ],
                },
            )


class SalesProductComponentConstraintTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="product-components@example.com", password="test-password"
        )
        self.product = SalesProduct.objects.create(
            user=self.user, name="Cookie", normalized_name="cookie"
        )
        self.recipe = Recipe.objects.create(user=self.user, title="Cookie recipe")
        self.ingredient = Ingredient.objects.create(
            user=self.user,
            name="Butter",
            normalized_name="butter",
            purchase_cost_cents=500,
            purchase_size=1000,
            purchase_unit="g",
        )

    def test_exactly_one_target_and_unit_rules(self) -> None:
        for row in (
            SalesProductComponent(
                product=self.product,
                recipe=self.recipe,
                ingredient=self.ingredient,
                quantity=1,
            ),
            SalesProductComponent(product=self.product, quantity=1),
            SalesProductComponent(
                product=self.product, recipe=self.recipe, quantity=1, unit="g"
            ),
            SalesProductComponent(
                product=self.product, ingredient=self.ingredient, quantity=1
            ),
        ):
            with self.subTest(row=row):
                with self.assertRaises(ValidationError):
                    row.full_clean()

    def test_quantity_and_target_uniqueness_are_database_protected(self) -> None:
        SalesProductComponent.objects.create(
            product=self.product, recipe=self.recipe, quantity=1
        )
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                SalesProductComponent.objects.create(
                    product=self.product, recipe=self.recipe, quantity=2
                )
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                SalesProductComponent.objects.create(
                    product=self.product,
                    ingredient=self.ingredient,
                    quantity=0,
                    unit="g",
                )
        for kwargs in (
            {"quantity": 1},
            {
                "recipe": self.recipe,
                "ingredient": self.ingredient,
                "quantity": 1,
            },
            {"recipe": self.recipe, "quantity": 1, "unit": "g"},
            {"ingredient": self.ingredient, "quantity": 1, "unit": ""},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(IntegrityError):
                with transaction.atomic():
                    SalesProductComponent.objects.create(
                        product=self.product, **kwargs
                    )
        SalesProductComponent.objects.all().delete()
        SalesProductComponent.objects.create(
            product=self.product, ingredient=self.ingredient, quantity=1, unit="g"
        )
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                SalesProductComponent.objects.create(
                    product=self.product,
                    ingredient=self.ingredient,
                    quantity=2,
                    unit="g",
                )

    def test_recipe_and_ingredient_deletes_are_protected(self) -> None:
        SalesProductComponent.objects.create(
            product=self.product, recipe=self.recipe, quantity=1
        )
        with self.assertRaises(ProtectedError):
            self.recipe.delete()
        SalesProductComponent.objects.all().delete()
        SalesProductComponent.objects.create(
            product=self.product, ingredient=self.ingredient, quantity=1, unit="g"
        )
        with self.assertRaises(ProtectedError):
            self.ingredient.delete()

    def test_ingredient_action_refuses_product_composition_usage(self) -> None:
        SalesProductComponent.objects.create(
            product=self.product, ingredient=self.ingredient, quantity=1, unit="g"
        )
        result = action_delete_ingredient(self.user, {"id": str(self.ingredient.id)})
        self.assertEqual(
            result, {"error": "This ingredient is used in product compositions."}
        )
        self.assertTrue(Ingredient.objects.filter(id=self.ingredient.id).exists())


class SalesProductCostTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="product-cost@example.com", password="test-password"
        )
        self.product = SalesProduct.objects.create(
            user=self.user,
            name="Cookie",
            normalized_name="cookie",
            sell_price_cents=1000,
        )
        self.ingredient = Ingredient.objects.create(
            user=self.user,
            name="Butter",
            normalized_name="butter",
            purchase_cost_cents=500,
            purchase_size=1000,
            purchase_unit="g",
        )

    def detail(self):
        request = RequestFactory().get("/")
        request.user = self.user
        response = product_detail(request, product_ref=self.product.public_id)
        self.assertEqual(response.status_code, 200)
        return json.loads(response.content)["item"]

    def test_direct_ingredient_cost_and_margin(self) -> None:
        SalesProductComponent.objects.create(
            product=self.product,
            ingredient=self.ingredient,
            quantity=100,
            unit="g",
        )
        payload = self.detail()
        self.assertEqual(payload["costCents"], 50)
        self.assertEqual(payload["marginCents"], 950)
        self.assertEqual(payload["marginPercent"], 0.95)

    def test_unpriced_component_keeps_cost_and_margin_null(self) -> None:
        self.ingredient.purchase_size = None
        self.ingredient.save(update_fields=["purchase_size", "updated_at"])
        SalesProductComponent.objects.create(
            product=self.product,
            ingredient=self.ingredient,
            quantity=100,
            unit="g",
        )
        payload = self.detail()
        self.assertIsNone(payload["costCents"])
        self.assertIsNone(payload["marginCents"])
        self.assertIsNone(payload["marginPercent"])

    def test_recipe_with_fully_excluded_lines_has_zero_cost(self) -> None:
        recipe = Recipe.objects.create(
            user=self.user, title="Packaging batch", yield_amount=1, yield_unit="each"
        )
        RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.INGREDIENT,
            position=0,
            quantity=1,
            unit="each",
            ingredient=self.ingredient,
            excluded_from_cost=True,
        )
        self.ingredient.purchase_size = None
        self.ingredient.save(update_fields=["purchase_size", "updated_at"])
        SalesProductComponent.objects.create(
            product=self.product, recipe=recipe, quantity=1
        )
        payload = self.detail()
        self.assertEqual(payload["costCents"], 0)
        self.assertEqual(payload["marginCents"], 1000)

    def test_recipe_component_quantity_counts_full_batches(self) -> None:
        recipe = Recipe.objects.create(
            user=self.user, title="Cookie batch", yield_amount=100, yield_unit="g"
        )
        RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.INGREDIENT,
            position=0,
            quantity=100,
            unit="g",
            ingredient=self.ingredient,
        )
        SalesProductComponent.objects.create(
            product=self.product, recipe=recipe, quantity=2
        )
        payload = self.detail()
        self.assertEqual(payload["costCents"], 100)

    def test_a_costed_product_reports_no_issues(self) -> None:
        SalesProductComponent.objects.create(
            product=self.product,
            ingredient=self.ingredient,
            quantity=100,
            unit="g",
        )
        self.assertEqual(self.detail()["costIssues"], [])

    def test_a_product_without_composition_says_so(self) -> None:
        payload = self.detail()
        self.assertIsNone(payload["costCents"])
        self.assertEqual(
            payload["costIssues"],
            [{"code": "no-composition", "path": [], "detail": None}],
        )

    def test_an_unpriced_ingredient_names_itself(self) -> None:
        self.ingredient.purchase_cost_cents = 0
        self.ingredient.save(update_fields=["purchase_cost_cents", "updated_at"])
        SalesProductComponent.objects.create(
            product=self.product,
            ingredient=self.ingredient,
            quantity=100,
            unit="g",
        )
        payload = self.detail()
        self.assertIsNone(payload["costCents"])
        self.assertEqual(
            payload["costIssues"],
            [
                {
                    "code": "missing-ingredient-price",
                    "path": ["Butter"],
                    "detail": None,
                }
            ],
        )

    def test_a_missing_purchase_size_is_named_apart_from_a_missing_price(
        self,
    ) -> None:
        self.ingredient.purchase_size = None
        self.ingredient.save(update_fields=["purchase_size", "updated_at"])
        SalesProductComponent.objects.create(
            product=self.product,
            ingredient=self.ingredient,
            quantity=100,
            unit="g",
        )
        payload = self.detail()
        self.assertIsNone(payload["costCents"])
        codes = [issue["code"] for issue in payload["costIssues"]]
        self.assertNotIn("missing-ingredient-price", codes)
        self.assertEqual(
            [issue["path"] for issue in payload["costIssues"]], [["Butter"]]
        )

    def test_an_unpriced_ingredient_inside_a_recipe_names_both(self) -> None:
        recipe = Recipe.objects.create(
            user=self.user, title="Cookie batch", yield_amount=100, yield_unit="g"
        )
        RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.INGREDIENT,
            position=0,
            quantity=100,
            unit="g",
            ingredient=self.ingredient,
        )
        self.ingredient.purchase_cost_cents = 0
        self.ingredient.save(update_fields=["purchase_cost_cents", "updated_at"])
        SalesProductComponent.objects.create(
            product=self.product, recipe=recipe, quantity=1
        )
        payload = self.detail()
        self.assertIsNone(payload["costCents"])
        self.assertEqual(
            payload["costIssues"],
            [
                {
                    "code": "missing-ingredient-price",
                    "path": ["Cookie batch", "Butter"],
                    "detail": None,
                }
            ],
        )

    def test_a_repeated_cause_is_reported_once(self) -> None:
        # Two lines of the same unpriced ingredient recode to one identical
        # (recipe, ingredient) issue; repeating it would say "2 things to fix"
        # for a single fix.
        recipe = Recipe.objects.create(
            user=self.user, title="Dough", yield_amount=100, yield_unit="g"
        )
        for position in (0, 1):
            RecipeItem.objects.create(
                recipe=recipe,
                kind=RecipeItem.INGREDIENT,
                position=position,
                quantity=50,
                unit="g",
                ingredient=self.ingredient,
            )
        self.ingredient.purchase_cost_cents = 0
        self.ingredient.save(update_fields=["purchase_cost_cents", "updated_at"])
        SalesProductComponent.objects.create(
            product=self.product, recipe=recipe, quantity=1
        )
        payload = self.detail()
        self.assertIsNone(payload["costCents"])
        self.assertEqual(
            payload["costIssues"],
            [
                {
                    "code": "missing-ingredient-price",
                    "path": ["Dough", "Butter"],
                    "detail": None,
                }
            ],
        )

    def test_a_subrecipe_cycle_is_unresolved_rather_than_free(self) -> None:
        # `RecipeItem.clean` refuses this edge, so only a row written straight
        # through the manager can hold one — the same state recipe health
        # already defends against. Before the cycle reached the payload the
        # expansion returned no materials and the product costed at zero,
        # which reads as a free product rather than an unanswered question.
        outer = Recipe.objects.create(
            user=self.user, title="Outer", yield_amount=1, yield_unit="each"
        )
        inner = Recipe.objects.create(
            user=self.user, title="Inner", yield_amount=1, yield_unit="each"
        )
        RecipeItem.objects.create(
            recipe=outer,
            kind=RecipeItem.SUBRECIPE,
            position=0,
            quantity=1,
            unit="each",
            subrecipe=inner,
        )
        RecipeItem.objects.create(
            recipe=inner,
            kind=RecipeItem.SUBRECIPE,
            position=0,
            quantity=1,
            unit="each",
            subrecipe=outer,
        )
        SalesProductComponent.objects.create(
            product=self.product, recipe=outer, quantity=1
        )
        payload = self.detail()
        self.assertIsNone(payload["costCents"])
        self.assertIsNone(payload["marginCents"])
        self.assertIn(
            "recipe-cycle", [issue["code"] for issue in payload["costIssues"]]
        )

    def test_an_excluded_line_never_withholds_a_cost(self) -> None:
        # The companion of `test_recipe_with_fully_excluded_lines_has_zero_cost`:
        # the excluded line is unresolvable, and its issue must not surface as
        # a reason the product cannot be costed.
        recipe = Recipe.objects.create(
            user=self.user, title="Packaging batch", yield_amount=1, yield_unit="each"
        )
        RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.INGREDIENT,
            position=0,
            quantity=1,
            unit="each",
            ingredient=self.ingredient,
            excluded_from_cost=True,
        )
        self.ingredient.purchase_size = None
        self.ingredient.save(update_fields=["purchase_size", "updated_at"])
        SalesProductComponent.objects.create(
            product=self.product, recipe=recipe, quantity=1
        )
        payload = self.detail()
        self.assertEqual(payload["costCents"], 0)
        self.assertEqual(payload["costIssues"], [])

    def test_recipe_without_yield_costs_a_full_batch(self) -> None:
        recipe = Recipe.objects.create(user=self.user, title="No-yield batch")
        RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.INGREDIENT,
            position=0,
            quantity=100,
            unit="g",
            ingredient=self.ingredient,
        )
        SalesProductComponent.objects.create(
            product=self.product, recipe=recipe, quantity=2
        )
        payload = self.detail()
        self.assertEqual(payload["costCents"], 100)


class ProductDetailTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="product-detail@example.com", password="test-password"
        )
        self.stranger = User.objects.create_user(
            email="product-detail-stranger@example.com", password="test-password"
        )
        self.product = SalesProduct.objects.create(
            user=self.user,
            name="Cookie",
            normalized_name="cookie",
        )

    def test_public_and_uuid_refs_are_owner_scoped(self) -> None:
        self.client.force_login(self.user)
        for ref in (self.product.public_id, str(self.product.id)):
            with self.subTest(ref=ref):
                response = self.get_internal(f"product/{ref}/")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["item"]["publicId"], self.product.public_id)

        foreign = SalesProduct.objects.create(
            user=self.stranger,
            name="Private cookie",
            normalized_name="private cookie",
        )
        response = self.get_internal(f"product/{foreign.public_id}/")
        self.assertEqual(response.status_code, 404)
        response = self.get_internal(f"product/{foreign.id}/")
        self.assertEqual(response.status_code, 404)

    def test_invalid_product_date_range_is_rejected(self) -> None:
        self.client.force_login(self.user)
        for query in (
            {"start": "not-a-date"},
            {"end": "2026-01-01"},
            {"start": "2026-02-01", "end": "2026-01-01"},
        ):
            with self.subTest(query=query):
                response = self.get_internal(
                    f"product/{self.product.public_id}/", query
                )
                self.assertEqual(response.status_code, 400)

    def test_a_member_page_carries_both_views_of_its_sales(self) -> None:
        """The page shows both figures at once, so one request returns both."""
        self.client.force_login(self.user)
        box = SalesProduct.objects.create(
            user=self.user, name="Cookie box", normalized_name="cookie box"
        )
        SalesProductComponent.objects.create(
            product=box, component_product=self.product, quantity=3, position=0
        )
        own = SalesProductVariant.objects.create(
            user=self.user,
            product=self.product,
            channel="square",
            match_key="square:item:cookie",
            external_name="Cookie",
        )
        boxed = SalesProductVariant.objects.create(
            user=self.user,
            product=box,
            channel="square",
            match_key="square:item:cookie-box",
            external_name="Cookie box",
        )
        sales_import = SalesImport.objects.create(
            user=self.user, file_name="sales.csv", channel="square"
        )
        for position, variant in enumerate((own, boxed)):
            SalesLine.objects.create(
                user=self.user,
                sales_import=sales_import,
                product=variant.product,
                variant=variant,
                channel="square",
                source_position=position,
                source_fingerprint=f"both-views-{position}",
                external_order_id=str(position),
                sold_at=timezone.now(),
                item_name=variant.external_name,
                quantity=Decimal("1"),
                gross_cents=1000,
                net_sales_cents=1000,
            )

        item = self.get_internal(f"product/{self.product.public_id}/").json()["item"]

        self.assertEqual(item["sales"]["netSalesCents"], 2000)
        self.assertEqual(item["sales"]["quantity"], 4)
        self.assertEqual(item["salesAsSold"]["netSalesCents"], 1000)
        self.assertEqual(item["salesAsSold"]["quantity"], 1)
        self.assertEqual(item["sales"]["asSoldNetSalesCents"], 1000)
        self.assertFalse(item["sales"]["sharedToMembers"])

        box_item = self.get_internal(f"product/{box.public_id}/").json()["item"]

        self.assertTrue(box_item["sales"]["sharedToMembers"])
        self.assertEqual(box_item["sales"]["netSalesCents"], 0)
        self.assertEqual(box_item["sales"]["asSoldNetSalesCents"], 1000)
        self.assertEqual(box_item["salesAsSold"]["netSalesCents"], 1000)
        self.assertEqual(box_item["sales"]["splitBasis"], "count")

    def test_detail_query_count_stays_fixed_as_components_and_ledger_grow(self) -> None:
        direct_variant = SalesProductVariant.objects.create(
            user=self.user,
            product=self.product,
            channel="square",
            match_key="square:item:query-cookie",
            external_name="Cookie",
        )
        sales_import = SalesImport.objects.create(
            user=self.user, file_name="query.csv", channel="square"
        )

        def add_component_and_line(index: int) -> None:
            ingredient = Ingredient.objects.create(
                user=self.user,
                name=f"Query ingredient {index}",
                normalized_name=f"query ingredient {index}",
                purchase_cost_cents=500,
                purchase_size=1000,
                purchase_unit="g",
            )
            IngredientConversion.objects.create(
                user=self.user, ingredient=ingredient, average_weight=True
            )
            Preparation.objects.create(
                user=self.user,
                ingredient=ingredient,
                name="Prepared",
                normalized_name="prepared",
            )
            SalesProductComponent.objects.create(
                product=self.product,
                ingredient=ingredient,
                quantity=1,
                unit="g",
                position=index,
            )
            SalesLine.objects.create(
                user=self.user,
                sales_import=sales_import,
                product=self.product,
                variant=direct_variant,
                channel="square",
                source_position=index,
                source_fingerprint=f"query-{index}",
                external_order_id=f"query-order-{index}",
                sold_at=timezone.now(),
                item_name="Cookie",
                group_key=direct_variant.match_key,
                match_key=direct_variant.match_key,
                quantity=Decimal("1"),
                net_sales_cents=100,
            )

        add_component_and_line(0)
        request = RequestFactory().get("/")
        request.user = self.user
        with self.assertNumQueries(
            15,
            msg=(
                "product detail must keep relation assembly fixed-size as "
                "components and sales ledger rows grow; one existence query guards "
                "the all-history incomplete-manual-revenue warning, and the bundle "
                "graph is loaded once for both views"
            ),
        ):
            response = product_detail(
                request, product_ref=self.product.public_id
            )
        for index in (1, 2):
            add_component_and_line(index)
        with self.assertNumQueries(
            15,
            msg=(
                "product detail must not add per-component or per-ledger-row "
                "queries when assembling the tenant snapshot"
            ),
        ):
            response = product_detail(request, product_ref=self.product.public_id)
        payload = json.loads(response.content)["item"]
        self.assertFalse(payload["incompleteManualRevenue"])
        self.assertEqual(payload["costCents"], 2)
        self.assertEqual(payload["marginCents"], -2)
        self.assertEqual(payload["marginPercent"], None)
        self.assertEqual(payload["currencyCode"], "USD")
        self.assertNotIn("warning", payload)
        self.assertNotIn("costSummary", payload)
        self.assertNotIn("variantsByChannel", payload)

    def test_detail_filters_sales_to_workspace_currency(self) -> None:
        BenchCostSettings.objects.create(user=self.user, currency_code="USD")
        variant = SalesProductVariant.objects.create(
            user=self.user,
            product=self.product,
            channel="square",
            match_key="square:item:currency-cookie",
            external_name="Cookie",
        )
        for currency, amount, position in (("USD", 100, 1), ("EUR", 900, 2)):
            sales_import = SalesImport.objects.create(
                user=self.user,
                file_name=f"{currency}.csv",
                channel="square",
                currency_code=currency,
            )
            SalesLine.objects.create(
                user=self.user,
                sales_import=sales_import,
                product=self.product,
                variant=variant,
                channel="square",
                source_position=position,
                source_fingerprint=f"currency-{currency}",
                external_order_id=f"order-{currency}",
                sold_at=timezone.now(),
                item_name="Cookie",
                group_key=variant.match_key,
                match_key=variant.match_key,
                quantity=Decimal("1"),
                gross_cents=amount,
                net_sales_cents=amount,
                currency_code=currency,
            )

        request = RequestFactory().get("/")
        request.user = self.user
        response = product_detail(request, product_ref=self.product.public_id)
        payload = json.loads(response.content)["item"]
        self.assertEqual(payload["currencyCode"], "USD")
        self.assertEqual(payload["sales"]["lineCount"], 1)
        self.assertEqual(payload["sales"]["netSalesCents"], 100)


class ProductDeleteGuardTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="product-delete@example.com", password="test-password"
        )

    def product(self, name: str) -> SalesProduct:
        return SalesProduct.objects.create(
            user=self.user, name=name, normalized_name=name.casefold()
        )

    def line(self, product: SalesProduct, *, channel: str) -> SalesLine:
        sales_import = SalesImport.objects.create(
            user=self.user, file_name="history.csv", channel="square"
        )
        return SalesLine.objects.create(
            user=self.user,
            sales_import=sales_import,
            product=product,
            channel=channel,
            source_position=1,
            source_fingerprint=f"{channel}-{product.id}",
            external_order_id="order-1",
            sold_at=timezone.now(),
            item_name=product.name,
            quantity=Decimal("1"),
        )

    def test_saved_menu_reference_blocks_delete(self) -> None:
        product = self.product("Saved product")
        menu = Menu.objects.create(user=self.user, name="Saved menu")
        MenuItem.objects.create(
            menu=menu,
            name="Saved product",
            sell_price_cents=100,
            original_sell_price_cents=100,
            product=product,
        )
        with self.assertRaisesMessage(ValueError, "saved menus"):
            action_delete_sales_product(self.user, {"id": str(product.id)})

    def test_provider_history_without_variant_does_not_block_delete(self) -> None:
        product = self.product("Provider product")
        self.line(product, channel="square")
        action_delete_sales_product(self.user, {"id": str(product.id)})
        self.assertFalse(SalesProduct.objects.filter(id=product.id).exists())

    def test_manual_history_still_blocks_delete(self) -> None:
        product = self.product("Manual product")
        self.line(product, channel="manual")
        with self.assertRaisesMessage(ValueError, "manual sales history"):
            action_delete_sales_product(self.user, {"id": str(product.id)})


class CanonicalProductSkuMirrorTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="canonical-sku@example.com", password="test-password"
        )
        now = timezone.now()
        for provider, account in (("shopify", "shop-1"), ("square", "merchant-1")):
            SalesChannelConnection.objects.create(
                user=self.user,
                provider=provider,
                provider_account_id=account,
                access_token_encrypted="token",
                status=SalesChannelConnection.Status.ACTIVE,
                product_catalog_synced_at=now,
            )

    def test_canonical_sku_mirrors_repeated_unambiguous_identities(self) -> None:
        for key, name in (("square:item:one", "Cookie one"), ("square:item:two", "Cookie two")):
            SalesCatalogItem.objects.create(
                user=self.user,
                channel="square",
                provider_account_id="merchant-1",
                match_key=key,
                sku="CAN-42",
                item_name=name,
                last_seen_at=timezone.now(),
            )
        result = action_save_sales_product(
            self.user,
            {
                "name": "Canonical cookie",
                "skus": [{"sku": " CAN-42 "}],
                "recipeLinks": [],
                "variants": [
                    {
                        "channel": "shopify",
                        "providerAccountId": "shop-1",
                        "matchKey": "shopify:item:source",
                        "sku": "provider-old-sku",
                        "externalName": "Canonical cookie",
                        "quantityMultiplier": 1,
                    }
                ],
            },
        )
        product = SalesProduct.objects.get(id=result["id"])
        mirrors = SalesProductVariant.objects.filter(
            user=self.user,
            product=product,
            channel="square",
            link_source=SalesProductVariant.LinkSource.AUTO_SKU,
        )
        self.assertEqual(mirrors.count(), 2)
        self.assertEqual(set(mirrors.values_list("match_key", flat=True)), {
            "square:item:one",
            "square:item:two",
        })


class SalesProductIdentityMigrationTests(TransactionTestCase):
    migrate_from = ("forkluck", "0002_recipe_nutrition_package")
    migrate_to = ("forkluck", "0005_harden_sales_product_identity")

    def setUp(self) -> None:
        super().setUp()
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_from])
        self.old_apps = executor.loader.project_state([self.migrate_from]).apps

    def tearDown(self) -> None:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def test_identity_migrations_split_nullable_backfill_and_hardening(self) -> None:
        self.executor = MigrationExecutor(connection)
        self.executor.migrate([("forkluck", "0003_sales_product_identity")])
        apps_47 = self.executor.loader.project_state(
            [("forkluck", "0003_sales_product_identity")]
        ).apps
        User47 = apps_47.get_model("forkluck", "User")
        SalesProduct47 = apps_47.get_model("forkluck", "SalesProduct")
        user = User47.objects.create(
            email="migration-products@example.com",
            name="Migration",
            password="!",
            first_name="",
            last_name="",
        )
        first = SalesProduct47.objects.create(
            user=user, name="First", normalized_name="first"
        )
        second = SalesProduct47.objects.create(
            user=user, name="Second", normalized_name="second"
        )
        self.assertTrue(SalesProduct47._meta.get_field("public_id").null)

        migration_0048 = import_module(
            "forkluck." + "migrations.0004_backfill_sales_product_public_ids"
        )
        self.executor.loader.build_graph()
        self.executor.migrate([("forkluck", "0004_backfill_sales_product_public_ids")])
        apps_48 = self.executor.loader.project_state(
            [("forkluck", "0004_backfill_sales_product_public_ids")]
        ).apps
        SalesProduct48 = apps_48.get_model("forkluck", "SalesProduct")
        first_48 = SalesProduct48.objects.get(pk=first.pk)
        second_48 = SalesProduct48.objects.get(pk=second.pk)
        self.assertTrue(
            first_48.public_id == migration_0048._deterministic_id(first.id)
        )
        self.assertEqual(
            second_48.public_id, migration_0048._deterministic_id(second.id)
        )
        self.assertTrue(SalesProduct48._meta.get_field("public_id").null)
        migration_0048.backfill_sales_product_public_ids(apps_48, None)
        self.assertEqual(
            SalesProduct48.objects.get(pk=first.pk).public_id, first_48.public_id
        )

        self.executor.loader.build_graph()
        self.executor.migrate([self.migrate_to])
        apps_49 = self.executor.loader.project_state([self.migrate_to]).apps
        SalesProduct49 = apps_49.get_model("forkluck", "SalesProduct")
        public_id_field = SalesProduct49._meta.get_field("public_id")
        self.assertFalse(public_id_field.null)
        self.assertTrue(public_id_field.unique)
        self.assertIsNotNone(public_id_field.default)
        generated = SalesProduct49.objects.create(
            user_id=user.pk, name="Generated", normalized_name="generated"
        )
        self.assertTrue(generated.public_id.startswith("prd_"))
        with self.assertRaises(IntegrityError):
            SalesProduct49.objects.create(
                user_id=user.pk,
                name="Duplicate public id",
                normalized_name="duplicate public id",
                public_id=first_48.public_id,
            )
        SalesProduct49.objects.create(
            user_id=user.pk,
            name="Canonical",
            normalized_name="canonical",
            normalized_sku="sku-1",
        )
        with self.assertRaises(IntegrityError):
            SalesProduct49.objects.create(
                user_id=user.pk,
                name="Duplicate SKU",
                normalized_name="duplicate sku",
                normalized_sku="sku-1",
            )


class SalesProductSkuMigrationTests(TransactionTestCase):
    """0017 copies each product's SKU into the table as its x1 row."""

    migrate_from = ("forkluck", "0016_sales_product_sku")
    migrate_to = ("forkluck", "0017_backfill_sales_product_sku")

    def setUp(self) -> None:
        super().setUp()
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_from])
        apps = executor.loader.project_state([self.migrate_from]).apps
        User = apps.get_model("forkluck", "User")
        SalesProduct = apps.get_model("forkluck", "SalesProduct")
        user = User.objects.create(
            email="migration-skus@example.com",
            name="Migration",
            password="!",
            first_name="",
            last_name="",
        )
        self.user_id = user.pk
        self.with_sku = SalesProduct.objects.create(
            user=user,
            name="Cookie",
            normalized_name="cookie",
            sku="Cookie 42",
            normalized_sku="cookie 42",
        ).pk
        self.without_sku = SalesProduct.objects.create(
            user=user, name="Blank", normalized_name="blank"
        ).pk

    def tearDown(self) -> None:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def test_copies_each_non_blank_sku_as_the_x1_row(self) -> None:
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_to])
        apps = executor.loader.project_state([self.migrate_to]).apps
        Sku = apps.get_model("forkluck", "SalesProductSku")
        rows = list(
            Sku.objects.filter(user_id=self.user_id).values_list(
                "product_id", "sku", "normalized_sku", "quantity_multiplier", "position"
            )
        )
        self.assertEqual(
            rows, [(self.with_sku, "Cookie 42", "cookie 42", Decimal("1"), 0)]
        )


class SalesProductComponentMigrationTests(TransactionTestCase):
    migrate_from = ("forkluck", "0005_harden_sales_product_identity")
    migrate_to = ("forkluck", "0006_sales_product_component")

    def setUp(self) -> None:
        super().setUp()
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_from])
        apps = executor.loader.project_state([self.migrate_from]).apps
        User = apps.get_model("forkluck", "User")
        SalesProduct = apps.get_model("forkluck", "SalesProduct")
        Recipe = apps.get_model("forkluck", "Recipe")
        Legacy = apps.get_model("forkluck", "SalesProductRecipe")
        user = User.objects.create(
            email="component-migration@example.com",
            name="Migration",
            password="!",
            first_name="",
            last_name="",
        )
        product = SalesProduct.objects.create(
            user=user, name="Legacy product", normalized_name="legacy product"
        )
        recipe = Recipe.objects.create(user=user, title="Legacy recipe")
        row = Legacy.objects.create(
            product_id=product.pk, recipe_id=recipe.pk, quantity=Decimal("2")
        )
        self.legacy_id = row.pk
        self.product_id = product.pk
        self.recipe_id = recipe.pk

    def tearDown(self) -> None:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def test_rename_keeps_existing_component_identity_and_values(self) -> None:
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_to])
        apps = executor.loader.project_state([self.migrate_to]).apps
        Component = apps.get_model("forkluck", "SalesProductComponent")
        row = Component.objects.get(pk=self.legacy_id)
        self.assertEqual(row.product_id, self.product_id)
        self.assertEqual(row.recipe_id, self.recipe_id)
        self.assertIsNone(row.ingredient_id)
        self.assertEqual(row.quantity, Decimal("2.000"))
        self.assertEqual(row.position, 0)
        self.assertEqual(row.unit, "")
