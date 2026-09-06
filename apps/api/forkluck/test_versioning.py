"""edit_version refuses a save written against an older read."""

from decimal import Decimal
from unittest.mock import patch

from django.db import connection
from django.test import Client, TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from .domains.invoices import actions as invoice_actions
from .domains.recipes.health import RecipeHealthReadModel
from .domains.shared.versioning import StaleWriteError, check_and_bump
from .http import dispatch
from .models import (
    Ingredient,
    IngredientAllergenOverride,
    IngredientTag,
    Invoice,
    Menu,
    Recipe,
    RecipeItem,
    RecipeShare,
    RecipeTag,
    User,
)
from .testing import InternalApiTestCase


class CheckAndBumpTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="versioning@example.com",
            name="Versioning Tester",
            password="a-long-test-passphrase-1357",
        )
        self.recipe = Recipe.objects.create(user=self.user, title="Focaccia")

    def test_a_matching_version_bumps_and_returns_the_new_one(self):
        self.assertEqual(check_and_bump(self.recipe, 0), 1)
        self.recipe.refresh_from_db()
        self.assertEqual(self.recipe.edit_version, 1)

    def test_no_expected_version_bumps(self):
        self.assertEqual(check_and_bump(self.recipe, None), 1)

    def test_a_stale_version_is_refused_and_leaves_the_row_alone(self):
        check_and_bump(self.recipe, 0)
        fresh = Recipe.objects.get(pk=self.recipe.pk)
        with self.assertRaises(StaleWriteError) as caught:
            check_and_bump(fresh, 0)
        self.assertEqual(caught.exception.current, 1)
        self.assertEqual(caught.exception.kind, "recipe")
        self.recipe.refresh_from_db()
        self.assertEqual(self.recipe.edit_version, 1)

    def test_the_bump_writes_the_version_column_and_nothing_else(self):
        # A full save() would carry the whole row, putting back every column
        # another window wrote between this read and this bump.
        seen: list[dict] = []

        def spy(self_row, *args, **kwargs):
            seen.append(kwargs)

        with patch.object(Recipe, "save", spy):
            check_and_bump(self.recipe, 0)

        self.assertEqual(seen, [{"update_fields": ["edit_version", "updated_at"]}])


class BumpAtomicityTests(TransactionTestCase):
    """No wrapping atomic here, so in_atomic_block says something real."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="atomicity@example.com",
            name="Atomicity Tester",
            password="a-long-test-passphrase-3579",
        )
        self.ingredient = Ingredient.objects.create(
            user=self.user,
            name="Butter",
            normalized_name="butter",
            purchase_cost_cents=500,
            purchase_size=1,
            purchase_unit="lb",
        )

    def test_the_bump_runs_inside_a_transaction_the_action_opened(self):
        from .domains.ingredients import actions as ingredient_actions

        real_bump = ingredient_actions.check_and_bump
        seen: list[bool] = []

        def bump(row, expected):
            seen.append(connection.in_atomic_block)
            return real_bump(row, expected)

        self.assertFalse(connection.in_atomic_block)
        with patch.object(ingredient_actions, "check_and_bump", bump):
            ingredient_actions.action_save_ingredient(
                self.user,
                {
                    "id": str(self.ingredient.id),
                    "name": "Butter",
                    "purchaseCostCents": 500,
                    "purchaseSize": 1,
                    "purchaseUnit": "lb",
                    "expectedEditVersion": 0,
                },
            )

        self.assertEqual(seen, [True])


class StaleWriteEnvelopeTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="stale-envelope@example.com",
            name="Envelope Tester",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)

    def test_a_stale_write_answers_409_with_the_code_and_version(self):
        def handler(user, body):
            raise StaleWriteError(7, "recipe")

        with patch.dict(dispatch.ACTIONS, {"stale-write-probe": handler}):
            response = self.post_internal("stale-write-probe", {})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.json(),
            {
                "error": (
                    "This recipe changed in another window. Reload to see the latest."
                ),
                "code": "stale_write",
                "editVersion": 7,
            },
        )


class RecipeAggregateVersionTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.owner = User.objects.create_user(
            email="recipe-version-owner@example.com",
            name="Owner",
            password="a-long-test-passphrase-9753",
        )
        self.editor = User.objects.create_user(
            email="recipe-version-editor@example.com",
            name="Editor",
            password="a-long-test-passphrase-8642",
            email_verified_at=timezone.now(),
        )
        self.recipe = Recipe.objects.create(user=self.owner, title="Focaccia")
        RecipeShare.objects.create(
            recipe=self.recipe, recipient=self.editor, role=RecipeShare.EDITOR
        )
        self.client = Client()
        self.client.force_login(self.owner)

    def save(self, **extra):
        body = {"id": str(self.recipe.id), "title": "Focaccia"}
        body.update(extra)
        return self.post_internal("save-recipe", body)

    def test_a_create_starts_at_version_zero(self):
        response = self.post_internal("save-recipe", {"id": None, "title": "Levain"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["editVersion"], 0)

    def test_an_update_bumps_and_echoes_the_new_version(self):
        self.assertEqual(self.save().json()["editVersion"], 1)
        self.assertEqual(self.save(expectedEditVersion=1).json()["editVersion"], 2)

    def test_a_subrecipe_rename_updates_parent_lines_in_constant_queries(self):
        first_parent = Recipe.objects.create(user=self.owner, title="Bread")
        RecipeItem.objects.create(
            recipe=first_parent,
            kind=RecipeItem.SUBRECIPE,
            subrecipe=self.recipe,
            display_name="Focaccia",
            position=0,
        )

        with CaptureQueriesContext(connection) as one_parent:
            response = self.save(expectedEditVersion=0, title="Focaccia Genovese")
        self.assertEqual(response.status_code, 200)
        first_parent.refresh_from_db()
        self.assertEqual(first_parent.edit_version, 1)
        self.assertEqual(first_parent.items.get().display_name, "Focaccia Genovese")

        more_parents = []
        for position in range(4):
            parent = Recipe.objects.create(user=self.owner, title=f"Menu {position}")
            RecipeItem.objects.create(
                recipe=parent,
                kind=RecipeItem.SUBRECIPE,
                subrecipe=self.recipe,
                display_name="Focaccia Genovese",
                position=0,
            )
            more_parents.append(parent)

        with CaptureQueriesContext(connection) as five_parents:
            response = self.save(expectedEditVersion=1, title="Focaccia Mooncake")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            len(five_parents),
            len(one_parent),
            msg="Sub-recipe rename propagation must not add queries per parent recipe",
        )
        self.assertEqual(
            set(
                RecipeItem.objects.filter(subrecipe=self.recipe).values_list(
                    "display_name", flat=True
                )
            ),
            {"Focaccia Mooncake"},
        )
        first_parent.refresh_from_db()
        self.assertEqual(first_parent.edit_version, 2)
        self.assertNotIn(
            "stray words",
            RecipeHealthReadModel(self.owner)._normalized_row(first_parent)["issues"],
        )
        for parent in more_parents:
            parent.refresh_from_db()
            self.assertEqual(parent.edit_version, 1)

    def test_a_subrecipe_rename_preserves_deliberately_different_line_text(self):
        parent = Recipe.objects.create(user=self.owner, title="Bread")
        line = RecipeItem.objects.create(
            recipe=parent,
            kind=RecipeItem.SUBRECIPE,
            subrecipe=self.recipe,
            display_name="Focaccia for service",
            position=0,
        )

        response = self.save(expectedEditVersion=0, title="Focaccia Genovese")

        self.assertEqual(response.status_code, 200)
        line.refresh_from_db()
        parent.refresh_from_db()
        self.assertEqual(line.display_name, "Focaccia for service")
        self.assertEqual(parent.edit_version, 0)

    def test_a_save_against_an_older_read_is_refused(self):
        self.save()
        response = self.save(expectedEditVersion=0, title="Overwritten")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.json(),
            {
                "error": (
                    "This recipe changed in another window. Reload to see the latest."
                ),
                "code": "stale_write",
                "editVersion": 1,
            },
        )
        self.recipe.refresh_from_db()
        self.assertEqual(self.recipe.title, "Focaccia")
        self.assertEqual(self.recipe.edit_version, 1)

    def test_only_the_aggregate_save_bumps(self):
        self.save()
        self.post_internal(
            "update-recipe-status",
            {"recipeId": str(self.recipe.id), "status": "archived"},
        )
        self.recipe.refresh_from_db()
        self.assertEqual(self.recipe.edit_version, 1)

    def test_a_yield_commit_bumps_so_a_stale_aggregate_save_is_refused(self):
        item = RecipeItem.objects.create(
            recipe=self.recipe,
            kind=RecipeItem.INGREDIENT,
            position=0,
            display_name="Butter",
            quantity=Decimal("100"),
            unit="g",
        )
        response = self.post_internal(
            "set-recipe-item-yield-after-cooking",
            {
                "recipeId": str(self.recipe.id),
                "itemId": str(item.id),
                "percent": 80,
            },
        )
        self.assertEqual(response.status_code, 200)
        self.recipe.refresh_from_db()
        self.assertEqual(self.recipe.edit_version, 1)
        self.assertEqual(self.save(expectedEditVersion=0).status_code, 409)

    def test_tags_are_created_with_the_rest_of_the_aggregate(self):
        self.save(tags=["Bread", "bread", " Brunch "])
        self.assertEqual(
            sorted(
                membership.tag.name
                for membership in self.recipe.tag_memberships.select_related("tag")
            ),
            ["Bread", "Brunch"],
        )

    def test_a_refused_item_rolls_the_new_tags_back(self):
        response = self.save(
            tags=["Bread"],
            items=[{"kind": "ingredient", "ingredientId": str(self.recipe.id)}],
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(RecipeTag.objects.filter(user=self.owner).count(), 0)
        self.assertEqual(self.recipe.tag_memberships.count(), 0)
        self.recipe.refresh_from_db()
        self.assertEqual(self.recipe.edit_version, 0)

    def test_an_omitted_tags_key_preserves_the_memberships(self):
        self.save(tags=["Bread"])
        self.save(expectedEditVersion=1, title="Focaccia Genovese")
        self.assertEqual(
            [
                membership.tag.name
                for membership in self.recipe.tag_memberships.select_related("tag")
            ],
            ["Bread"],
        )

    def test_an_empty_tags_list_clears_the_memberships(self):
        self.save(tags=["Bread"])
        self.save(expectedEditVersion=1, tags=[])
        self.assertEqual(self.recipe.tag_memberships.count(), 0)

    def test_an_editor_may_send_its_expected_version_but_not_tags(self):
        self.client.force_login(self.editor)
        self.assertEqual(
            self.save(expectedEditVersion=0, title="Editor's name").json()[
                "editVersion"
            ],
            1,
        )
        response = self.save(expectedEditVersion=1, tags=["Bread"])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["error"],
            "Editors may change only recipe title, description, items, and steps",
        )


class MenuAggregateVersionTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="menu-version@example.com",
            name="Menu Owner",
            password="a-long-test-passphrase-1470",
        )
        self.menu = Menu.objects.create(user=self.user, name="Spring")
        self.client = Client()
        self.client.force_login(self.user)

    def save(self, **extra):
        body = {
            "id": str(self.menu.id),
            "name": "Spring",
            "periodStart": None,
            "periodEnd": None,
            "items": [],
        }
        body.update(extra)
        return self.post_internal("save-menu", body)

    def test_a_create_starts_at_version_zero(self):
        response = self.post_internal(
            "save-menu",
            {
                "id": None,
                "name": "Autumn",
                "periodStart": None,
                "periodEnd": None,
                "items": [],
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["menu"]["editVersion"], 0)

    def test_an_update_bumps_and_echoes_the_new_version(self):
        self.assertEqual(self.save().json()["menu"]["editVersion"], 1)
        self.assertEqual(
            self.save(expectedEditVersion=1).json()["menu"]["editVersion"], 2
        )

    def test_a_save_against_an_older_read_is_refused(self):
        self.save()
        response = self.save(expectedEditVersion=0, name="Overwritten")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.json(),
            {
                "error": (
                    "This menu changed in another window. Reload to see the latest."
                ),
                "code": "stale_write",
                "editVersion": 1,
            },
        )
        self.menu.refresh_from_db()
        self.assertEqual(self.menu.name, "Spring")
        self.assertEqual(self.menu.edit_version, 1)


class InvoiceAggregateVersionTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="invoice-version@example.com",
            name="Invoice Owner",
            password="a-long-test-passphrase-1590",
        )
        self.client = Client()
        self.client.force_login(self.user)

    def save(self, **extra):
        body = {
            "supplierName": "Corner Market",
            "invoiceNumber": "CM-1",
            "invoiceDate": "2026-07-14",
            "totalCents": 1000,
            "taxCents": 0,
            "paymentMethod": "",
            "lines": [{"description": "Napkins", "lineAmountCents": 1000}],
        }
        body.update(extra)
        return self.post_internal("save-invoice", body)

    def create(self) -> str:
        response = self.save()
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["item"]["id"]

    def test_a_create_starts_at_version_zero(self):
        self.assertEqual(self.save().json()["item"]["editVersion"], 0)

    def test_an_update_bumps_and_echoes_the_new_version(self):
        invoice_id = self.create()
        self.assertEqual(self.save(id=invoice_id).json()["item"]["editVersion"], 1)
        self.assertEqual(
            self.save(id=invoice_id, expectedEditVersion=1).json()["item"][
                "editVersion"
            ],
            2,
        )

    def test_a_save_against_an_older_read_is_refused(self):
        invoice_id = self.create()
        self.save(id=invoice_id)
        response = self.save(
            id=invoice_id, expectedEditVersion=0, supplierName="Overwritten"
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.json(),
            {
                "error": (
                    "This invoice changed in another window. Reload to see the latest."
                ),
                "code": "stale_write",
                "editVersion": 1,
            },
        )
        invoice = Invoice.objects.get(pk=invoice_id)
        self.assertEqual(invoice.supplier_name, "Corner Market")
        self.assertEqual(invoice.edit_version, 1)

    def test_the_row_is_locked_after_the_workspace_and_its_cost_settings(self):
        invoice_id = self.create()
        real_lock = invoice_actions.lock_workspace
        real_bump = invoice_actions.check_and_bump
        marks: dict[str, int] = {}

        with CaptureQueriesContext(connection) as captured:

            def lock(user):
                marks["workspace"] = len(connection.queries)
                real_lock(user)

            def bump(row, expected):
                marks["bump"] = len(connection.queries)
                return real_bump(row, expected)

            with (
                patch.object(invoice_actions, "lock_workspace", lock),
                patch.object(invoice_actions, "check_and_bump", bump),
            ):
                response = self.save(id=invoice_id, expectedEditVersion=0)

        self.assertEqual(response.status_code, 200, response.content)
        under_lock = [
            query["sql"]
            for query in captured.captured_queries[marks["workspace"] : marks["bump"]]
        ]
        settings_at = next(
            index
            for index, sql in enumerate(under_lock)
            if "benchcostsettings" in sql.lower()
        )
        invoice_at = next(
            index
            for index, sql in enumerate(under_lock)
            if '"forkluck_invoice"' in sql.lower()
        )
        self.assertLess(settings_at, invoice_at)


class IngredientAggregateVersionTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="ingredient-version@example.com",
            name="Pantry Keeper",
            password="a-long-test-passphrase-1122",
        )
        self.ingredient = Ingredient.objects.create(
            user=self.user,
            name="Butter",
            normalized_name="butter",
            purchase_cost_cents=500,
            purchase_size=1,
            purchase_unit="lb",
        )
        self.client = Client()
        self.client.force_login(self.user)

    def save(self, **extra):
        body = {
            "id": str(self.ingredient.id),
            "name": "Butter",
            "purchaseCostCents": 500,
            "purchaseSize": 1,
            "purchaseUnit": "lb",
        }
        body.update(extra)
        return self.post_internal("save-ingredient", body)

    def tag_names(self):
        return sorted(self.ingredient.tags.values_list("name", flat=True))

    def test_a_create_starts_at_version_zero(self):
        response = self.post_internal(
            "save-ingredient",
            {
                "id": None,
                "name": "Cream",
                "purchaseCostCents": 0,
                "purchaseSize": None,
                "purchaseUnit": None,
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["editVersion"], 0)

    def test_an_update_bumps_and_echoes_the_new_version(self):
        self.assertEqual(self.save().json()["editVersion"], 1)
        self.assertEqual(self.save(expectedEditVersion=1).json()["editVersion"], 2)

    def test_a_save_against_an_older_read_is_refused(self):
        self.save()
        response = self.save(expectedEditVersion=0, name="Overwritten")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.json(),
            {
                "error": (
                    "This ingredient changed in another window."
                    " Reload to see the latest."
                ),
                "code": "stale_write",
                "editVersion": 1,
            },
        )
        self.ingredient.refresh_from_db()
        self.assertEqual(self.ingredient.name, "Butter")
        self.assertEqual(self.ingredient.edit_version, 1)

    def test_the_two_half_payloads_leave_each_others_fields_alone(self):
        pack = self.post_internal(
            "save-ingredient",
            {
                "id": str(self.ingredient.id),
                "purchaseCostCents": 700,
                "purchaseSize": 1,
                "purchaseUnit": "lb",
            },
        )
        self.assertEqual(pack.status_code, 200, pack.content)
        named = self.post_internal(
            "save-ingredient",
            {
                "id": str(self.ingredient.id),
                "name": "Butter, unsalted",
                "expectedEditVersion": pack.json()["editVersion"],
            },
        )
        self.assertEqual(named.status_code, 200, named.content)
        self.ingredient.refresh_from_db()
        self.assertEqual(self.ingredient.name, "Butter, unsalted")
        self.assertEqual(self.ingredient.purchase_cost_cents, 700)

    def test_a_create_still_demands_a_name(self):
        response = self.post_internal(
            "save-ingredient",
            {"id": None, "purchaseCostCents": 0, "purchaseSize": None, "purchaseUnit": None},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Name must be text")

    def test_tags_are_created_with_the_rest_of_the_ingredient(self):
        self.save(tags=["Dairy", "dairy", " Fats "])
        self.assertEqual(self.tag_names(), ["Dairy", "Fats"])

    def test_an_omitted_tags_key_preserves_the_memberships(self):
        self.save(tags=["Dairy"])
        self.save(expectedEditVersion=1, name="Butter, unsalted")
        self.assertEqual(self.tag_names(), ["Dairy"])

    def test_an_empty_tags_list_clears_the_memberships(self):
        self.save(tags=["Dairy"])
        self.save(expectedEditVersion=1, tags=[])
        self.assertEqual(self.tag_names(), [])

    def test_a_malformed_tag_rolls_the_whole_save_back(self):
        response = self.save(name="Butter, unsalted", tags=["Dairy", 7])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid ingredient tags")
        self.assertEqual(IngredientTag.objects.filter(user=self.user).count(), 0)
        self.ingredient.refresh_from_db()
        self.assertEqual(self.ingredient.name, "Butter")
        self.assertEqual(self.ingredient.edit_version, 0)

    def test_an_ingredient_that_is_not_the_callers_is_a_400(self):
        other = User.objects.create_user(
            email="ingredient-version-other@example.com",
            name="Other",
            password="a-long-test-passphrase-3344",
        )
        theirs = Ingredient.objects.create(
            user=other,
            name="Cream",
            normalized_name="cream",
            purchase_cost_cents=300,
            purchase_size=1,
            purchase_unit="qt",
        )
        response = self.save(id=str(theirs.id))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Ingredient not found")

    def test_the_row_is_locked_inside_the_transaction(self):
        from .domains.ingredients import actions as ingredient_actions

        real_bump = ingredient_actions.check_and_bump
        marks: dict[str, int] = {}

        with CaptureQueriesContext(connection) as captured:

            def bump(row, expected):
                marks["bump"] = len(connection.queries)
                return real_bump(row, expected)

            with patch.object(ingredient_actions, "check_and_bump", bump):
                response = self.save(expectedEditVersion=0)

        self.assertEqual(response.status_code, 200, response.content)
        # select_for_update() itself refuses to run outside a transaction, so
        # what this pins is that the read the bump follows is of the row.
        read = captured.captured_queries[marks["bump"] - 1]["sql"]
        self.assertIn('"forkluck_ingredient"', read.lower())


class IngredientAllergenAtomicityTests(InternalApiTestCase):
    """The tag list replaces the stored one whole, or not at all."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="allergens@example.com",
            name="Label Reader",
            password="a-long-test-passphrase-5566",
        )
        self.ingredient = Ingredient.objects.create(
            user=self.user,
            name="Peanut butter",
            normalized_name="peanut butter",
            purchase_cost_cents=500,
        )
        IngredientAllergenOverride.objects.create(
            ingredient=self.ingredient, allergen="peanut", status="contains"
        )
        self.client = Client()
        self.client.force_login(self.user)

    def stored(self):
        return sorted(
            IngredientAllergenOverride.objects.filter(
                ingredient=self.ingredient
            ).values_list("allergen", flat=True)
        )

    def test_a_write_that_cannot_finish_leaves_the_stored_tags_alone(self):
        from .domains.ingredients import actions as ingredient_actions

        with patch.object(
            IngredientAllergenOverride.objects,
            "bulk_create",
            side_effect=RuntimeError("no room"),
        ):
            with self.assertRaises(RuntimeError):
                ingredient_actions.action_replace_ingredient_allergens(
                    self.user,
                    {
                        "ingredientId": str(self.ingredient.id),
                        "allergens": [{"key": "milk", "status": "contains"}],
                    },
                )
        self.assertEqual(self.stored(), ["peanut"])

    def test_a_write_that_finishes_replaces_them(self):
        response = self.post_internal(
            "replace-ingredient-allergens",
            {
                "ingredientId": str(self.ingredient.id),
                "allergens": [{"key": "milk", "status": "contains"}],
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.stored(), ["milk"])
