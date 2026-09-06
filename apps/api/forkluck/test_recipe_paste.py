"""Committing a reviewed recipe paste, and taking the whole thing back.

The paste writes four kinds of thing — ingredients, preparations, matches and
the recipe text — so every test here asks the same question of all four: did
they all land, and does the undo reverse each one without destroying work the
cook did afterwards.
"""

from datetime import timedelta
from decimal import Decimal

from django.test import TestCase

from .domains.recipes import actions
from .models import (
    CatalogIngredient,
    CatalogPreparationYield,
    Ingredient,
    RecipeLineMatch,
    IngredientConversion,
    IngredientMeasure,
    Preparation,
    Recipe,
    RecipeItem,
    RecipePaste,
    RecipePasteItem,
    User,
)


class RecipePasteTestCase(TestCase):
    @classmethod
    def setUpTestData(cls) -> None:
        cls.user = User.objects.create_user(
            email="cook@example.com",
            password="a-long-test-passphrase-2468",
            name="Cook",
        )
        cls.stranger = User.objects.create_user(
            email="stranger@example.com",
            password="a-long-test-passphrase-1357",
            name="Stranger",
        )
        cls.recipe = Recipe.objects.create(
            user=cls.user, title="Soup", code="R1", body="old body", method="old method"
        )
        cls.onion = Ingredient.objects.create(
            user=cls.user, name="Onion", purchase_cost_cents=200
        )

    def commit(self, **overrides):
        body = {
            "recipeId": str(self.recipe.id),
            "body": "2 cups diced onion\n300 g mystery powder",
            "method": "Simmer.",
            "ingredients": [
                {
                    "name": "Onion",
                    "ingredientId": str(self.onion.id),
                    "preparations": ["Diced"],
                },
                {
                    "name": "Mystery powder",
                    "ingredientId": None,
                    "preparations": [],
                },
            ],
            **overrides,
        }
        return actions.action_commit_recipe_paste(self.user, body)

    def age(self, queryset, paste: RecipePaste) -> None:
        """Push a row's `updated_at` past the paste's watermark."""
        queryset.update(updated_at=paste.updated_at + timedelta(seconds=1))


class CommitTests(RecipePasteTestCase):
    def test_one_commit_writes_every_kind_of_effect(self):
        receipt = self.commit()

        created = Ingredient.objects.get(user=self.user, name="Mystery powder")
        self.assertEqual(created.purchase_cost_cents, 0)
        self.assertTrue(
            RecipeLineMatch.objects.filter(
                user=self.user, normalized_text="mystery powder", ingredient=created
            ).exists()
        )
        self.assertTrue(
            Preparation.objects.filter(ingredient=self.onion, name="Diced").exists()
        )
        self.recipe.refresh_from_db()
        self.assertEqual(self.recipe.body, "2 cups diced onion\n300 g mystery powder")
        self.assertEqual(self.recipe.method, "Simmer.")

        self.assertEqual(
            {key: value for key, value in receipt.items() if key not in {"batchId", "ingredientIds"}},
            {
                "lines": 2,
                "ingredients": 1,
                "preparations": 1,
                "matches": 1,
                "measures": 0,
            },
        )

    def test_a_line_that_states_two_measures_saves_the_equivalency(self):
        receipt = self.commit(
            ingredients=[
                {
                    "name": "Onion",
                    "ingredientId": str(self.onion.id),
                    "preparations": [],
                    "measures": [
                        {
                            "amount": 1,
                            "unit": "cup",
                            "grams": 250,
                            "qualifier": "",
                        }
                    ],
                }
            ]
        )

        measure = IngredientMeasure.objects.get(ingredient=self.onion, unit="cup")
        self.assertEqual(measure.amount, Decimal("1.000000"))
        self.assertEqual(measure.grams, Decimal("250.000000"))
        self.assertEqual(receipt["measures"], 1)

    def test_a_measure_the_ingredient_already_has_is_left_alone(self):
        IngredientMeasure.objects.create(
            ingredient=self.onion, unit="cup", amount=Decimal("1"), grams=Decimal("120")
        )

        receipt = self.commit(
            ingredients=[
                {
                    "name": "Onion",
                    "ingredientId": str(self.onion.id),
                    "preparations": [],
                    "measures": [
                        {"amount": 1, "unit": "cup", "grams": 250, "qualifier": ""}
                    ],
                }
            ]
        )

        self.assertEqual(receipt["measures"], 0)
        self.assertEqual(
            IngredientMeasure.objects.get(ingredient=self.onion, unit="cup").grams,
            Decimal("120.000000"),
        )

    def test_an_undo_takes_back_the_measure_and_the_ingredient_it_was_on(self):
        receipt = self.commit(
            ingredients=[
                {
                    "name": "Mystery powder",
                    "ingredientId": None,
                    "preparations": [],
                    "measures": [
                        {"amount": 1, "unit": "cup", "grams": 250, "qualifier": ""}
                    ],
                }
            ]
        )
        created = Ingredient.objects.get(user=self.user, name="Mystery powder")
        self.assertTrue(IngredientMeasure.objects.filter(ingredient=created).exists())

        result = actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})

        self.assertEqual(result["deletedMeasures"], 1)
        self.assertEqual(result["deletedIngredients"], 1)
        self.assertFalse(IngredientMeasure.objects.exists())
        self.assertFalse(Ingredient.objects.filter(id=created.id).exists())

    def test_a_measure_in_a_unit_nothing_is_measured_in_is_refused(self):
        with self.assertRaises(ValueError):
            self.commit(
                ingredients=[
                    {
                        "name": "Onion",
                        "ingredientId": str(self.onion.id),
                        "preparations": [],
                        "measures": [
                            {"amount": 1, "unit": "g", "grams": 250, "qualifier": ""}
                        ],
                    }
                ]
            )
        self.assertFalse(IngredientMeasure.objects.exists())

    def test_a_seeded_preparation_carries_the_catalog_yield(self):
        catalog_ingredient = CatalogIngredient.objects.create(name="Onion")
        CatalogPreparationYield.objects.create(
            ingredient=catalog_ingredient,
            name="Diced",
            normalized_name="diced",
            yield_percent=Decimal("82.000"),
            source_kind="public_food_data",
            source_ref="record-1",
            source_release="release-1",
            derivation="direct",
            evidence_count=2,
            confidence="medium",
            is_default=True,
        )

        self.commit()

        preparation = Preparation.objects.get(ingredient=self.onion, name="Diced")
        self.assertEqual(preparation.yield_percent, Decimal("82.000"))
        self.assertEqual(preparation.source, Preparation.Source.CATALOG)
        self.assertEqual(preparation.confidence, "medium")

    def test_a_preparation_the_ingredient_already_has_is_not_written_twice(self):
        Preparation.objects.create(
            user=self.user, ingredient=self.onion, name="diced"
        )

        receipt = self.commit()

        self.assertEqual(receipt["preparations"], 0)
        self.assertEqual(Preparation.objects.filter(ingredient=self.onion).count(), 1)

    def test_a_failing_entry_leaves_nothing_behind(self):
        with self.assertRaises(ValueError):
            self.commit(
                ingredients=[
                    {"name": "Mystery powder", "ingredientId": None, "preparations": []},
                    {
                        "name": "Ghost",
                        "ingredientId": "00000000-0000-0000-0000-000000000000",
                        "preparations": [],
                    },
                ]
            )

        self.assertFalse(
            Ingredient.objects.filter(user=self.user, name="Mystery powder").exists()
        )
        self.assertFalse(RecipeLineMatch.objects.filter(user=self.user).exists())
        self.assertFalse(RecipePaste.objects.exists())
        self.recipe.refresh_from_db()
        self.assertEqual(self.recipe.body, "old body")

    def test_another_tenants_recipe_is_not_found(self):
        with self.assertRaisesMessage(ValueError, "Recipe not found"):
            actions.action_commit_recipe_paste(
                self.stranger,
                {
                    "recipeId": str(self.recipe.id),
                    "body": "1 onion",
                    "method": "",
                    "ingredients": [],
                },
            )
        self.recipe.refresh_from_db()
        self.assertEqual(self.recipe.body, "old body")

    def test_another_tenants_ingredient_is_not_found(self):
        stranger_recipe = Recipe.objects.create(
            user=self.stranger, title="Stew", code="R2"
        )
        with self.assertRaisesMessage(ValueError, "Ingredient not found"):
            actions.action_commit_recipe_paste(
                self.stranger,
                {
                    "recipeId": str(stranger_recipe.id),
                    "body": "1 onion",
                    "method": "",
                    "ingredients": [
                        {
                            "name": "Onion",
                            "ingredientId": str(self.onion.id),
                            "preparations": ["Diced"],
                        }
                    ],
                },
            )
        self.assertFalse(Preparation.objects.exists())


class UndoTests(RecipePasteTestCase):
    def test_undo_reverses_all_four_effects(self):
        receipt = self.commit()

        result = actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})

        self.assertEqual(
            result,
            {
                "ok": True,
                "deletedIngredients": 1,
                "retainedIngredients": 0,
                "deletedPreparations": 1,
                "retainedPreparations": 0,
                "deletedMatches": 1,
                "deletedMeasures": 0,
            },
        )
        self.assertFalse(
            Ingredient.objects.filter(user=self.user, name="Mystery powder").exists()
        )
        self.assertFalse(RecipeLineMatch.objects.filter(user=self.user).exists())
        self.assertFalse(Preparation.objects.exists())
        self.recipe.refresh_from_db()
        self.assertEqual(self.recipe.body, "old body")
        self.assertEqual(self.recipe.method, "old method")
        self.assertIsNotNone(
            RecipePaste.objects.get(id=receipt["batchId"]).undone_at
        )

    def test_the_restored_recipe_keeps_its_pre_paste_timestamp(self):
        before = Recipe.objects.get(id=self.recipe.id).updated_at
        receipt = self.commit()
        actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})

        self.assertEqual(Recipe.objects.get(id=self.recipe.id).updated_at, before)

        # A second paste over the restored recipe is undoable in turn, which it
        # would not be if auto_now had left the recipe looking edited.
        second = self.commit()
        actions.action_undo_recipe_paste(self.user, {"id": second["batchId"]})
        self.assertEqual(Recipe.objects.get(id=self.recipe.id).body, "old body")

    def test_only_the_latest_paste_can_be_undone(self):
        first = self.commit()
        self.commit()

        with self.assertRaisesMessage(ValueError, "Undo newer pastes first"):
            actions.action_undo_recipe_paste(self.user, {"id": first["batchId"]})

    def test_a_paste_is_undone_only_once(self):
        receipt = self.commit()
        actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})

        with self.assertRaisesMessage(ValueError, "Paste not found or already undone"):
            actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})

    def test_another_tenant_cannot_undo_this_paste(self):
        receipt = self.commit()

        with self.assertRaisesMessage(ValueError, "Paste not found or already undone"):
            actions.action_undo_recipe_paste(
                self.stranger, {"id": receipt["batchId"]}
            )
        self.recipe.refresh_from_db()
        self.assertEqual(self.recipe.body, "2 cups diced onion\n300 g mystery powder")

    def test_a_recipe_edited_after_the_paste_is_refused(self):
        receipt = self.commit()
        paste = RecipePaste.objects.get(id=receipt["batchId"])
        self.age(Recipe.objects.filter(id=self.recipe.id), paste)

        with self.assertRaisesMessage(ValueError, "The recipe changed after this paste"):
            actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})
        self.assertTrue(
            Ingredient.objects.filter(user=self.user, name="Mystery powder").exists()
        )

    def test_an_ingredient_edited_after_the_paste_is_refused(self):
        receipt = self.commit()
        paste = RecipePaste.objects.get(id=receipt["batchId"])
        self.age(Ingredient.objects.filter(name="Mystery powder"), paste)

        with self.assertRaisesMessage(ValueError, "An ingredient changed after this paste"):
            actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})

    def test_a_preparation_edited_after_the_paste_is_refused(self):
        receipt = self.commit()
        paste = RecipePaste.objects.get(id=receipt["batchId"])
        self.age(Preparation.objects.filter(name="Diced"), paste)

        with self.assertRaisesMessage(ValueError, "A preparation changed after this paste"):
            actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})

    def test_an_alias_moved_after_the_paste_is_refused(self):
        receipt = self.commit()
        paste = RecipePaste.objects.get(id=receipt["batchId"])
        self.age(RecipeLineMatch.objects.filter(normalized_text="mystery powder"), paste)

        with self.assertRaisesMessage(
            ValueError, "An ingredient match changed after this paste"
        ):
            actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})

    def test_an_ingredient_given_a_preparation_since_is_kept(self):
        receipt = self.commit()
        created = Ingredient.objects.get(user=self.user, name="Mystery powder")
        Preparation.objects.create(user=self.user, ingredient=created, name="Sifted")

        result = actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})

        self.assertEqual(result["retainedIngredients"], 1)
        self.assertEqual(result["deletedIngredients"], 0)
        self.assertTrue(Ingredient.objects.filter(id=created.id).exists())

    def test_an_ingredient_given_a_conversion_since_is_kept(self):
        receipt = self.commit()
        created = Ingredient.objects.get(user=self.user, name="Mystery powder")
        IngredientConversion.objects.create(user=self.user, ingredient=created)

        result = actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})

        self.assertEqual(result["retainedIngredients"], 1)
        self.assertTrue(Ingredient.objects.filter(id=created.id).exists())

    def test_an_ingredient_given_a_measure_since_is_kept(self):
        receipt = self.commit()
        created = Ingredient.objects.get(user=self.user, name="Mystery powder")
        IngredientMeasure.objects.create(
            ingredient=created, unit="cup", amount=Decimal("1"), grams=Decimal("120")
        )

        result = actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})

        self.assertEqual(result["retainedIngredients"], 1)
        self.assertTrue(Ingredient.objects.filter(id=created.id).exists())

    def test_an_ingredient_another_recipe_names_since_is_kept(self):
        """A recipe line names its ingredient as text, so a second recipe
        written since the paste leaves no relation on the row at all."""
        receipt = self.commit()
        created = Ingredient.objects.get(user=self.user, name="Mystery powder")
        Recipe.objects.create(
            user=self.user,
            title="Rub",
            code="R2",
            body="30 g mystery powder",
        )

        result = actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})

        self.assertEqual(result["retainedIngredients"], 1)
        self.assertEqual(result["deletedIngredients"], 0)
        self.assertTrue(Ingredient.objects.filter(id=created.id).exists())

    def test_another_saved_recipe_item_keeps_the_created_ingredient(self):
        receipt = self.commit()
        created = Ingredient.objects.get(user=self.user, name="Mystery powder")
        other = Recipe.objects.create(user=self.user, title="Rub", code="R6")
        RecipeItem.objects.create(
            recipe=other,
            kind=RecipeItem.INGREDIENT,
            ingredient=created,
            display_name="Mystery powder",
            quantity=30,
            unit="g",
        )

        result = actions.action_undo_recipe_paste(
            self.user, {"id": receipt["batchId"]}
        )

        self.assertEqual(result["retainedIngredients"], 1)
        self.assertEqual(result["deletedIngredients"], 0)
        self.assertTrue(Ingredient.objects.filter(id=created.id).exists())

    def test_a_preparation_asked_for_through_an_alias_is_kept(self):
        """The Match flow writes an alias rather than rewriting the line, so a
        later recipe can ask for a pasted preparation without ever spelling the
        ingredient it belongs to."""
        receipt = self.commit()
        RecipeLineMatch.objects.create(
            user=self.user, text="yellow onion", ingredient=self.onion
        )
        Recipe.objects.create(
            user=self.user,
            title="Stock",
            code="R4",
            body="2 cups yellow onion, diced",
        )

        result = actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})

        self.assertEqual(result["retainedPreparations"], 1)
        self.assertEqual(result["deletedPreparations"], 0)

    def test_a_preparation_another_recipe_asks_for_since_is_kept(self):
        receipt = self.commit()
        Recipe.objects.create(
            user=self.user,
            title="Stock",
            code="R3",
            body="2 cups onion, diced, cooked",
        )

        result = actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})

        self.assertEqual(result["retainedPreparations"], 1)
        self.assertEqual(result["deletedPreparations"], 0)
        self.assertTrue(
            Preparation.objects.filter(ingredient=self.onion, name="Diced").exists()
        )

    def test_a_bare_preparation_word_does_not_keep_a_different_identity(self):
        receipt = self.commit()
        Recipe.objects.create(
            user=self.user,
            title="Stock",
            code="R5",
            body="2 cups diced onion",
        )

        result = actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})

        self.assertEqual(result["retainedPreparations"], 0)
        self.assertEqual(result["deletedPreparations"], 1)

    def test_the_pasted_recipe_itself_does_not_keep_what_it_created(self):
        """The paste wrote those lines, so the recipe naming them is not
        evidence of work done since."""
        receipt = self.commit()

        result = actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})

        self.assertEqual(result["deletedIngredients"], 1)
        self.assertEqual(result["deletedPreparations"], 1)

    def test_another_tenants_recipe_does_not_keep_this_ingredient(self):
        receipt = self.commit()
        Recipe.objects.create(
            user=self.stranger,
            title="Rub",
            code="R2",
            body="30 g mystery powder",
        )

        result = actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})

        self.assertEqual(result["deletedIngredients"], 1)

    def test_a_row_already_deleted_by_hand_does_not_block_the_undo(self):
        receipt = self.commit()
        Ingredient.objects.filter(user=self.user, name="Mystery powder").delete()

        result = actions.action_undo_recipe_paste(self.user, {"id": receipt["batchId"]})

        self.assertEqual(result["deletedIngredients"], 0)
        self.recipe.refresh_from_db()
        self.assertEqual(self.recipe.body, "old body")

    def test_every_created_row_is_recorded_as_its_own_item(self):
        receipt = self.commit()
        kinds = list(
            RecipePasteItem.objects.filter(
                recipe_paste_id=receipt["batchId"]
            ).values_list("kind", flat=True)
        )
        self.assertEqual(sorted(kinds), ["alias", "ingredient", "preparation"])
