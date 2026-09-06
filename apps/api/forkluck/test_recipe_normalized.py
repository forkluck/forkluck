"""Security and invariant tests for the normalized recipe aggregate."""

from decimal import Decimal
import json
from unittest import mock
from uuid import uuid4

from django.core.exceptions import ValidationError
from django.db import connection
from django.db.models.deletion import RestrictedError
from django.test import RequestFactory, TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from .domains.ingredients.views import matches as ingredient_matches
from .domains.recipes.actions import (
    action_delete_recipe_comment,
    action_save_recipe,
    action_save_recipe_comment,
    action_update_recipe_costing,
)
from .domains.recipes.health import RecipeHealthReadModel, recipe_allergens
from .domains.recipes.serializers import recipe_json, recipe_used_in_json
from .domains.recipes.views import (
    recipe_detail,
    recipe_health,
    recipe_nutrition,
    recipes,
)
from .domains.shared.ingredient_identity import save_line_match, saved_line_matches
from .models import (
    CatalogIngredient,
    CatalogIngredientAllergen,
    CatalogImportBatch,
    CatalogProduct,
    CatalogSource,
    Ingredient,
    IngredientMeasure,
    KitchenMembership,
    Preparation,
    Recipe,
    RecipeEquivalency,
    RecipeCategory,
    RecipeItem,
    RecipeMedia,
    RecipeLineMatch,
    RecipeShare,
    RecipeTag,
    RecipeTagMembership,
    User,
)


class NormalizedRecipeSecurityTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(email="owner-normalized@example.com", name="Owner", password="pass")
        self.editor = User.objects.create_user(
            email="editor-normalized@example.com",
            name="Editor",
            password="pass",
            email_verified_at=timezone.now(),
        )
        self.viewer = User.objects.create_user(
            email="viewer-normalized@example.com",
            name="Viewer",
            password="pass",
            email_verified_at=timezone.now(),
        )
        self.recipe = Recipe.objects.create(user=self.owner, title="Sauce", body="")
        RecipeShare.objects.create(recipe=self.recipe, recipient=self.editor, role=RecipeShare.EDITOR)
        RecipeShare.objects.create(recipe=self.recipe, recipient=self.viewer, role=RecipeShare.VIEWER)
        self.ingredient = Ingredient.objects.create(
            user=self.owner, name="Salt", purchase_cost_cents=100, purchase_size=1, purchase_unit="kg"
        )

    def test_create_keeps_owned_and_unresolved_ingredient_identities_distinct(self):
        saved = action_save_recipe(
            self.owner,
            {
                "id": None,
                "title": "Primo soup",
                "items": [
                    {
                        "kind": "ingredient",
                        "ingredientId": str(self.ingredient.id),
                        "displayName": "Salt",
                        "quantity": 5,
                        "unit": "g",
                    },
                    {
                        "kind": "ingredient",
                        "ingredientId": None,
                        "displayName": "Lovage",
                        "quantity": 1,
                        "unit": "bunch",
                    },
                ],
                "steps": [],
            },
        )

        items = list(
            RecipeItem.objects.filter(recipe_id=saved["id"]).order_by("position")
        )
        self.assertEqual(items[0].ingredient_id, self.ingredient.id)
        self.assertIsNone(items[1].ingredient_id)
        self.assertEqual(items[1].display_name, "Lovage")

    def test_create_with_a_foreign_ingredient_rolls_back_the_recipe(self):
        foreign = Ingredient.objects.create(
            user=self.editor,
            name="Private saffron",
            purchase_cost_cents=100,
            purchase_size=1,
            purchase_unit="g",
        )

        with self.assertRaisesRegex(ValueError, "Ingredient not found"):
            action_save_recipe(
                self.owner,
                {
                    "id": None,
                    "title": "Must not survive",
                    "items": [
                        {
                            "kind": "ingredient",
                            "ingredientId": str(foreign.id),
                            "displayName": foreign.name,
                            "quantity": 1,
                            "unit": "g",
                        }
                    ],
                    "steps": [],
                },
            )

        self.assertFalse(
            Recipe.objects.filter(user=self.owner, title="Must not survive").exists()
        )

    def content(self, *, actor, **extra):
        """The aggregate save, carrying only the content this suite is about."""
        self.recipe.refresh_from_db()
        body = {
            "id": str(self.recipe.id),
            "title": self.recipe.title,
            "items": [{"kind": "ingredient", "ingredientId": str(self.ingredient.id), "displayName": "Salt", "quantity": 1, "unit": "g"}],
            "steps": [],
        }
        if self.recipe.yield_amount is not None:
            body["yieldAmount"] = float(self.recipe.yield_amount)
            body["yieldUnit"] = self.recipe.yield_unit
        body.update(extra)
        return action_save_recipe(actor, body)

    def test_editor_can_write_content_but_not_owner_metadata(self):
        self.content(actor=self.editor)
        with self.assertRaises(ValueError):
            self.content(actor=self.editor, batchSizes=[{"label": "Batch", "scale": 1, "isOriginal": True}])
        with self.assertRaises(ValueError):
            self.content(actor=self.viewer)

    def test_owner_can_update_clear_and_readd_a_recipe_equivalency(self):
        def stated(count):
            return {
                "massAmount": None, "massUnit": "",
                "volumeAmount": None, "volumeUnit": "",
                "countAmount": count,
                "countUnit": "each" if count is not None else "",
                "standard": False,
            }

        self.content(actor=self.owner, equivalency=stated(1))
        first = RecipeEquivalency.objects.get(recipe=self.recipe)

        self.content(actor=self.owner, equivalency=stated(100))
        updated = RecipeEquivalency.objects.get(recipe=self.recipe)
        self.assertEqual(updated.id, first.id)
        self.assertEqual(updated.count_amount, Decimal("100.000000"))

        self.content(actor=self.owner, equivalency=stated(None))
        self.assertFalse(RecipeEquivalency.objects.filter(recipe=self.recipe).exists())

        self.content(actor=self.owner, equivalency=stated(10))
        readded = RecipeEquivalency.objects.get(recipe=self.recipe)
        self.assertNotEqual(readded.id, first.id)
        self.assertEqual(readded.count_amount, Decimal("10.000000"))

    def test_custom_equivalency_clears_the_yield_family_but_standard_keeps_it(self):
        self.recipe.yield_amount = 1600
        self.recipe.yield_unit = "ml"
        self.recipe.save(update_fields=["yield_amount", "yield_unit"])
        values = {
            "massAmount": 850,
            "massUnit": "g",
            "volumeAmount": 1600,
            "volumeUnit": "ml",
            "countAmount": None,
            "countUnit": "",
            "standard": False,
        }

        self.content(actor=self.owner, equivalency=values)
        custom = RecipeEquivalency.objects.get(recipe=self.recipe)
        self.assertEqual(custom.mass_amount, Decimal("850.000000"))
        self.assertIsNone(custom.volume_amount)
        self.assertEqual(custom.volume_unit, "")

        self.content(
            actor=self.owner,
            equivalency={
                **values,
                "massAmount": 8,
                "massUnit": "oz",
                "volumeAmount": 1,
                "volumeUnit": "cup",
                "standard": True,
            },
        )
        standard = RecipeEquivalency.objects.get(recipe=self.recipe)
        self.assertEqual(standard.mass_amount, Decimal("8.000000"))
        self.assertEqual(standard.volume_amount, Decimal("1.000000"))

    def test_recipe_equivalency_rejects_a_unit_in_the_wrong_family_slot(self):
        equivalency = RecipeEquivalency(
            recipe=self.recipe,
            mass_amount=1,
            mass_unit="cup",
            standard=False,
        )

        with self.assertRaisesRegex(ValidationError, "mass unit must be a mass unit"):
            equivalency.full_clean()

    def test_standard_equivalency_scales_its_ratio_to_total_yield(self):
        self.recipe.title = "Reduced glaze"
        self.recipe.body = "1000 g Salt"
        self.recipe.yield_amount = 1600
        self.recipe.yield_unit = "ml"
        self.recipe.save(
            update_fields=["title", "body", "yield_amount", "yield_unit"]
        )
        RecipeItem.objects.create(
            recipe=self.recipe,
            kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient,
            display_name=self.ingredient.name,
            quantity=1000,
            unit="g",
            position=0,
        )
        RecipeEquivalency.objects.create(
            recipe=self.recipe,
            mass_amount=8,
            mass_unit="oz",
            volume_amount=1,
            volume_unit="cup",
            standard=True,
        )
        parent = Recipe.objects.create(
            user=self.owner,
            title="Glazed vegetables",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )
        RecipeItem.objects.create(
            recipe=parent,
            kind=RecipeItem.SUBRECIPE,
            subrecipe=self.recipe,
            display_name=self.recipe.title,
            quantity=500,
            unit="g",
            position=0,
        )

        row = RecipeHealthReadModel(self.owner)._normalized_row(parent)
        standard_batch_grams = 1600 / 236.5882365 * 226.796185
        self.assertAlmostEqual(
            row["ingredientCents"],
            100 * 500 / standard_batch_grams,
            places=4,
        )

    def test_a_line_saves_and_reads_back_its_cost_exclusion(self):
        self.content(
            actor=self.owner,
            items=[
                {
                    "kind": "ingredient",
                    "ingredientId": str(self.ingredient.id),
                    "displayName": "Salt",
                    "quantity": 1,
                    "unit": "g",
                    "excludedFromCost": True,
                }
            ],
        )
        item = self.recipe.items.get()
        self.assertTrue(item.excluded_from_cost)
        payload = recipe_json(self.recipe, viewer_user=self.owner)
        self.assertTrue(payload["items"][0]["excludedFromCost"])

    def test_editor_cannot_change_lifecycle_or_cost(self):
        with self.assertRaises(ValueError):
            action_save_recipe(self.editor, {"id": str(self.recipe.id), "title": "Changed", "status": "archived"})
        with self.assertRaises(ValueError):
            action_save_recipe(self.editor, {"id": str(self.recipe.id), "title": "Changed", "menuPriceCents": 999})

    def test_editor_preserves_cost_exclusion_by_line_id_across_reorder_and_saves(self):
        self.content(actor=self.owner)
        included = self.recipe.items.get()
        excluded = RecipeItem.objects.create(
            recipe=self.recipe, position=1, kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient, display_name="Salt", quantity=2,
            unit="g", excluded_from_cost=True,
        )
        new_id = uuid4()
        rows = [
            {"id": str(item_id), "kind": "ingredient",
             "ingredientId": str(self.ingredient.id), "displayName": "Salt",
             "quantity": quantity, "unit": "g"}
            for item_id, quantity in ((excluded.id, 3), (included.id, 4), (new_id, 5))
        ]
        for items in (rows, list(reversed(rows))):
            self.content(actor=self.editor, items=items)
            actual = list(self.recipe.items.all())
            self.assertEqual([str(item.id) for item in actual], [item["id"] for item in items])
            self.assertEqual(
                {item.id: item.excluded_from_cost for item in actual},
                {excluded.id: True, included.id: False, new_id: False},
            )
        self.assertEqual(self.recipe.items.get(id=excluded.id).quantity, 3)

    def test_editor_cannot_set_or_clear_cost_exclusion_in_aggregate(self):
        self.content(actor=self.owner)
        item = self.recipe.items.get()
        for stored, submitted in ((False, True), (True, False)):
            item.excluded_from_cost = stored
            item.save()
            with self.subTest(stored=stored, submitted=submitted):
                with self.assertRaisesRegex(ValueError, "Only the recipe owner"):
                    self.content(actor=self.editor, items=[{
                        "id": str(item.id), "kind": "ingredient",
                        "ingredientId": str(self.ingredient.id), "quantity": 2,
                        "unit": "g", "excludedFromCost": submitted,
                    }])
                item.refresh_from_db()
                self.assertEqual(item.excluded_from_cost, stored)
                self.assertEqual(item.quantity, 1)
        with self.assertRaisesRegex(ValueError, "Reload this recipe"):
            self.content(actor=self.editor)

    def test_new_editor_lines_cannot_be_excluded_in_existing_or_new_kitchen_recipe(self):
        KitchenMembership.objects.create(
            owner=self.owner, member=self.editor, role=RecipeShare.EDITOR,
        )
        for target in (
            {"id": str(self.recipe.id)},
            {"ownerId": str(self.owner.id)},
        ):
            with self.subTest(target=target):
                with self.assertRaisesRegex(ValueError, "Only the recipe owner"):
                    action_save_recipe(self.editor, {
                        **target, "title": "Must not survive", "items": [{
                            "id": str(uuid4()), "kind": "ingredient",
                            "ingredientId": str(self.ingredient.id), "quantity": 1,
                            "unit": "g", "excludedFromCost": True,
                        }],
                    })
        self.assertFalse(Recipe.objects.filter(title="Must not survive").exists())

    def test_owner_can_explicitly_clear_and_reenable_cost_exclusion(self):
        self.content(actor=self.owner)
        item = self.recipe.items.get()
        for value in (True, False, True):
            self.content(actor=self.owner, items=[{
                "id": str(item.id), "kind": "ingredient",
                "ingredientId": str(self.ingredient.id), "quantity": 1,
                "unit": "g", "excludedFromCost": value,
            }])
            item.refresh_from_db()
            self.assertEqual(item.excluded_from_cost, value)

    def test_aggregate_line_ids_are_unique_and_scoped_and_flags_are_boolean(self):
        self.content(actor=self.owner)
        item = self.recipe.items.get()
        other_recipe = Recipe.objects.create(user=self.owner, title="Other recipe")
        other = RecipeItem.objects.create(
            recipe=other_recipe, kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient, quantity=1, unit="g",
        )
        row = {"id": str(item.id), "kind": "ingredient",
               "ingredientId": str(self.ingredient.id), "quantity": 1, "unit": "g"}
        for actor in (self.owner, self.editor):
            for invalid in (
                [row, row],
                [{**row, "id": str(other.id)}],
                [{**row, "excludedFromCost": "false"}],
                [{**row, "excludedFromCost": 1}],
            ):
                with self.subTest(actor=actor.id, invalid=invalid):
                    with self.assertRaises(ValueError):
                        self.content(actor=actor, items=invalid)
        self.assertEqual(list(self.recipe.items.values_list("id", flat=True)), [item.id])

    def test_owner_updates_and_clears_commercial_costing_together(self):
        action_update_recipe_costing(
            self.owner,
            {
                "recipeId": str(self.recipe.id),
                "servingAmount": 1,
                "servingUnit": "each",
                "menuPriceCents": 200,
            },
        )
        self.recipe.refresh_from_db()
        self.assertEqual(self.recipe.serving_amount, Decimal("1"))
        self.assertEqual(self.recipe.serving_unit, "each")
        self.assertEqual(self.recipe.menu_price_cents, 200)

        action_update_recipe_costing(
            self.owner,
            {
                "recipeId": str(self.recipe.id),
                "servingAmount": None,
                "servingUnit": "",
                "menuPriceCents": None,
            },
        )
        self.recipe.refresh_from_db()
        self.assertIsNone(self.recipe.serving_amount)
        self.assertEqual(self.recipe.serving_unit, "")
        self.assertIsNone(self.recipe.menu_price_cents)

    def test_commercial_costing_is_owner_only_and_validates_the_pair(self):
        body = {
            "recipeId": str(self.recipe.id),
            "servingAmount": 1,
            "servingUnit": "each",
            "menuPriceCents": 200,
        }
        for actor in (self.editor, self.viewer):
            with self.assertRaisesMessage(ValueError, "Recipe not found"):
                action_update_recipe_costing(actor, body)
        foreign = User.objects.create_user(
            email="foreign-costing@example.com", name="Foreign", password="pass"
        )
        with self.assertRaisesMessage(ValueError, "Recipe not found"):
            action_update_recipe_costing(foreign, body)
        with self.assertRaisesMessage(ValueError, "supplied together"):
            action_update_recipe_costing(
                self.owner,
                {**body, "servingUnit": ""},
            )
        with self.assertRaisesMessage(ValueError, "weight, volume or count"):
            action_update_recipe_costing(
                self.owner,
                {**body, "servingUnit": "splash"},
            )
        with self.assertRaisesMessage(ValueError, "Menu price"):
            action_update_recipe_costing(
                self.owner,
                {**body, "menuPriceCents": 0},
            )

    def test_shelf_life_uses_time_units_and_requires_a_positive_pair(self):
        action_save_recipe(
            self.owner,
            {
                "id": str(self.recipe.id),
                "title": self.recipe.title,
                "shelfLifeAmount": 3,
                "shelfLifeUnit": "days",
            },
        )
        self.recipe.refresh_from_db()
        self.assertEqual(
            (self.recipe.shelf_life_amount, self.recipe.shelf_life_unit),
            (Decimal("3"), "days"),
        )
        with self.assertRaises(ValueError):
            action_save_recipe(
                self.owner,
                {
                    "id": str(self.recipe.id),
                    "title": self.recipe.title,
                    "shelfLifeAmount": 0,
                    "shelfLifeUnit": "days",
                },
            )

    def test_prep_time_takes_minutes_or_hours_and_requires_a_positive_pair(self):
        for amount, unit, stored in ((45, "minutes", Decimal("45")), (1.5, "hours", Decimal("1.5"))):
            action_save_recipe(
                self.owner,
                {
                    "id": str(self.recipe.id),
                    "title": self.recipe.title,
                    "prepTimeAmount": amount,
                    "prepTimeUnit": unit,
                },
            )
            self.recipe.refresh_from_db()
            self.assertEqual(
                (self.recipe.prep_time_amount, self.recipe.prep_time_unit),
                (stored, unit),
            )
        with self.assertRaises(ValueError):
            action_save_recipe(
                self.owner,
                {
                    "id": str(self.recipe.id),
                    "title": self.recipe.title,
                    "prepTimeUnit": "minutes",
                },
            )
        with self.assertRaises(ValueError):
            action_save_recipe(
                self.owner,
                {
                    "id": str(self.recipe.id),
                    "title": self.recipe.title,
                    "prepTimeAmount": 3,
                    "prepTimeUnit": "days",
                },
            )

    def test_yield_may_be_counted_in_slices_but_not_in_bunches(self):
        # A tart is "8 slice" the way a crust is "1 pcs": both count what one
        # batch cuts into, and the mirror is YIELD_UNIT_VALUES in
        # apps/web/lib/unit-registry.ts.
        for unit in ("slice", "pcs", "cup", "g"):
            action_save_recipe(
                self.owner,
                {
                    "id": str(self.recipe.id),
                    "title": self.recipe.title,
                    "yieldAmount": 8,
                    "yieldUnit": unit,
                },
            )
            self.recipe.refresh_from_db()
            self.assertEqual(self.recipe.yield_unit, unit)
        for unit in ("bunch", "each", "portion", "sliced"):
            with self.assertRaises(ValueError, msg=unit):
                action_save_recipe(
                    self.owner,
                    {
                        "id": str(self.recipe.id),
                        "title": self.recipe.title,
                        "yieldAmount": 8,
                        "yieldUnit": unit,
                    },
                )

    def test_a_slice_yield_counts_pieces_the_way_a_pcs_yield_does(self):
        tart = Recipe.objects.create(
            user=self.owner,
            title="Lemon tart",
            body="",
            yield_amount=8,
            yield_unit="slice",
        )
        model = RecipeHealthReadModel(self.owner)
        self.assertEqual(model._unit_divisor(tart), (8, "/slice"))
        crust = Recipe.objects.create(
            user=self.owner,
            title="Tart crust",
            body="",
            yield_amount=1,
            yield_unit="pcs",
        )
        self.assertEqual(model._unit_divisor(crust), (1, "/pc"))

    def test_a_volume_yield_is_costed_per_liter(self):
        glaze = Recipe.objects.create(
            user=self.owner,
            title="Citrus glaze",
            yield_amount=1500,
            yield_unit="ml",
        )
        self.assertEqual(
            RecipeHealthReadModel(self.owner)._unit_divisor(glaze),
            (1.5, "/L"),
        )

    def test_rejected_row_names_the_row_and_the_field(self):
        with self.assertRaises(ValidationError) as caught:
            self.content(
                actor=self.owner,
                items=[
                    {
                        "kind": "ingredient",
                        "ingredientId": str(self.ingredient.id),
                        "displayName": "Water",
                        "quantity": 1.3333333333333333,
                        "unit": "g",
                    }
                ],
            )
        self.assertTrue(
            caught.exception.messages[0].startswith("Water quantity: "),
            msg=f"Editor cannot fix an unnamed field: {caught.exception.messages[0]}",
        )

    def test_invalid_aggregate_does_not_delete_existing_items(self):
        self.content(actor=self.owner)
        with self.assertRaises(ValueError):
            self.content(actor=self.owner, items=[{"kind": "ingredient", "ingredientId": str(self.ingredient.id), "quantity": 1, "unit": "not-a-unit"}])
        self.assertEqual(RecipeItem.objects.filter(recipe=self.recipe).count(), 1)

    def test_saving_the_same_lines_again_replaces_them(self):
        # The second save writes rows at the positions the first save took.
        # Django's uniqueness check runs before the old rows go, so it must be
        # left out for rows that replace their predecessors.
        self.content(actor=self.owner)
        self.content(actor=self.owner)
        self.assertEqual(RecipeItem.objects.filter(recipe=self.recipe).count(), 1)

    def test_profile_and_content_save_roll_back_as_one_aggregate(self):
        self.content(actor=self.owner)
        with self.assertRaises(ValueError):
            action_save_recipe(
                self.owner,
                {
                    "id": str(self.recipe.id),
                    "title": "Should roll back",
                    "items": [
                        {
                            "kind": "ingredient",
                            "ingredientId": str(self.ingredient.id),
                            "quantity": 1,
                            "unit": "not-a-unit",
                        }
                    ],
                    "steps": [],
                },
            )
        self.recipe.refresh_from_db()
        self.assertEqual(self.recipe.title, "Sauce")
        self.assertEqual(RecipeItem.objects.filter(recipe=self.recipe).count(), 1)

    def test_direct_target_restricts_ingredient_deletion(self):
        action_save_recipe(
            self.owner,
            {
                "id": str(self.recipe.id),
                "title": "Sauce",
                "items": [
                    {
                        "kind": "ingredient",
                        "ingredientId": str(self.ingredient.id),
                        "quantity": 1,
                        "unit": "g",
                    }
                ],
            },
        )
        with self.assertRaises(RestrictedError):
            self.ingredient.delete()
        item = RecipeItem.objects.get(recipe=self.recipe)
        self.assertEqual(item.ingredient_id, self.ingredient.id)
        self.assertEqual(item.display_name, "Salt")

    def test_diamond_is_valid_but_cycle_is_rejected(self):
        left = Recipe.objects.create(user=self.owner, title="Left")
        right = Recipe.objects.create(user=self.owner, title="Right")
        bottom = Recipe.objects.create(user=self.owner, title="Bottom")
        RecipeItem.objects.create(recipe=left, kind="subrecipe", subrecipe=bottom, position=0).full_clean()
        RecipeItem.objects.create(recipe=right, kind="subrecipe", subrecipe=bottom, position=0).full_clean()
        RecipeItem.objects.create(recipe=self.recipe, kind="subrecipe", subrecipe=left, position=0).full_clean()
        RecipeItem.objects.create(recipe=self.recipe, kind="subrecipe", subrecipe=right, position=1).full_clean()
        RecipeItem.objects.create(recipe=bottom, kind="subrecipe", subrecipe=self.recipe, position=0)
        with self.assertRaises(ValidationError):
            RecipeItem(recipe=right, kind="subrecipe", subrecipe=self.recipe, position=1).full_clean()

    def test_media_share_and_tag_boundaries(self):
        with self.assertRaises(ValidationError):
            RecipeMedia(recipe=None, step=None, url="https://example.com/a", thumbnail_url="").clean()
        foreign_tag = RecipeTag.objects.create(user=self.editor, name="Private", normalized_name="private")
        with self.assertRaises(ValidationError):
            RecipeTagMembership(recipe=self.recipe, tag=foreign_tag).full_clean()
        with self.assertRaises(ValidationError):
            RecipeShare(recipe=self.recipe, recipient=self.owner).full_clean()

    def test_catalog_product_fallback_allergens(self):
        catalog = CatalogIngredient.objects.create(name="Milk")
        CatalogIngredientAllergen.objects.create(ingredient=catalog, allergen="milk", status="contains")
        # Product mapping is the fallback when the tenant row has no direct
        # catalog ingredient mapping.
        source = CatalogSource.objects.create(key="test")
        batch = CatalogImportBatch.objects.create(source=source, content_sha256="a" * 64, observed_at=self.recipe.created_at)
        product = CatalogProduct.objects.create(source=source, import_batch=batch, ingredient=catalog, external_id="milk", normalized_external_id="milk", title="Milk", normalized_title="milk", raw_size="1kg", pack_price_cents=100, observed_at=self.recipe.created_at)
        ingredient = Ingredient.objects.create(user=self.owner, name="Mapped milk", catalog_product=product, purchase_cost_cents=100, purchase_size=1, purchase_unit="kg")
        RecipeItem.objects.create(recipe=self.recipe, kind="ingredient", ingredient=ingredient, quantity=Decimal("1"), unit="kg", position=0)
        self.assertEqual(recipe_allergens(self.recipe), {"milk"})

    def test_shared_health_has_no_cost_fields(self):
        request = RequestFactory().get("/")
        request.user = self.viewer
        payload = json.loads(recipe_health(request).content)
        row = next(item for item in payload["items"] if item["id"] == str(self.recipe.id))
        self.assertIsNone(row["menuPriceCents"])
        self.assertIsNone(row["ingredientCents"])
        self.assertIsNone(row["foodCost"])
        self.assertEqual(row["permission"], "viewer")
        self.assertEqual(row["ownerName"], self.owner.name)
        self.assertFalse(row["canViewCost"])

    def test_owner_detail_includes_normalized_cost_snapshot(self):
        self.recipe.yield_amount = 1
        self.recipe.yield_unit = "pcs"
        self.recipe.serving_amount = 1
        self.recipe.serving_unit = "each"
        self.recipe.save(
            update_fields=[
                "yield_amount",
                "yield_unit",
                "serving_amount",
                "serving_unit",
            ]
        )
        self.content(actor=self.owner)
        request = RequestFactory().get("/")
        request.user = self.owner
        payload = json.loads(
            recipe_detail(request, self.recipe.public_id).content
        )["item"]
        self.assertEqual(payload["ingredientCostCents"], 0.1)
        self.assertEqual(payload["ingredientOptions"][0]["name"], "Salt")

    def test_owner_detail_leaves_supplies_out_of_the_ingredient_options(self):
        Ingredient.objects.create(
            user=self.owner,
            name="Takeout boxes",
            non_edible=True,
            purchase_cost_cents=100,
            purchase_size=1,
            purchase_unit="each",
        )

        request = RequestFactory().get("/")
        request.user = self.owner
        payload = json.loads(
            recipe_detail(request, self.recipe.public_id).content
        )["item"]

        # A recipe can never contain a supply, so the picker never sees one.
        self.assertEqual(
            [row["name"] for row in payload["ingredientOptions"]], ["Salt"]
        )

    def test_contains_facets_and_filter_treat_recipes_as_item_targets(self):
        child = Recipe.objects.create(user=self.owner, title="Dressing")
        RecipeItem.objects.create(
            recipe=self.recipe,
            kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient,
            display_name="Salt",
            quantity=1,
            unit="g",
            position=0,
        )
        RecipeItem.objects.create(
            recipe=self.recipe,
            kind=RecipeItem.SUBRECIPE,
            subrecipe=child,
            display_name="Dressing",
            quantity=1,
            unit="each",
            position=1,
        )
        request = RequestFactory().get(
            "/", {"ingredients": str(child.id), "status": "active"}
        )
        request.user = self.owner
        payload = json.loads(recipes(request).content)
        self.assertEqual([item["id"] for item in payload["items"]], [str(self.recipe.id)])
        self.assertIn(
            f"Recipe · {child.title}",
            {facet["name"] for facet in payload["facets"]["ingredients"]},
        )

    def test_shared_recipe_search_uses_the_owners_category(self):
        category = RecipeCategory.objects.create(
            user=self.owner, name="Dressings", normalized_name="dressings"
        )
        self.recipe.category = category
        self.recipe.save(update_fields=["category"])
        request = RequestFactory().get("/", {"q": "dressings"})
        request.user = self.editor
        payload = json.loads(recipes(request).content)
        self.assertEqual(
            [item["id"] for item in payload["items"]], [str(self.recipe.id)]
        )

    def test_permission_payload_is_actual_role(self):
        shared = recipe_json(self.recipe, viewer_user=self.editor)
        self.assertEqual(shared["permission"], "editor")
        self.assertTrue(shared["canEdit"])
        self.assertFalse(shared["canViewCost"])
        self.assertEqual(shared["shares"], [])
        self.assertEqual(
            shared["ingredientOptions"],
            [{"id": str(self.ingredient.id), "name": "Salt"}],
        )
        read_only = recipe_json(self.recipe, viewer_user=self.viewer)
        self.assertEqual(read_only["ingredientOptions"], [])
        self.assertEqual(read_only["recipeOptions"], [])

    def test_normalized_cost_uses_fk_conversion_and_preparation(self):
        IngredientMeasure.objects.create(
            ingredient=self.ingredient,
            unit="cup",
            amount=Decimal("1"),
            grams=Decimal("240"),
        )
        Preparation.objects.create(
            user=self.owner,
            ingredient=self.ingredient,
            name="Chopped",
            normalized_name="chopped",
            yield_percent=Decimal("50"),
        )
        recipe = Recipe.objects.create(
            user=self.owner,
            title="Converted",
            yield_amount=1,
            yield_unit="kg",
            serving_amount=1,
            serving_unit="kg",
        )
        RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient,
            display_name="A duplicate display name",
            quantity=1,
            unit="cup",
            position=0,
        )
        RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient,
            display_name="Chopped duplicate display name",
            preparation_note="Chopped",
            quantity=100,
            unit="g",
            position=1,
        )
        model = RecipeHealthReadModel(self.owner)
        total, issues, _ = model._normalized_cost(recipe)
        self.assertEqual(issues, [])
        # 1 cup = 240 g, plus 100 g at 50% yield = 200 g bought, at
        # 100 cents/kg: 24 + 20 cents. Both rows resolve through the FK.
        self.assertAlmostEqual(total, 44.0)

        health = model._normalized_row(recipe)
        # A 1 kg yield is one metric pricing unit, not 1,000 raw grams.
        self.assertAlmostEqual(health["ingredientCents"], 44.0)
        self.assertEqual(health["suffix"], "/1 kg")

    def test_stray_display_name_flags_the_health_row(self):
        recipe = Recipe.objects.create(
            user=self.owner,
            title="Flagged",
            yield_amount=1,
            yield_unit="kg",
            serving_amount=1,
            serving_unit="kg",
        )
        RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient,
            display_name="Granulated salt",
            quantity=100,
            unit="g",
            position=0,
        )
        # The written name reads more than the link, so the editor shows amber
        # on the line; the list row must say the same.
        health = RecipeHealthReadModel(self.owner)._normalized_row(recipe)
        self.assertIn("stray words", health["issues"])

        # A name that is the link, however it is cased or spaced, is whole.
        RecipeItem.objects.filter(recipe=recipe).update(display_name="  SALT ")
        health = RecipeHealthReadModel(self.owner)._normalized_row(recipe)
        self.assertNotIn("stray words", health["issues"])

        # An unlinked line is "unresolved item", never stray words too.
        RecipeItem.objects.filter(recipe=recipe).update(
            ingredient=None, display_name="Lovage"
        )
        health = RecipeHealthReadModel(self.owner)._normalized_row(recipe)
        self.assertIn("unresolved item", health["issues"])
        self.assertNotIn("stray words", health["issues"])

    def test_commercial_health_uses_the_saved_portion_measure_matrix(self):
        def costed_recipe(title, **values):
            recipe = Recipe.objects.create(user=self.owner, title=title, **values)
            RecipeItem.objects.create(
                recipe=recipe,
                kind=RecipeItem.INGREDIENT,
                ingredient=self.ingredient,
                display_name="Salt",
                quantity=1,
                unit="kg",
                position=0,
            )
            return recipe

        counted = costed_recipe(
            "Counted",
            yield_amount=24,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )
        counted_by_weight = costed_recipe(
            "Counted by weight",
            yield_amount=31,
            yield_unit="pcs",
            serving_amount=12,
            serving_unit="g",
        )
        counted_by_weight_with_equivalency = costed_recipe(
            "Counted by weight with equivalency",
            yield_amount=31,
            yield_unit="pcs",
            serving_amount=10,
            serving_unit="g",
        )
        RecipeEquivalency.objects.create(
            recipe=counted_by_weight_with_equivalency,
            mass_amount=400,
            mass_unit="g",
            standard=False,
        )
        volume = costed_recipe(
            "Volume",
            yield_amount=1,
            yield_unit="l",
            serving_amount=250,
            serving_unit="ml",
        )
        related = costed_recipe(
            "Related",
            yield_amount=600,
            yield_unit="g",
            serving_amount=1,
            serving_unit="each",
        )
        RecipeEquivalency.objects.create(
            recipe=related,
            count_amount=24,
            count_unit="each",
            standard=False,
        )
        unresolved = costed_recipe(
            "Unresolved",
            yield_amount=600,
            yield_unit="g",
            serving_amount=1,
            serving_unit="each",
        )
        missing = costed_recipe(
            "Missing",
            yield_amount=24,
            yield_unit="pcs",
        )

        model = RecipeHealthReadModel(self.owner)
        counted_row = model._normalized_row(counted)
        counted_by_weight_row = model._normalized_row(counted_by_weight)
        counted_by_weight_with_equivalency_row = model._normalized_row(
            counted_by_weight_with_equivalency
        )
        volume_row = model._normalized_row(volume)
        related_row = model._normalized_row(related)
        unresolved_row = model._normalized_row(unresolved)
        missing_row = model._normalized_row(missing)

        self.assertAlmostEqual(counted_row["ingredientCents"], 100 / 24)
        self.assertEqual(counted_row["suffix"], "/1 each")
        self.assertIsNone(counted_by_weight_row["ingredientCents"])
        self.assertIn(
            "portion needs equivalency", counted_by_weight_row["issues"]
        )
        self.assertAlmostEqual(
            counted_by_weight_with_equivalency_row["ingredientCents"], 100 / 40
        )
        self.assertAlmostEqual(volume_row["ingredientCents"], 25)
        self.assertAlmostEqual(related_row["ingredientCents"], 100 / 24)
        self.assertIsNone(unresolved_row["ingredientCents"])
        self.assertIn("portion needs equivalency", unresolved_row["issues"])
        self.assertIsNone(missing_row["ingredientCents"])
        self.assertIn("no portion", missing_row["issues"])

    def test_normalized_subrecipe_cost_uses_its_uom_equivalency(self):
        glaze = Recipe.objects.create(
            user=self.owner,
            title="Citrus glaze",
            yield_amount=1000,
            yield_unit="ml",
        )
        RecipeItem.objects.create(
            recipe=glaze,
            kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient,
            display_name="Salt",
            quantity=1000,
            unit="g",
            position=0,
        )
        plate = Recipe.objects.create(
            user=self.owner,
            title="Glazed plate",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )
        RecipeItem.objects.create(
            recipe=plate,
            kind=RecipeItem.SUBRECIPE,
            subrecipe=glaze,
            display_name="Citrus glaze",
            quantity=250,
            unit="g",
            position=0,
        )

        without_weight = RecipeHealthReadModel(self.owner)._normalized_row(plate)
        self.assertEqual(without_weight["ingredientCents"], 0)
        self.assertIn("unpriced subrecipe", without_weight["issues"])

        RecipeEquivalency.objects.create(
            recipe=glaze,
            mass_amount=500,
            mass_unit="g",
            standard=False,
        )
        with_weight = RecipeHealthReadModel(self.owner)._normalized_row(plate)
        # The glaze costs 100 cents per batch; 250 g is half its 500 g batch.
        self.assertAlmostEqual(with_weight["ingredientCents"], 50)
        self.assertNotIn("unpriced subrecipe", with_weight["issues"])

    def test_an_excluded_line_costs_nothing_and_reports_no_issue(self):
        recipe = Recipe.objects.create(
            user=self.owner, title="Excluding", yield_amount=1, yield_unit="kg"
        )
        RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient,
            display_name="Salt",
            quantity=100,
            unit="g",
            position=0,
        )
        model = RecipeHealthReadModel(self.owner)
        before, _, _ = model._normalized_cost(recipe)
        RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient,
            display_name="Salt for the pot",
            quantity=500,
            unit="g",
            position=1,
            excluded_from_cost=True,
        )
        after, issues, _ = RecipeHealthReadModel(self.owner)._normalized_cost(recipe)
        self.assertEqual(issues, [])
        self.assertAlmostEqual(after, before)

    def test_an_excluded_line_without_a_quantity_is_not_an_issue(self):
        recipe = Recipe.objects.create(
            user=self.owner, title="Brushing", yield_amount=1, yield_unit="kg"
        )
        RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient,
            display_name="Salt to taste",
            quantity=None,
            unit="",
            position=0,
            excluded_from_cost=True,
        )
        _, issues, _ = RecipeHealthReadModel(self.owner)._normalized_cost(recipe)
        self.assertEqual(issues, [])

    def test_normalized_subrecipe_uses_declared_yield_units_and_cycle_guard(self):
        child = Recipe.objects.create(
            user=self.owner, title="Child", yield_amount=10, yield_unit="pcs"
        )
        RecipeItem.objects.create(
            recipe=child,
            kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient,
            quantity=1,
            unit="kg",
            position=0,
        )
        parent = Recipe.objects.create(
            user=self.owner, title="Parent", yield_amount=1, yield_unit="pcs"
        )
        RecipeItem.objects.create(
            recipe=parent,
            kind=RecipeItem.SUBRECIPE,
            subrecipe=child,
            quantity=2,
            unit="pcs",
            position=0,
        )
        model = RecipeHealthReadModel(self.owner)
        with self.assertNumQueries(
            2,
            msg="Normalized subrecipe costing loads the owner graph and its items once, not once per nested recipe",
        ):
            total, issues, _ = model._normalized_cost(parent)
        self.assertEqual(issues, [])
        # The child costs 100 cents per 10-piece batch, so two pieces cost 20.
        self.assertAlmostEqual(total, 20.0)
        cycle = RecipeItem(
            recipe=child,
            kind=RecipeItem.SUBRECIPE,
            subrecipe=parent,
            quantity=1,
            unit="pcs",
            position=1,
        )
        with self.assertRaises(ValidationError):
            cycle.full_clean()

    def test_recipe_detail_rolls_nested_subrecipe_costs_into_parent_lines(self):
        vinaigrette = Recipe.objects.create(
            user=self.owner,
            title="Charred Shallot-Dijon Vinaigrette",
            yield_amount=1000,
            yield_unit="g",
        )
        RecipeItem.objects.create(
            recipe=vinaigrette,
            kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient,
            display_name="Salt",
            quantity=1000,
            unit="g",
            position=0,
        )
        salad = Recipe.objects.create(
            user=self.owner,
            title="Little Gem & Tender Herb Salad",
            yield_amount=10,
            yield_unit="pcs",
        )
        RecipeItem.objects.create(
            recipe=salad,
            kind=RecipeItem.SUBRECIPE,
            subrecipe=vinaigrette,
            display_name=vinaigrette.title,
            quantity=250,
            unit="g",
            position=0,
        )
        steak = Recipe.objects.create(
            user=self.owner,
            title="Cast-Iron Hanger Steak with Little Gem Salad",
            yield_amount=10,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )
        RecipeItem.objects.create(
            recipe=steak,
            kind=RecipeItem.SUBRECIPE,
            subrecipe=salad,
            display_name=salad.title,
            quantity=2,
            unit="pcs",
            position=0,
        )
        RecipeItem.objects.create(
            recipe=steak,
            kind=RecipeItem.SUBRECIPE,
            subrecipe=vinaigrette,
            display_name=vinaigrette.title,
            quantity=100,
            unit="g",
            position=1,
        )

        request = RequestFactory().get("/")
        request.user = self.owner
        payload = json.loads(recipe_detail(request, steak.public_id).content)[
            "item"
        ]

        # The vinaigrette batch costs 100 cents. The salad consumes 25 cents
        # and yields ten pieces, so two salad pieces cost 5 cents; the direct
        # 100 g vinaigrette line contributes another 10 cents.
        self.assertEqual(
            [item["costCents"] for item in payload["items"]], [5.0, 10.0]
        )
        self.assertAlmostEqual(payload["ingredientCostCents"], 1.5)

        RecipeShare.objects.create(
            recipe=steak, recipient=self.viewer, role=RecipeShare.VIEWER
        )
        request.user = self.viewer
        shared = json.loads(recipe_detail(request, steak.public_id).content)["item"]
        self.assertEqual(
            [item["costCents"] for item in shared["items"]], [None, None]
        )


class EffectiveRecipeShareTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(
            email="share-owner@example.com", name="Owner", password="pass"
        )
        self.recipient = User.objects.create_user(
            email="share-recipient@example.com", name="Recipient", password="pass"
        )
        self.recipe = Recipe.objects.create(user=self.owner, title="Shared sauce")
        self.share = RecipeShare.objects.create(
            recipe=self.recipe,
            recipient=self.recipient,
            role=RecipeShare.EDITOR,
        )

    def request(self, query=None):
        request = RequestFactory().get("/", query or {})
        request.user = self.recipient
        return request

    def test_unverified_share_is_dormant_across_reads_and_writes(self):
        detail = json.loads(
            recipe_detail(self.request(), self.recipe.public_id).content
        )
        browse = json.loads(recipes(self.request({"q": "Shared sauce"})).content)
        nutrition = json.loads(
            recipe_nutrition(self.request(), self.recipe.public_id).content
        )

        self.assertIsNone(detail["item"])
        self.assertEqual(browse["items"], [])
        self.assertIsNone(nutrition["item"])
        with self.assertRaisesRegex(ValueError, "not editable"):
            action_save_recipe(
                self.recipient,
                {"id": str(self.recipe.id), "title": "Claimed sauce"},
            )
        with self.assertRaisesRegex(ValueError, "Recipe not found"):
            action_save_recipe_comment(
                self.recipient,
                {"recipeId": str(self.recipe.id), "body": "Hidden edit"},
            )

    def test_verification_reactivates_the_same_share_and_role_changes_apply(self):
        self.recipient.email_verified_at = timezone.now()
        self.recipient.save(update_fields=["email_verified_at"])

        detail = json.loads(
            recipe_detail(self.request(), self.recipe.public_id).content
        )["item"]
        self.assertEqual(detail["permission"], "editor")
        self.assertEqual(RecipeShare.objects.get().id, self.share.id)

        comment_id = action_save_recipe_comment(
            self.recipient,
            {"recipeId": str(self.recipe.id), "body": "Useful note"},
        )["id"]
        self.share.role = RecipeShare.VIEWER
        self.share.save(update_fields=["role", "updated_at"])
        with self.assertRaisesRegex(ValueError, "not editable"):
            action_save_recipe(
                self.recipient,
                {"id": str(self.recipe.id), "title": "Viewer edit"},
            )

        self.share.role = RecipeShare.EDITOR
        self.share.save(update_fields=["role", "updated_at"])
        self.share.delete()
        with self.assertRaisesRegex(ValueError, "Comment not found"):
            action_delete_recipe_comment(self.recipient, {"id": comment_id})


class RecipeLineMatchOwnershipTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(
            email="match-owner@example.com", name="Owner", password="pass"
        )
        self.editor = User.objects.create_user(
            email="match-editor@example.com",
            name="Editor",
            password="pass",
            email_verified_at=timezone.now(),
        )
        self.component = Recipe.objects.create(
            user=self.owner,
            title="Pastry cream",
            kind=Recipe.KIND_COMPONENT,
        )
        self.share = RecipeShare.objects.create(
            recipe=self.component,
            recipient=self.editor,
            role=RecipeShare.EDITOR,
        )

    def test_editor_rename_writes_an_owner_alias_that_survives_revocation(self):
        parent = Recipe.objects.create(user=self.owner, title="Tart")
        parent_line = RecipeItem.objects.create(
            recipe=parent,
            kind=RecipeItem.SUBRECIPE,
            subrecipe=self.component,
            display_name="Pastry cream",
            position=0,
        )

        action_save_recipe(
            self.editor,
            {
                "id": str(self.component.id),
                "title": "Vanilla cream",
                "expectedEditVersion": self.component.edit_version,
            },
        )

        match = RecipeLineMatch.objects.get(normalized_text="pastry cream")
        self.assertEqual(match.user_id, self.owner.id)
        self.assertEqual(match.component_recipe_id, self.component.id)
        self.assertEqual(
            saved_line_matches(self.owner),
            [("pastry cream", str(self.component.id), "recipe")],
        )
        parent_line.refresh_from_db()
        parent.refresh_from_db()
        self.assertEqual(parent_line.display_name, "Vanilla cream")
        self.assertEqual(parent.edit_version, 1)

        self.share.delete()
        request = RequestFactory().get("/")
        request.user = self.editor
        self.assertEqual(json.loads(ingredient_matches(request).content)["items"], [])
        self.assertTrue(RecipeLineMatch.objects.filter(id=match.id).exists())

    @mock.patch(
        "forkluck.domains.recipes.actions.save_line_match",
        side_effect=ValueError("alias failed"),
    )
    def test_alias_failure_rolls_back_title_and_edit_version(self, _save_match):
        original_version = self.component.edit_version

        with self.assertRaisesRegex(ValueError, "alias failed"):
            action_save_recipe(
                self.editor,
                {
                    "id": str(self.component.id),
                    "title": "Vanilla cream",
                    "expectedEditVersion": original_version,
                },
            )

        self.component.refresh_from_db()
        self.assertEqual(self.component.title, "Pastry cream")
        self.assertEqual(self.component.edit_version, original_version)
        self.assertFalse(RecipeLineMatch.objects.exists())

    def test_foreign_targets_are_rejected_and_hidden_from_both_read_paths(self):
        RecipeLineMatch.objects.create(
            user=self.editor,
            text="stolen cream",
            component_recipe=self.component,
        )

        with self.assertRaisesRegex(ValueError, "Match target not found"):
            save_line_match(
                user=self.editor,
                line="another stolen cream",
                component_recipe=self.component,
            )
        self.assertEqual(saved_line_matches(self.editor), [])
        request = RequestFactory().get("/")
        request.user = self.editor
        self.assertEqual(json.loads(ingredient_matches(request).content)["items"], [])


class SubrecipeItemPayloadTests(TestCase):
    """A sub-recipe line carries the linked recipe one level deep."""

    def setUp(self):
        self.owner = User.objects.create_user(
            email="owner-subrecipe@example.com", name="Owner", password="pass"
        )
        self.ingredient = Ingredient.objects.create(
            user=self.owner,
            name="Sugar",
            purchase_cost_cents=100,
            purchase_size=1,
            purchase_unit="kg",
        )
        self.grandchild = Recipe.objects.create(
            user=self.owner, title="Syrup", yield_amount=1, yield_unit="l"
        )
        self.child = Recipe.objects.create(
            user=self.owner, title="Lemon curd", yield_amount=2, yield_unit="cup"
        )
        RecipeItem.objects.create(
            recipe=self.child,
            kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient,
            display_name="Sugar",
            preparation_note="sifted",
            quantity=2,
            unit="cup",
            position=0,
        )
        RecipeItem.objects.create(
            recipe=self.child,
            kind=RecipeItem.SUBRECIPE,
            subrecipe=self.grandchild,
            display_name="Syrup",
            quantity=1,
            unit="l",
            position=1,
        )
        self.parent = Recipe.objects.create(
            user=self.owner, title="Tart", yield_amount=1, yield_unit="pcs"
        )
        RecipeItem.objects.create(
            recipe=self.parent,
            kind=RecipeItem.SUBRECIPE,
            subrecipe=self.child,
            display_name="Lemon curd",
            quantity=1,
            unit="cup",
            position=0,
        )

    def detail(self, recipe):
        request = RequestFactory().get("/")
        request.user = self.owner
        return json.loads(recipe_detail(request, recipe.public_id).content)["item"]

    def test_subrecipe_line_carries_the_linked_recipe_one_level_deep(self):
        item = self.detail(self.parent)["items"][0]
        # The flat keys the editor already saves against are untouched.
        self.assertEqual(item["subrecipeId"], str(self.child.id))
        self.assertEqual(item["subrecipeName"], "Lemon curd")
        nested = item["subrecipe"]
        self.assertEqual(nested["id"], str(self.child.id))
        self.assertEqual(nested["publicId"], self.child.public_id)
        self.assertEqual(nested["title"], "Lemon curd")
        self.assertEqual(nested["yieldAmount"], 2)
        self.assertEqual(nested["yieldUnit"], "cup")
        self.assertEqual(
            nested["items"],
            [
                {
                    "kind": "ingredient",
                    "quantity": 2.0,
                    "unit": "cup",
                    "displayName": "Sugar",
                    "preparationNote": "sifted",
                    "subrecipeId": None,
                    "excludedFromCost": False,
                },
                {
                    "kind": "subrecipe",
                    "quantity": 1.0,
                    "unit": "l",
                    "displayName": "Syrup",
                    "preparationNote": "",
                    "subrecipeId": str(self.grandchild.id),
                    "excludedFromCost": False,
                },
            ],
        )

    def test_an_ingredient_line_has_no_nested_recipe(self):
        item = self.detail(self.child)["items"][0]
        self.assertIsNone(item["subrecipe"])

    def test_more_subrecipe_lines_do_not_cost_more_queries(self):
        with CaptureQueriesContext(connection) as one_line:
            self.detail(self.parent)
        for position, title in ((1, "Dough"), (2, "Glaze")):
            extra = Recipe.objects.create(
                user=self.owner, title=title, yield_amount=1, yield_unit="pcs"
            )
            RecipeItem.objects.create(
                recipe=extra,
                kind=RecipeItem.INGREDIENT,
                ingredient=self.ingredient,
                display_name="Sugar",
                quantity=1,
                unit="cup",
                position=0,
            )
            RecipeItem.objects.create(
                recipe=self.parent,
                kind=RecipeItem.SUBRECIPE,
                subrecipe=extra,
                display_name=title,
                quantity=1,
                unit="pcs",
                position=position,
            )
        with self.assertNumQueries(
            len(one_line),
            msg="Nested sub-recipe lines are prefetched, not fetched one recipe at a time",
        ):
            payload = self.detail(self.parent)
        self.assertEqual(
            [item["subrecipe"]["title"] for item in payload["items"]],
            ["Lemon curd", "Dough", "Glaze"],
        )


class RecipeUsedInTests(TestCase):
    """The parents that link a recipe, as its detail payload lists them."""

    def setUp(self):
        self.owner = User.objects.create_user(
            email="owner-usedin@example.com", name="Owner", password="pass"
        )
        self.child = Recipe.objects.create(
            user=self.owner, title="Pastry cream", yield_amount=1, yield_unit="l"
        )

    def used_in(self, user=None):
        request = RequestFactory().get("/")
        request.user = user or self.owner
        payload = json.loads(recipe_detail(request, self.child.public_id).content)
        return payload["item"]["usedIn"]

    def link(self, parent, position, quantity, unit):
        RecipeItem.objects.create(
            recipe=parent,
            kind=RecipeItem.SUBRECIPE,
            subrecipe=self.child,
            display_name=self.child.title,
            quantity=quantity,
            unit=unit,
            position=position,
        )

    def test_two_lines_in_the_same_unit_sum_into_one_entry(self):
        parent = Recipe.objects.create(user=self.owner, title="Eclair")
        self.link(parent, 0, 2, "cup")
        self.link(parent, 1, 3, "cup")
        self.assertEqual(
            self.used_in(),
            [
                {
                    "id": str(parent.id),
                    "publicId": parent.public_id,
                    "title": "Eclair",
                    "status": "active",
                    "quantity": 5.0,
                    "unit": "cup",
                }
            ],
        )

    def test_mixed_units_report_the_first_line_rather_than_a_total(self):
        parent = Recipe.objects.create(user=self.owner, title="Eclair")
        self.link(parent, 0, 2, "cup")
        self.link(parent, 1, 300, "g")
        entry = self.used_in()[0]
        self.assertEqual((entry["quantity"], entry["unit"]), (2.0, "cup"))

    def test_archived_parents_sort_after_active_ones(self):
        archived = Recipe.objects.create(
            user=self.owner, title="Alfajor", status=Recipe.STATUS_ARCHIVED
        )
        active = Recipe.objects.create(user=self.owner, title="Zeppole")
        self.link(archived, 0, 1, "l")
        self.link(active, 0, 1, "l")
        self.assertEqual(
            [(entry["title"], entry["status"]) for entry in self.used_in()],
            [("Zeppole", "active"), ("Alfajor", "archived")],
        )

    def test_another_tenants_line_is_not_listed(self):
        other = User.objects.create_user(
            email="other-usedin@example.com", name="Other", password="pass"
        )
        stranger = Recipe.objects.create(user=other, title="Not yours")
        RecipeItem.objects.create(
            recipe=stranger,
            kind=RecipeItem.SUBRECIPE,
            subrecipe=self.child,
            display_name="Pastry cream",
            quantity=1,
            unit="l",
            position=0,
        )
        self.assertEqual(self.used_in(), [])

    def test_collaborator_only_sees_parents_they_can_open(self):
        collaborator = User.objects.create_user(
            email="collaborator-usedin@example.com",
            name="Collaborator",
            password="pass",
            email_verified_at=timezone.now(),
        )
        visible = Recipe.objects.create(user=self.owner, title="Shared eclair")
        private = Recipe.objects.create(user=self.owner, title="Private tart")
        archived = Recipe.objects.create(
            user=self.owner,
            title="Archived tart",
            status=Recipe.STATUS_ARCHIVED,
        )
        for position, parent in enumerate((visible, private, archived)):
            self.link(parent, position, 1, "cup")
        RecipeShare.objects.create(
            recipe=self.child,
            recipient=collaborator,
            role=RecipeShare.VIEWER,
        )
        parent_share = RecipeShare.objects.create(
            recipe=visible,
            recipient=collaborator,
            role=RecipeShare.VIEWER,
        )

        self.assertEqual(
            [entry["id"] for entry in self.used_in(collaborator)],
            [str(visible.id)],
        )
        self.assertEqual(
            [
                entry["id"]
                for entry in recipe_used_in_json(
                    self.child, viewer_user=collaborator
                )
            ],
            [str(visible.id)],
        )
        private_request = RequestFactory().get("/")
        private_request.user = collaborator
        self.assertIsNone(
            json.loads(recipe_detail(private_request, private.public_id).content)[
                "item"
            ]
        )

        parent_share.role = RecipeShare.EDITOR
        parent_share.save(update_fields=["role", "updated_at"])
        self.assertEqual(
            [entry["id"] for entry in self.used_in(collaborator)],
            [str(visible.id)],
        )
