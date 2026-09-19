"""Duplicate: a second recipe that matches its source in everything but name."""

from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from .domains.recipes.actions import action_duplicate_recipe
from .domains.recipes.serializers import recipe_json
from .models import (
    ActivityEvent,
    Ingredient,
    Recipe,
    RecipeBatchSize,
    RecipeComment,
    RecipeEquivalency,
    RecipeExternalRef,
    RecipeItem,
    RecipeMedia,
    RecipeShare,
    RecipeStep,
    RecipeTag,
    RecipeTagMembership,
    RecipeTiming,
    User,
)

# What a copy owns for itself, or a nested row does: everything else has to
# read back the same as the source.
IDENTITY_KEYS = {
    "id",
    "publicId",
    "code",
    "title",
    "editVersion",
    "createdAt",
    "updatedAt",
    "recipeId",
    "stepId",
}


def content(payload):
    if isinstance(payload, dict):
        return {
            key: content(value)
            for key, value in payload.items()
            if key not in IDENTITY_KEYS
        }
    if isinstance(payload, list):
        return [content(value) for value in payload]
    return payload


class DuplicateRecipeTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user(
            email="owner-duplicate@example.com", name="Owner", password="pass"
        )
        cls.editor = User.objects.create_user(
            email="editor-duplicate@example.com",
            name="Editor",
            password="pass",
            email_verified_at=timezone.now(),
        )
        cls.flour = Ingredient.objects.create(
            user=cls.owner,
            name="Flour",
            purchase_cost_cents=200,
            purchase_size=1,
            purchase_unit="kg",
        )
        cls.starter = Recipe.objects.create(
            user=cls.owner, title="Starter", kind=Recipe.KIND_COMPONENT
        )
        # A component, archived, with every kind of child row a recipe holds.
        cls.source = Recipe.objects.create(
            user=cls.owner,
            title="Levain",
            code="RCP-0007",
            kind=Recipe.KIND_COMPONENT,
            status=Recipe.STATUS_ARCHIVED,
            body="legacy ingredients",
            method="legacy method",
            description="Overnight",
            yield_amount=2.0,
            yield_unit="kg",
            menu_price_cents=1200,
            serving_amount=Decimal("250"),
            serving_unit="g",
            nutrition_serving_amount=Decimal("50"),
            nutrition_serving_unit="g",
            nutrition_package_amount=Decimal("500"),
            nutrition_package_unit="g",
            shelf_life_amount=Decimal("3"),
            shelf_life_unit="days",
            prep_time_amount=Decimal("30"),
            prep_time_unit="minutes",
            auto_sum_yield_enabled=True,
            auto_prep_time_enabled=True,
            percentage_mode="flour",
            percent_ingredient_enabled=True,
            percent_ingredient_type="flour",
        )
        RecipeItem.objects.create(
            recipe=cls.source, kind=RecipeItem.HEADER, position=0, display_name="Dough"
        )
        RecipeItem.objects.create(
            recipe=cls.source,
            kind=RecipeItem.INGREDIENT,
            position=1,
            display_name="Flour",
            quantity=Decimal("1000"),
            unit="g",
            preparation_note="sifted",
            efficiency=Decimal("95"),
            efficiency_after_cooking=Decimal("90"),
            is_base=True,
            excluded_from_cost=True,
            ingredient=cls.flour,
        )
        RecipeItem.objects.create(
            recipe=cls.source,
            kind=RecipeItem.SUBRECIPE,
            position=2,
            display_name="Starter",
            quantity=Decimal("200"),
            unit="g",
            subrecipe=cls.starter,
        )
        RecipeItem.objects.create(
            recipe=cls.source, kind=RecipeItem.NOTE, position=3, display_name="Cold"
        )
        header = RecipeStep.objects.create(
            recipe=cls.source, kind=RecipeStep.HEADER, position=0, title="Mix"
        )
        RecipeMedia.objects.create(
            step=header, url="https://example.com/mix.jpg", alt_text="Mixing"
        )
        step = RecipeStep.objects.create(
            recipe=cls.source,
            kind=RecipeStep.INSTRUCTION,
            position=1,
            title="Fold",
            body="Fold every hour",
            labor_kind="active",
        )
        RecipeTiming.objects.create(step=step, seconds=600, yield_count=2)
        RecipeStep.objects.create(
            recipe=cls.source, kind=RecipeStep.NOTE, position=2, body="Keep warm"
        )
        RecipeBatchSize.objects.create(
            recipe=cls.source, label="Original", scale=1, is_original=True
        )
        RecipeBatchSize.objects.create(recipe=cls.source, label="Double", scale=2)
        RecipeEquivalency.objects.create(
            recipe=cls.source,
            mass_amount=1000,
            mass_unit="g",
            volume_amount=None,
            volume_unit="",
            count_amount=1,
            count_unit="pcs",
            standard=False,
        )
        tag = RecipeTag.objects.create(
            user=cls.owner, name="Bread", normalized_name="bread"
        )
        RecipeTagMembership.objects.create(recipe=cls.source, tag=tag)
        RecipeMedia.objects.create(
            recipe=cls.source, url="https://example.com/levain.jpg", position=1
        )
        # What ties the original to other people and systems.
        RecipeShare.objects.create(
            recipe=cls.source, recipient=cls.editor, role=RecipeShare.EDITOR
        )
        RecipeComment.objects.create(
            recipe=cls.source, author=cls.owner, body="Feed it first"
        )
        RecipeExternalRef.objects.create(
            user=cls.owner,
            recipe=cls.source,
            system=RecipeExternalRef.SYSTEM_SQUARE,
            ref_kind=RecipeExternalRef.KIND_ITEM,
            external_id="levain",
        )

    def duplicate(self, recipe: Recipe) -> Recipe:
        saved = action_duplicate_recipe(self.owner, {"id": str(recipe.id)})
        copy = Recipe.objects.get(id=saved["id"])
        self.assertEqual(
            saved,
            {
                "id": str(copy.id),
                "publicId": copy.public_id,
                "code": copy.code,
                "editVersion": 0,
                "ownerId": str(self.owner.id),
            },
        )
        return copy

    def test_copy_matches_the_source_apart_from_its_identity(self):
        copy = self.duplicate(self.source)

        self.assertNotEqual(copy.id, self.source.id)
        self.assertNotEqual(copy.public_id, self.source.public_id)
        self.assertEqual(copy.code, "RCP-0008")
        self.assertEqual(copy.title, "Levain (copy)")
        self.assertEqual(copy.status, Recipe.STATUS_ACTIVE)

        expected = recipe_json(self.source, viewer_user=self.owner)
        expected["status"] = Recipe.STATUS_ACTIVE
        expected.update({"shares": [], "comments": [], "externalRefs": []})
        actual = recipe_json(copy, viewer_user=self.owner)
        # The sub-recipe picker leaves out the recipe being read, so each
        # payload lists the other one there; it is a read, not content.
        for payload in (expected, actual):
            payload.pop("recipeOptions")
        self.assertEqual(content(actual), content(expected))

        # The rows the payload reads back are the copy's own, not the source's.
        self.assertEqual(copy.items.count(), 4)
        self.assertEqual(copy.steps.count(), 3)
        self.assertEqual(copy.steps.get(position=0).media.count(), 1)
        self.assertEqual(copy.steps.get(position=1).timings.count(), 1)
        self.assertEqual(copy.media.count(), 1)
        self.assertEqual(self.source.items.count(), 4)
        self.assertEqual(self.source.media.count(), 1)
        self.assertEqual(
            list(
                self.source.steps.get(position=1).timings.values_list(
                    "seconds", flat=True
                )
            ),
            [600],
        )

    def test_copy_keeps_what_the_old_client_side_copy_lost(self):
        copy = self.duplicate(self.source)
        self.assertEqual(copy.kind, Recipe.KIND_COMPONENT)
        self.assertEqual(copy.body, "legacy ingredients")
        self.assertEqual(copy.method, "legacy method")
        flour = copy.items.get(position=1)
        self.assertTrue(flour.is_base)
        self.assertTrue(flour.excluded_from_cost)
        self.assertEqual(flour.ingredient_id, self.flour.id)
        self.assertEqual(copy.items.get(position=2).subrecipe_id, self.starter.id)
        self.assertEqual(copy.steps.get(position=0).kind, RecipeStep.HEADER)

    def test_copy_title_counts_instead_of_stacking(self):
        first = self.duplicate(self.source)
        second = self.duplicate(first)
        third = self.duplicate(second)
        self.assertEqual(
            [first.title, second.title, third.title],
            ["Levain (copy)", "Levain (copy 2)", "Levain (copy 3)"],
        )
        long_title = Recipe.objects.create(user=self.owner, title="x" * 200)
        self.assertEqual(len(self.duplicate(long_title).title), 200)

    def test_copy_is_recorded_as_added(self):
        copy = self.duplicate(self.source)
        event = ActivityEvent.objects.get(resource_type="recipe", resource_id=copy.id)
        self.assertEqual(event.event, "added")
        self.assertEqual(event.actor_id, self.owner.id)

    def test_only_the_owner_can_duplicate(self):
        for user in (
            self.editor,
            User.objects.create_user(
                email="stranger-duplicate@example.com", name="Stranger", password="pass"
            ),
        ):
            with self.assertRaises(ValueError):
                action_duplicate_recipe(user, {"id": str(self.source.id)})
        self.assertEqual(Recipe.objects.filter(user=self.owner).count(), 2)
