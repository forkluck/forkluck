import json
import tempfile
from pathlib import Path
from unittest import mock

from django.conf import settings
from django.contrib import admin
from django.contrib.auth.models import Permission
from django.core.management import call_command
from django.test import Client, TestCase, override_settings

from .integrations.emails import EmailNotConfigured
from .master_prices import MasterPrice
from .mommy import MommyAdminSite
from .models import (
    BenchCostRecipe,
    EmailVerificationCode,
    Ingredient,
    IngredientImport,
    IngredientMeasure,
    IngredientPrice,
    Recipe,
    RecipeCategory,
    RecipeItem,
    SupplierItem,
    User,
)
from .testing import InternalApiTestCase


# What a deployed box has after `sync_catalog`: registration seeds from the
# catalog, so the tests that watch a new workspace need one loaded. Bay leaf
# is here to stay out of the pantry: the sample recipe does not call for it,
# and the pantry follows the recipe.
STARTER_CATALOG = (
    "id,name,synonyms,allergens,preparation,yield,grams,volume,each,"
    "estimated,source\n"
    "buttermilk,Buttermilk,,milk,,,245,1 cup,,no,usda:173441\n"
    "flour-cake,Cake flour,,wheat,,,114,1 cup,,no,usda:168895\n"
    "bay-leaf,Bay leaf,,,,,1.8,1 tsp,,no,usda:170917\n"
)


class ForkluckApiTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.client = Client(enforce_csrf_checks=True)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "catalog.csv"
        path.write_text(STARTER_CATALOG)
        call_command("sync_catalog", path, verbosity=0)

    def csrf(self) -> str:
        response = self.client.get("/api/auth/csrf")
        self.assertEqual(response.status_code, 200)
        return response.cookies[settings.CSRF_COOKIE_NAME].value

    def post_public(self, path: str, body: dict):
        token = self.csrf()
        return self.client.post(
            path,
            data=json.dumps(body),
            content_type="application/json",
            HTTP_X_CSRFTOKEN=token,
        )

    def register(self):
        return self.post_public(
            "/api/auth/register",
            {
                "name": "Test Chef",
                "email": "chef@example.com",
                "password": "a-long-test-passphrase-2468",
            },
        )

    def test_registration_creates_session_and_seed_workspace(self):
        response = self.register()
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["user"]["email"], "chef@example.com")
        self.assertEqual(User.objects.count(), 1)
        registered_user = User.objects.get()
        self.assertIsNone(registered_user.email_verified_at)
        self.assertTrue(registered_user.first_sign_in_notification_pending)
        self.assertEqual(Recipe.objects.count(), 1)
        self.assertEqual(BenchCostRecipe.objects.count(), 1)
        buttermilk = Ingredient.objects.get(normalized_name="buttermilk")
        self.assertEqual(buttermilk.catalog_ingredient.normalized_name, "buttermilk")
        self.assertEqual(float(buttermilk.conversion.weight_amount), 245)
        self.assertEqual(buttermilk.conversion.weight_unit, "g")
        self.assertEqual(float(buttermilk.conversion.volume_amount), 1)
        self.assertEqual(buttermilk.conversion.volume_unit, "cup")
        self.assertEqual(buttermilk.conversion.source, "catalog")
        self.assertIsNone(buttermilk.conversion.each_amount)
        self.assertEqual(IngredientPrice.objects.count(), 0)

        session = self.client.get("/api/auth/session")
        self.assertEqual(session.status_code, 200)
        self.assertEqual(session.json()["user"]["name"], "Test Chef")

    def test_registration_stocks_the_pantry_from_the_sample_cake(self):
        self.assertEqual(self.register().status_code, 201)
        recipe = Recipe.objects.get(code="RCP-0001")

        self.assertEqual(recipe.title, "Buttermilk Cake")
        self.assertEqual(recipe.steps.count(), 6)
        items = list(recipe.items.order_by("position"))
        self.assertEqual(len(items), 9)
        # The pantry is exactly the lines this test catalog knows, so those two
        # link; the seven it has no row for wait for the cook to pull them in.
        self.assertEqual(
            sorted(
                Ingredient.objects.filter(user__email="chef@example.com").values_list(
                    "normalized_name", flat=True
                )
            ),
            ["buttermilk", "cake flour"],
        )
        self.assertEqual(items[0].ingredient.normalized_name, "cake flour")
        self.assertEqual(items[5].ingredient.normalized_name, "buttermilk")
        self.assertEqual(
            [item.ingredient_id for item in items if item.position not in (0, 5)],
            [None] * 7,
        )
        self.assertEqual(items[0].preparation_note, "sifted")

    def test_registration_leaves_a_starter_the_cake_does_not_call_for(self):
        self.assertEqual(self.register().status_code, 201)

        self.assertFalse(Ingredient.objects.filter(normalized_name="bay leaf").exists())

    def test_reset_restores_the_catalog_conversion_and_is_tenant_scoped(self):
        self.assertEqual(self.register().status_code, 201)
        buttermilk = Ingredient.objects.get(
            user__email="chef@example.com", normalized_name="buttermilk"
        )

        buttermilk.conversion.source = "user"
        buttermilk.conversion.weight_amount = None
        buttermilk.conversion.weight_unit = ""
        buttermilk.conversion.volume_amount = None
        buttermilk.conversion.volume_unit = ""
        buttermilk.conversion.save()
        reset = self.post_internal(
            "reset-ingredient-conversion", {"ingredientId": str(buttermilk.id)}
        )
        self.assertEqual(reset.status_code, 200)
        buttermilk.conversion.refresh_from_db()
        self.assertEqual(float(buttermilk.conversion.weight_amount), 245)
        self.assertEqual(buttermilk.conversion.weight_unit, "g")
        self.assertEqual(float(buttermilk.conversion.volume_amount), 1)
        self.assertEqual(buttermilk.conversion.volume_unit, "cup")
        self.assertEqual(buttermilk.conversion.source, "catalog")

        other_user = User.objects.create_user(
            email="other@example.com",
            password="a-long-test-passphrase-2468",
            name="Other Chef",
        )
        other_ingredient = Ingredient.objects.create(
            user=other_user,
            name="Private",
            normalized_name="private",
            purchase_cost_cents=0,
        )
        denied = self.post_internal(
            "reset-ingredient-conversion",
            {"ingredientId": str(other_ingredient.id)},
        )
        self.assertEqual(denied.status_code, 400)
        self.assertEqual(denied.json()["error"], "Ingredient not found")

    def test_registration_requires_csrf_and_unique_email(self):
        missing_csrf = self.client.post(
            "/api/auth/register",
            data=json.dumps(
                {
                    "name": "Test Chef",
                    "email": "chef@example.com",
                    "password": "a-long-test-passphrase-2468",
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(missing_csrf.status_code, 403)

        self.assertEqual(self.register().status_code, 201)
        duplicate = self.register()
        self.assertEqual(duplicate.status_code, 400)
        self.assertIn("already exists", duplicate.json()["error"])

    def test_master_prices_are_narrowly_searched_and_explicitly_adopted(self):
        from .domains.ingredients import actions as ingredient_actions

        flour = MasterPrice(
            "00000000-0000-4000-8000-000000000001",
            "Test Flour",
            100,
            1,
            "kg",
        )
        bread = MasterPrice(
            "00000000-0000-4000-8000-000000000002",
            "Test Bread Flour",
            200,
            1,
            "kg",
        )
        prices = {flour.id: flour, bread.id: bread}
        names = {price.normalized_name: price for price in prices.values()}
        with (
            mock.patch.dict(ingredient_actions.MASTER_PRICES_BY_ID, prices, clear=True),
            mock.patch.dict(
                ingredient_actions.MASTER_PRICES_BY_NAME, names, clear=True
            ),
        ):
            self._assert_master_price_flow(flour, bread)

    def _assert_master_price_flow(self, flour_price, bread):
        self.register()
        too_short = self.post_internal("search-master-prices", {"query": "fl"})
        self.assertEqual(too_short.status_code, 400)

        searched = self.post_internal("search-master-prices", {"query": "flour"})
        self.assertEqual(searched.status_code, 200)
        self.assertLessEqual(len(searched.json()["items"]), 5)
        self.assertTrue(
            all(item["source"] == "master" for item in searched.json()["items"])
        )
        self.assertEqual(Ingredient.objects.count(), 2)

        matched = self.post_internal(
            "match-master-prices",
            {"names": ["Test Flour", "Unmatched flour", "flour"]},
        )
        self.assertEqual(matched.status_code, 200)
        self.assertEqual(
            [item["name"] for item in matched.json()["items"]],
            ["Test Flour"],
        )
        bulk = self.post_internal(
            "match-master-prices",
            {"names": [f"Ingredient {index}" for index in range(13)]},
        )
        self.assertEqual(bulk.status_code, 400)

        dismissed = self.post_internal(
            "dismiss-master-price", {"masterPriceId": bread.id}
        )
        self.assertEqual(dismissed.status_code, 200)
        hidden = self.post_internal("search-master-prices", {"query": "bread"})
        self.assertEqual(hidden.status_code, 200)
        self.assertEqual(hidden.json()["items"], [])

        adopted = self.post_internal(
            "adopt-master-price", {"masterPriceId": flour_price.id}
        )
        self.assertEqual(adopted.status_code, 200)
        flour = Ingredient.objects.get(id=adopted.json()["id"])
        self.assertEqual(flour.price_source, Ingredient.PriceSource.MASTER)
        self.assertEqual(Ingredient.objects.count(), 3)
        self.assertEqual(IngredientPrice.objects.count(), 1)

        updated = self.post_internal(
            "save-ingredient",
            {
                "id": str(flour.id),
                "name": flour.name,
                "purchaseCostCents": 2250,
                "purchaseSize": 25,
                "purchaseUnit": "lb",
            },
        )
        self.assertEqual(updated.status_code, 200)
        flour.refresh_from_db()
        self.assertEqual(flour.purchase_cost_cents, 2250)
        self.assertEqual(flour.price_source, Ingredient.PriceSource.USER)

    def test_master_price_search_is_rate_limited_per_account(self):
        self.register()
        for _ in range(20):
            response = self.post_internal("search-master-prices", {"query": "flour"})
            self.assertEqual(response.status_code, 200)
        blocked = self.post_internal("search-master-prices", {"query": "flour"})
        self.assertEqual(blocked.status_code, 400)
        self.assertIn("Too many", blocked.json()["error"])

    def test_match_is_account_wide_only_after_explicit_save(self):
        self.register()
        user = User.objects.get(email="chef@example.com")
        ingredient = Ingredient.objects.create(
            user=user,
            name="All-Purpose Flour",
            normalized_name="all purpose flour",
            purchase_cost_cents=2790,
            purchase_size=50,
            purchase_unit="lb",
        )
        before = self.client.get(
            "/internal/v1/matches/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        ).json()["items"]
        self.assertEqual(before, [])

        linked = self.post_internal(
            "save-recipe-line-match",
            {
                "line": "AP flour",
                "targetId": str(ingredient.id),
                "targetKind": "ingredient",
            },
        )
        self.assertEqual(linked.status_code, 200)
        matches = self.client.get(
            "/internal/v1/matches/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        ).json()["items"]
        self.assertEqual(
            matches,
            [
                {
                    "line": "AP flour",
                    "targetId": str(ingredient.id),
                    "targetName": "All-Purpose Flour",
                    "targetKind": "ingredient",
                    "source": "user",
                }
            ],
        )

    def test_internal_api_requires_secret_and_authenticated_session(self):
        no_secret = self.client.get("/internal/v1/recipes/")
        self.assertEqual(no_secret.status_code, 404)

        anonymous = Client().get(
            "/internal/v1/recipes/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )
        self.assertEqual(anonymous.status_code, 401)

        self.register()
        response = self.client.get(
            "/internal/v1/recipes/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["items"]), 1)

    @override_settings(FORKLUCK_ALLOW_DEMO_ACCOUNT=False)
    def test_demo_login_is_blocked_when_demo_accounts_are_disabled(self):
        User.objects.create_user(email="user@user.com", name="Demo", password="user")
        response = self.post_public(
            "/api/auth/login",
            {"email": "user@user.com", "password": "user"},
        )
        self.assertEqual(response.status_code, 401)

    def test_update_account_renames_the_user_and_rejects_a_blank_name(self):
        self.register()
        user = User.objects.get(email="chef@example.com")
        self.assertEqual(user.name, "Test Chef")

        renamed = self.post_internal("update-account", {"name": "  Head Chef  "})
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(renamed.json()["name"], "Head Chef")
        user.refresh_from_db()
        self.assertEqual(user.name, "Head Chef")

        blank = self.post_internal("update-account", {"name": "   "})
        self.assertEqual(blank.status_code, 400)
        user.refresh_from_db()
        self.assertEqual(user.name, "Head Chef")

        # Email is the sign-in identifier; this action must never touch it.
        self.assertEqual(user.email, "chef@example.com")

    def test_the_newsletter_row_reads_and_writes_through_ghost(self):
        self.register()

        with mock.patch(
            "forkluck.domains.accounts.views.newsletter_configured",
            return_value=False,
        ):
            unconfigured = self.get_internal("newsletter/")
        self.assertEqual(unconfigured.json(), {"enabled": None, "available": False})

        with (
            mock.patch(
                "forkluck.domains.accounts.views.newsletter_configured",
                return_value=True,
            ),
            mock.patch(
                "forkluck.domains.accounts.views.newsletter_status",
                return_value=False,
            ),
        ):
            configured = self.get_internal("newsletter/")
        self.assertEqual(configured.json(), {"enabled": False, "available": True})

        with (
            mock.patch(
                "forkluck.domains.accounts.actions.set_newsletter",
                return_value=True,
            ) as write,
            mock.patch(
                "forkluck.domains.accounts.actions.newsletter_status",
                return_value=True,
            ),
        ):
            subscribed = self.post_internal("set-newsletter", {"enabled": True})
        self.assertEqual(subscribed.status_code, 200)
        self.assertEqual(subscribed.json(), {"enabled": True})
        write.assert_called_once_with("chef@example.com", True, "Test Chef")

        with mock.patch(
            "forkluck.domains.accounts.actions.set_newsletter", return_value=False
        ):
            failed = self.post_internal("set-newsletter", {"enabled": False})
        self.assertEqual(failed.status_code, 400)
        self.assertEqual(
            failed.json()["error"], "Couldn't update your newsletter preference"
        )

        missing = self.post_internal("set-newsletter", {})
        self.assertEqual(missing.status_code, 400)

    def test_recipe_ingredient_and_cost_lifecycle(self):
        self.register()

        ingredient = self.post_internal(
            "save-ingredient",
            {
                "id": None,
                "name": "Bread Flour",
                "purchaseCostCents": 2100,
                "purchaseSize": 25,
                "purchaseUnit": "lb",
            },
        )
        self.assertEqual(ingredient.status_code, 200)
        ingredient_id = ingredient.json()["id"]

        pantry = self.client.get(
            "/internal/v1/ingredients/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        ).json()["items"]
        bread_flour = next(item for item in pantry if item["id"] == ingredient_id)
        self.assertEqual(bread_flour["purchaseSize"], 25.0)
        self.assertEqual(bread_flour["purchaseUnit"], "lb")
        self.assertEqual(bread_flour["priceSource"], "user")
        detail = self.client.get(
            f"/internal/v1/ingredients/{bread_flour['publicId']}/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        ).json()["item"]
        self.assertEqual(len(detail["priceHistory"]), 1)
        self.assertEqual(detail["priceHistory"][0]["purchaseCostCents"], 2100)

        changed = self.post_internal(
            "save-ingredient",
            {
                "id": ingredient_id,
                "name": "Bread Flour",
                "purchaseCostCents": 2400,
                "purchaseSize": 25,
                "purchaseUnit": "lb",
            },
        )
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(
            IngredientPrice.objects.filter(ingredient_id=ingredient_id).count(), 2
        )

        renamed = self.post_internal(
            "save-ingredient",
            {
                "id": ingredient_id,
                "name": "Strong Bread Flour",
                "purchaseCostCents": 2400,
                "purchaseSize": 25,
                "purchaseUnit": "lb",
            },
        )
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(
            IngredientPrice.objects.filter(ingredient_id=ingredient_id).count(), 2
        )

        pantry = self.client.get(
            "/internal/v1/ingredients/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        ).json()["items"]
        bread_flour = next(item for item in pantry if item["id"] == ingredient_id)
        bread_flour_detail = self.client.get(
            f"/internal/v1/ingredients/{bread_flour['publicId']}/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        ).json()["item"]
        self.assertEqual(
            [
                point["purchaseCostCents"]
                for point in bread_flour_detail["priceHistory"]
            ],
            [2400, 2100],
        )

        recipe = self.post_internal(
            "save-recipe",
            {
                "id": None,
                "title": "Country loaf",
                "body": "500 g Bread Flour\n350 g Water",
                "yieldAmount": 1,
                "yieldUnit": "pcs",
                "menuPriceCents": 1200,
                "category": "  Bakery  ",
            },
        )
        self.assertEqual(recipe.status_code, 200)
        recipe_id = recipe.json()["id"]

        recipes = self.client.get(
            "/internal/v1/recipes/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        ).json()["items"]
        saved_recipe = next(item for item in recipes if item["id"] == recipe_id)
        self.assertEqual(saved_recipe["category"], "Bakery")

        opened = self.post_internal("open-cost-for-recipe", {"recipeId": recipe_id})
        self.assertEqual(opened.status_code, 200)
        cost_id = opened.json()["id"]

        step = self.post_internal(
            "create-step",
            {
                "recipeId": cost_id,
                "input": {"name": "Mix", "kind": "active", "covers": 1},
            },
        )
        self.assertEqual(step.status_code, 200)
        timing = self.post_internal(
            "add-timing",
            {"stepId": step.json()["id"], "seconds": 90, "yieldCount": 45},
        )
        self.assertEqual(timing.status_code, 200)

        detail = self.client.get(
            f"/internal/v1/cost-recipes/{cost_id}/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        ).json()["item"]
        self.assertEqual(detail["steps"][0]["timings"][0]["seconds"], 90)
        self.assertEqual(detail["steps"][0]["timings"][0]["yieldCount"], 45)

    def test_recipe_ingredients_and_method_are_separate_fields(self):
        self.register()

        created = self.post_internal(
            "save-recipe",
            {
                "id": None,
                "title": "Split loaf",
                "body": "500 g Bread Flour\n350 g Water",
                "method": "Mix, rest, then bake.",
                "yieldUnit": "pcs",
            },
        )
        self.assertEqual(created.status_code, 200)
        recipe_id = created.json()["id"]

        def load() -> dict:
            recipes = self.client.get(
                "/internal/v1/recipes/",
                HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
            ).json()["items"]
            return next(item for item in recipes if item["id"] == recipe_id)

        saved = load()
        # The ingredient text stays in `body`; the method is stored verbatim
        # rather than being folded back into the ingredient blob.
        self.assertEqual(saved["body"], "500 g Bread Flour\n350 g Water")
        self.assertEqual(saved["method"], "Mix, rest, then bake.")

        updated = self.post_internal(
            "save-recipe",
            {
                "id": recipe_id,
                "title": "Split loaf",
                "body": "500 g Bread Flour\n360 g Water",
                "method": "Autolyse, fold, proof, bake hot.",
                "yieldUnit": "pcs",
            },
        )
        self.assertEqual(updated.status_code, 200)
        reloaded = load()
        self.assertEqual(reloaded["body"], "500 g Bread Flour\n360 g Water")
        self.assertEqual(reloaded["method"], "Autolyse, fold, proof, bake hot.")

        # Missing Method is stored as blank text; there is no second legacy
        # interpretation of the Ingredients field.
        missing_method = self.post_internal(
            "save-recipe",
            {
                "id": recipe_id,
                "title": "Split loaf",
                "body": "500 g Bread Flour\n360 g Water",
                "yieldUnit": "pcs",
            },
        )
        self.assertEqual(missing_method.status_code, 200)
        self.assertEqual(load()["method"], "")

        split_blank = self.post_internal(
            "save-recipe",
            {
                "id": recipe_id,
                "title": "Split loaf",
                "body": "500 g Bread Flour\n360 g Water",
                "method": "",
                "yieldUnit": "pcs",
            },
        )
        self.assertEqual(split_blank.status_code, 200)
        self.assertEqual(load()["method"], "")

    def test_recipe_catalog_codes_status_and_external_refs(self):
        self.register()

        first = self.post_internal(
            "save-recipe",
            {"id": None, "title": "Country loaf", "body": "", "yieldUnit": "pcs"},
        )
        self.assertEqual(first.status_code, 200)
        first_id = first.json()["id"]

        # The workspace seed recipe holds RCP-0001; new recipes continue on.
        detail = self.client.get(
            f"/internal/v1/recipes/{first_id}/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        ).json()["item"]
        self.assertEqual(detail["code"], "RCP-0002")
        self.assertEqual(detail["status"], "active")
        self.assertEqual(detail["externalRefs"], [])

        # The globally unique public id is the canonical URL identifier.
        self.assertTrue(detail["publicId"].startswith("rcp_"))
        by_public_id = self.client.get(
            f"/internal/v1/recipes/{detail['publicId']}/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        ).json()["item"]
        self.assertEqual(by_public_id["id"], first_id)

        duplicate_code = self.post_internal(
            "save-recipe",
            {
                "id": None,
                "title": "Second loaf",
                "body": "",
                "yieldUnit": "pcs",
                "code": "RCP-0002",
            },
        )
        self.assertEqual(duplicate_code.status_code, 400)

        archived = self.post_internal(
            "update-recipe-statuses", {"recipeIds": [first_id], "status": "archived"}
        )
        self.assertEqual(archived.status_code, 200)
        overview = self.client.get(
            "/internal/v1/menu-overview/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        ).json()
        self.assertNotIn(first_id, [recipe["id"] for recipe in overview["recipes"]])

        invalid_status = self.post_internal(
            "update-recipe-statuses", {"recipeIds": [first_id], "status": "hidden"}
        )
        self.assertEqual(invalid_status.status_code, 400)

        linked = self.post_internal(
            "save-recipe-external-ref",
            {
                "recipeId": first_id,
                "system": "square",
                "refKind": "item",
                "externalId": "ADOD4UTPSIZBNDYJ37HZTDUM",
            },
        )
        self.assertEqual(linked.status_code, 200)
        detail = self.client.get(
            f"/internal/v1/recipes/{first_id}/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        ).json()["item"]
        self.assertEqual(len(detail["externalRefs"]), 1)
        self.assertEqual(detail["externalRefs"][0]["system"], "square")

        removed = self.post_internal(
            "delete-recipe-external-ref", {"id": detail["externalRefs"][0]["id"]}
        )
        self.assertEqual(removed.status_code, 200)

    def test_recipe_category_rename_merges_and_updates_recipes(self):
        self.register()

        recipe = self.post_internal(
            "save-recipe",
            {
                "id": None,
                "title": "Sourdough",
                "body": "",
                "yieldUnit": "pcs",
                "category": "Breads",
            },
        )
        self.assertEqual(recipe.status_code, 200)
        recipe_id = recipe.json()["id"]

        renamed = self.post_internal(
            "rename-recipe-category", {"currentName": "Breads", "name": "Bread"}
        )
        self.assertEqual(renamed.status_code, 200)
        detail = self.client.get(
            f"/internal/v1/recipes/{recipe_id}/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        ).json()["item"]
        self.assertEqual(detail["category"], "Bread")

        deleted = self.post_internal("delete-recipe-category", {"name": "Bread"})
        self.assertEqual(deleted.status_code, 200)
        detail = self.client.get(
            f"/internal/v1/recipes/{recipe_id}/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        ).json()["item"]
        self.assertIsNone(detail["category"])

    def test_recipe_categories_list_counts_only_this_tenant(self):
        self.register()
        self.post_internal(
            "save-recipe",
            {
                "id": None,
                "title": "Sourdough",
                "body": "",
                "yieldUnit": "pcs",
                "category": "Breads",
            },
        )
        mine = User.objects.get(email="chef@example.com")
        breads = RecipeCategory.objects.get(user=mine, normalized_name="breads")
        RecipeCategory.objects.create(
            user=mine, name="Pastry", normalized_name="pastry"
        )
        other = User.objects.create_user(
            email="other-tenant@example.com",
            name="Other",
            password="a-long-test-passphrase-2468",
        )
        # Another tenant's recipe filed under this category must not be counted.
        Recipe.objects.create(user=other, title="Baguette", body="", category=breads)

        items = self.get_internal("recipe-categories/").json()["items"]
        self.assertEqual(
            [(row["name"], row["count"]) for row in items],
            [("Breads", 1), ("Pastry", 0)],
        )

    def test_user_cannot_access_another_users_recipe(self):
        owner = User.objects.create_user(
            email="owner@example.com", name="Owner", password="owner-passphrase-2468"
        )
        recipe = Recipe.objects.create(user=owner, title="Private", body="")
        self.register()

        response = self.client.get(
            f"/internal/v1/recipes/{recipe.id}/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["item"])

    def test_supplier_import_stores_volume_and_count_packs_without_grams(self):
        """A pack is priced by what it was bought by.

        A case of gallons and a case of pieces have no weight of their own —
        only the ingredient's conversions know that — so `pack_grams` is null
        and the price still lands. The snapshot the undo history writes has to
        carry that null back through restore.
        """
        self.register()
        entries = [
            {
                "supplier": "harbor",
                "externalId": "soda",
                "name": "Club Soda",
                "rawSize": "24 X 150 ML",
                "quantity": 1,
                "packAmount": 3600,
                "packUnit": "ml",
                "packPriceCents": 2159,
                "periodStart": None,
                "periodEnd": None,
                "preferred": True,
            },
            {
                "supplier": "harbor",
                "externalId": "scallion",
                "name": "Scallions",
                "rawSize": "4X12 CT",
                "quantity": 1,
                "packAmount": 48,
                "packUnit": "each",
                "packPriceCents": 2825,
                "periodStart": None,
                "periodEnd": None,
                "preferred": True,
            },
        ]
        imported = self.post_internal(
            "import-ingredients",
            {
                "entries": entries,
                "ignored": [],
                "fileName": "packs.xlsx",
                "totalRows": 2,
                "reviewCount": 0,
            },
        )
        self.assertEqual(imported.status_code, 200)
        user = User.objects.get(email="chef@example.com")
        soda = SupplierItem.objects.get(user=user, external_id="soda")
        self.assertIsNone(soda.pack_grams)
        self.assertEqual(soda.pack_unit, "ml")
        self.assertEqual(soda.pack_amount, 3600)
        self.assertEqual(soda.ingredient.purchase_unit, "ml")
        self.assertEqual(soda.ingredient.purchase_cost_cents, 2159)
        scallions = SupplierItem.objects.get(user=user, external_id="scallion")
        self.assertIsNone(scallions.pack_grams)
        self.assertEqual(scallions.pack_unit, "each")

        repriced = self.post_internal(
            "import-ingredients",
            {
                "entries": [{**entries[0], "packPriceCents": 2400}],
                "ignored": [],
                "fileName": "packs-again.xlsx",
                "totalRows": 1,
                "reviewCount": 0,
            },
        )
        self.assertEqual(repriced.status_code, 200)
        undone = self.post_internal(
            "undo-ingredient-import", {"id": repriced.json()["batchId"]}
        )
        self.assertEqual(undone.status_code, 200)
        soda.refresh_from_db()
        self.assertIsNone(soda.pack_grams)
        self.assertEqual(soda.pack_price_cents, 2159)

    def test_supplier_import_refuses_a_unit_outside_the_purchase_vocabulary(self):
        self.register()
        refused = self.post_internal(
            "import-ingredients",
            {
                "entries": [
                    {
                        "supplier": "harbor",
                        "externalId": "bushel",
                        "name": "Apples",
                        "rawSize": "1 BU",
                        "quantity": 1,
                        "packAmount": 1,
                        "packUnit": "bushel",
                        "packPriceCents": 1000,
                        "periodStart": None,
                        "periodEnd": None,
                        "preferred": True,
                    }
                ],
                "ignored": [],
                "fileName": "bushels.xlsx",
                "totalRows": 1,
                "reviewCount": 0,
            },
        )
        self.assertEqual(refused.status_code, 400)
        self.assertIn("Unsupported pack unit", refused.json()["error"])

    def test_supplier_import_preserves_skus_and_updates_the_preferred_pack(self):
        self.register()
        entries = [
            {
                "supplier": "harbor",
                "externalId": "a1",
                "name": "Baby Arugula",
                "rawSize": "3 LB",
                "quantity": 2,
                "packAmount": 3,
                "packUnit": "lb",
                "packPriceCents": 1775,
                "periodStart": "2025-07-01",
                "periodEnd": "2026-08-06",
                "preferred": False,
            },
            {
                "supplier": "harbor",
                "externalId": "a3",
                "name": "Baby Arugula",
                "rawSize": "4 LB",
                "quantity": 6,
                "packAmount": 4,
                "packUnit": "lb",
                "packPriceCents": 1925,
                "periodStart": "2025-07-01",
                "periodEnd": "2026-08-06",
                "preferred": True,
            },
        ]

        imported = self.post_internal("import-ingredients", {"entries": entries})
        self.assertEqual(imported.status_code, 200)
        self.assertEqual(imported.json()["imported"], 2)
        self.assertEqual(imported.json()["created"], 2)
        self.assertEqual(imported.json()["updated"], 0)
        self.assertIsNotNone(imported.json()["batchId"])

        user = User.objects.get(email="chef@example.com")
        ingredient = Ingredient.objects.get(user=user, normalized_name="baby arugula")
        self.assertEqual(ingredient.purchase_cost_cents, 1925)
        self.assertEqual(ingredient.purchase_size, 4)
        self.assertEqual(SupplierItem.objects.filter(user=user).count(), 2)
        self.assertEqual(
            SupplierItem.objects.get(user=user, is_preferred=True).external_id,
            "a3",
        )

        status = self.post_internal(
            "supplier-import-status",
            {"supplier": "harbor", "externalIds": ["a1", "a3", "new"]},
        )
        self.assertEqual(set(status.json()["existingIds"]), {"a1", "a3"})

        entries[1]["packPriceCents"] = 2000
        refreshed = self.post_internal("import-ingredients", {"entries": entries})
        self.assertEqual(refreshed.json()["imported"], 2)
        self.assertEqual(refreshed.json()["created"], 0)
        self.assertEqual(refreshed.json()["updated"], 2)
        ingredient.refresh_from_db()
        self.assertEqual(ingredient.purchase_cost_cents, 2000)
        self.assertEqual(SupplierItem.objects.filter(user=user).count(), 2)
        self.assertEqual(
            IngredientPrice.objects.filter(ingredient=ingredient).count(), 3
        )

        pantry = self.client.get(
            "/internal/v1/ingredients/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        ).json()["items"]
        imported_row = next(row for row in pantry if row["id"] == str(ingredient.id))
        detail = self.client.get(
            f"/internal/v1/ingredients/{imported_row['publicId']}/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        ).json()["item"]
        self.assertEqual(detail["supplierItems"][0]["externalId"], "a3")
        self.assertTrue(detail["supplierItems"][0]["isPreferred"])

        preferred = self.post_internal(
            "set-preferred-supplier-item",
            {"id": str(SupplierItem.objects.get(user=user, external_id="a1").id)},
        )
        self.assertEqual(preferred.status_code, 200)
        ingredient.refresh_from_db()
        self.assertEqual(ingredient.purchase_cost_cents, 1775)
        self.assertTrue(
            SupplierItem.objects.get(user=user, external_id="a1").is_preferred
        )

    def test_import_receipt_ignored_items_and_undo(self):
        self.register()
        ignored = self.post_internal(
            "import-ingredients",
            {
                "entries": [],
                "ignored": [
                    {
                        "supplier": "harbor",
                        "externalId": "skip-1",
                        "name": "Club Soda",
                        "rawSize": "24 X 150 ML",
                    }
                ],
                "fileName": "harbor.xlsx",
                "source": {
                    "supplier": "harbor",
                    "periodStart": "2026-08-01",
                    "periodEnd": "2026-08-07",
                },
                "totalRows": 1,
                "reviewCount": 0,
            },
        )
        self.assertEqual(ignored.status_code, 200)
        self.assertEqual(ignored.json()["ignored"], 1)
        ignored_batch_id = ignored.json()["batchId"]
        status = self.post_internal(
            "supplier-import-status",
            {"supplier": "harbor", "externalIds": ["skip-1"]},
        )
        self.assertEqual(status.json()["ignoredIds"], ["skip-1"])

        entry = {
            "supplier": "harbor",
            "externalId": "undo-1",
            "name": "Undo Parsley",
            "rawSize": "1 LB",
            "quantity": 1,
            "packAmount": 1,
            "packUnit": "lb",
            "packPriceCents": 600,
            "periodStart": None,
            "periodEnd": None,
            "preferred": True,
            "ingredientId": None,
        }
        imported = self.post_internal(
            "import-ingredients",
            {
                "entries": [entry],
                "ignored": [],
                "fileName": "undo.xlsx",
                "totalRows": 1,
                "reviewCount": 0,
            },
        )
        self.assertEqual(imported.status_code, 200)
        batch_id = imported.json()["batchId"]

        history = self.client.get(
            "/internal/v1/ingredient-imports/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        ).json()["items"]
        self.assertEqual(history[0]["fileName"], "undo.xlsx")
        self.assertTrue(history[0]["canUndo"])
        self.assertFalse(history[1]["canUndo"])

        undone = self.post_internal("undo-ingredient-import", {"id": batch_id})
        self.assertEqual(undone.status_code, 200)
        self.assertEqual(undone.json()["deletedSupplierItems"], 1)
        self.assertFalse(SupplierItem.objects.filter(external_id="undo-1").exists())
        self.assertFalse(Ingredient.objects.filter(name="Undo Parsley").exists())
        self.assertIsNotNone(IngredientImport.objects.get(id=batch_id).undone_at)

        measured_entry = {**entry, "externalId": "undo-2", "name": "Measured Parsley"}
        measured_import = self.post_internal(
            "import-ingredients",
            {
                "entries": [measured_entry],
                "ignored": [],
                "fileName": "undo-measured.xlsx",
                "totalRows": 1,
                "reviewCount": 0,
            },
        )
        user = User.objects.get(email="chef@example.com")
        measured = Ingredient.objects.get(user=user, name="Measured Parsley")
        IngredientMeasure.objects.create(
            ingredient=measured, unit="cup", amount=1, grams=30, qualifier=""
        )

        undone_measured = self.post_internal(
            "undo-ingredient-import", {"id": measured_import.json()["batchId"]}
        )
        self.assertEqual(undone_measured.status_code, 200)
        self.assertEqual(undone_measured.json()["deletedSupplierItems"], 1)
        self.assertEqual(undone_measured.json()["retainedIngredients"], 1)
        self.assertTrue(Ingredient.objects.filter(id=measured.id).exists())
        self.assertTrue(IngredientMeasure.objects.filter(ingredient=measured).exists())
        measured.refresh_from_db()
        self.assertEqual(measured.purchase_cost_cents, 0)
        self.assertIsNone(measured.purchase_size)
        self.assertIsNone(measured.purchase_unit)
        self.assertFalse(measured.price_history.exists())

        normalized_entry = {
            **entry,
            "externalId": "undo-normalized",
            "name": "Normalized Parsley",
        }
        normalized_import = self.post_internal(
            "import-ingredients",
            {
                "entries": [normalized_entry],
                "ignored": [],
                "fileName": "undo-normalized.xlsx",
                "totalRows": 1,
                "reviewCount": 0,
            },
        )
        normalized = Ingredient.objects.get(user=user, name="Normalized Parsley")
        normalized_recipe = Recipe.objects.create(user=user, title="Parsley sauce")
        RecipeItem.objects.create(
            recipe=normalized_recipe,
            kind=RecipeItem.INGREDIENT,
            ingredient=normalized,
            display_name=normalized.name,
            quantity=1,
            unit="g",
        )
        undone_normalized = self.post_internal(
            "undo-ingredient-import",
            {"id": normalized_import.json()["batchId"]},
        )
        self.assertEqual(undone_normalized.status_code, 200)
        self.assertEqual(undone_normalized.json()["retainedIngredients"], 1)
        self.assertTrue(Ingredient.objects.filter(id=normalized.id).exists())

        mapped_entry = {**entry, "externalId": "undo-3", "name": "Mapped Parsley"}
        mapped_import = self.post_internal(
            "import-ingredients",
            {
                "entries": [mapped_entry],
                "ignored": [],
                "fileName": "undo-mapped.xlsx",
                "totalRows": 1,
                "reviewCount": 0,
            },
        )
        mapped = Ingredient.objects.get(user=user, name="Mapped Parsley")
        profile = {
            "water": 85,
            "fat": 1,
            "protein": 3,
            "sugars": 1,
            "starch": 2,
            "fiber": 4,
            "salt": 0.1,
            "other": 3.9,
        }
        with mock.patch(
            "forkluck.domains.ingredients.actions.get_food",
            return_value=("Parsley, fresh", profile, ""),
        ):
            mapped_result = self.post_internal(
                "set-ingredient-nutrition",
                {"ingredientId": str(mapped.id), "fdcId": 123},
            )
        self.assertEqual(mapped_result.status_code, 200)

        undone_mapped = self.post_internal(
            "undo-ingredient-import", {"id": mapped_import.json()["batchId"]}
        )
        self.assertEqual(undone_mapped.status_code, 200)
        self.assertEqual(undone_mapped.json()["deletedSupplierItems"], 1)
        self.assertEqual(undone_mapped.json()["retainedIngredients"], 1)
        mapped.refresh_from_db()
        self.assertEqual(mapped.nutrition_source_id, "123")
        self.assertFalse(mapped.supplier_items.exists())

        # A conversion, preparation or allergen override is work done after
        # the import too, so each keeps the row exactly as saved nutrition does.
        for label, external_id, slug, body in (
            (
                "Converted Parsley",
                "undo-4",
                "save-ingredient-conversion",
                {
                    "usesStandardConversion": False,
                    "volume": {"amount": 4, "unit": "cup"},
                },
            ),
            (
                "Prepped Parsley",
                "undo-5",
                "save-preparation",
                {"name": "Chopped", "usesStandardConversion": True, "yieldPercent": 88},
            ),
            (
                "Allergen Parsley",
                "undo-6",
                "replace-ingredient-allergens",
                {"allergens": [{"key": "milk", "status": "contains"}]},
            ),
        ):
            batch = self.post_internal(
                "import-ingredients",
                {
                    "entries": [{**entry, "externalId": external_id, "name": label}],
                    "ignored": [],
                    "fileName": f"{external_id}.xlsx",
                    "totalRows": 1,
                    "reviewCount": 0,
                },
            )
            row = Ingredient.objects.get(user=user, name=label)
            saved = self.post_internal(slug, {"ingredientId": str(row.id), **body})
            self.assertEqual(saved.status_code, 200, slug)
            undone_row = self.post_internal(
                "undo-ingredient-import", {"id": batch.json()["batchId"]}
            )
            self.assertEqual(undone_row.status_code, 200)
            self.assertEqual(undone_row.json()["retainedIngredients"], 1, slug)
            self.assertTrue(Ingredient.objects.filter(id=row.id).exists(), slug)

        undone_ignored = self.post_internal(
            "undo-ingredient-import", {"id": ignored_batch_id}
        )
        self.assertEqual(undone_ignored.status_code, 200)
        status = self.post_internal(
            "supplier-import-status",
            {"supplier": "harbor", "externalIds": ["skip-1"]},
        )
        self.assertEqual(status.json()["ignoredIds"], [])

    def test_merge_ingredients_moves_supplier_products_and_history(self):
        self.register()
        user = User.objects.get(email="chef@example.com")
        source = Ingredient.objects.create(
            user=user,
            name="Arugula Baby",
            normalized_name="arugula baby",
            purchase_cost_cents=900,
            purchase_size=1,
            purchase_unit="kg",
        )
        target = Ingredient.objects.create(
            user=user,
            name="Baby Arugula",
            normalized_name="baby arugula",
            purchase_cost_cents=1200,
            purchase_size=1,
            purchase_unit="kg",
        )
        SupplierItem.objects.create(
            user=user,
            ingredient=source,
            supplier="harbor",
            external_id="merge-1",
            title=source.name,
            raw_size="1 KG",
            pack_price_cents=900,
            pack_grams=1000,
            pack_amount=1,
            pack_unit="kg",
            is_preferred=True,
        )
        IngredientPrice.objects.create(
            ingredient=source,
            purchase_cost_cents=900,
            purchase_size=1,
            purchase_unit="kg",
            effective_at=source.updated_at,
        )

        merged = self.post_internal(
            "merge-ingredients",
            {"sourceId": str(source.id), "targetId": str(target.id)},
        )
        self.assertEqual(merged.status_code, 200)
        self.assertFalse(Ingredient.objects.filter(id=source.id).exists())
        self.assertEqual(
            SupplierItem.objects.get(external_id="merge-1").ingredient_id,
            target.id,
        )
        self.assertTrue(IngredientPrice.objects.filter(ingredient=target).exists())

    def test_mommy_admin_route_exists(self):
        response = self.client.get("/mommy/")
        self.assertEqual(response.status_code, 302)
        self.assertIn("/mommy/login/", response.headers["Location"])


class EmailVerificationTests(TestCase):
    """Signup codes and the /mommy two-step, with the email sender stubbed."""

    def setUp(self) -> None:
        self.client = Client(enforce_csrf_checks=True)
        patcher = mock.patch("forkluck.verification.send_verification_code")
        self.send_code = patcher.start()
        self.addCleanup(patcher.stop)

    def csrf(self) -> str:
        response = self.client.get("/api/auth/csrf")
        return response.cookies[settings.CSRF_COOKIE_NAME].value

    def post_public(self, path: str, body: dict):
        token = self.csrf()
        return self.client.post(
            path,
            data=json.dumps(body),
            content_type="application/json",
            HTTP_X_CSRFTOKEN=token,
        )

    def last_code(self) -> str:
        return self.send_code.call_args.args[1]

    @override_settings(FORKLUCK_REQUIRE_EMAIL_VERIFICATION=True)
    def test_signup_requires_a_code_before_a_session_exists(self):
        registered = self.post_public(
            "/api/auth/register",
            {
                "name": "Chef",
                "email": "chef@example.com",
                "password": "a-long-test-passphrase-2468",
            },
        )
        self.assertEqual(registered.status_code, 202)
        self.assertTrue(registered.json()["pendingVerification"])
        self.assertEqual(self.client.get("/api/auth/session").status_code, 401)
        user = User.objects.get(email="chef@example.com")
        self.assertIsNone(user.email_verified_at)

        wrong = self.post_public(
            "/api/auth/verify-email",
            {"email": "chef@example.com", "code": "000000"},
        )
        self.assertEqual(wrong.status_code, 400)

        right = self.post_public(
            "/api/auth/verify-email",
            {"email": "chef@example.com", "code": self.last_code()},
        )
        self.assertEqual(right.status_code, 200)
        self.assertEqual(self.client.get("/api/auth/session").status_code, 200)
        user.refresh_from_db()
        self.assertIsNotNone(user.email_verified_at)

        # Codes are single-use.
        reused = self.post_public(
            "/api/auth/verify-email",
            {"email": "chef@example.com", "code": self.last_code()},
        )
        self.assertEqual(reused.status_code, 400)

    @override_settings(FORKLUCK_REQUIRE_EMAIL_VERIFICATION=True)
    def test_signup_email_failure_leaves_no_account_or_session(self):
        self.send_code.side_effect = EmailNotConfigured(
            "ACS_CONNECTION_STRING is not set"
        )

        registered = self.post_public(
            "/api/auth/register",
            {
                "name": "Chef",
                "email": "chef@example.com",
                "password": "a-long-test-passphrase-2468",
            },
        )

        self.assertEqual(registered.status_code, 500)
        self.assertFalse(User.objects.filter(email="chef@example.com").exists())
        self.assertEqual(self.client.get("/api/auth/session").status_code, 401)

    @override_settings(FORKLUCK_REQUIRE_EMAIL_VERIFICATION=True)
    @mock.patch("forkluck.domains.accounts.views.upsert_member")
    def test_verified_signup_is_mirrored_into_the_newsletter(self, upsert):
        self.post_public(
            "/api/auth/register",
            {
                "name": "Chef Ana",
                "email": "chef@example.com",
                "password": "a-long-test-passphrase-2468",
            },
        )
        upsert.assert_not_called()

        with self.captureOnCommitCallbacks(execute=True):
            verified = self.post_public(
                "/api/auth/verify-email",
                {"email": "chef@example.com", "code": self.last_code()},
            )

        self.assertEqual(verified.status_code, 200)
        upsert.assert_called_once_with("chef@example.com", "Chef Ana")

    @override_settings(
        FORKLUCK_REQUIRE_EMAIL_VERIFICATION=True,
        FORKLUCK_REGISTRATION_NOTIFICATION_EMAIL="owner@example.com",
    )
    @mock.patch("forkluck.domains.accounts.views.send_new_user_notification")
    def test_owner_is_notified_once_after_verified_user_enters_app(
        self, send_notification
    ):
        registered = self.post_public(
            "/api/auth/register",
            {
                "name": "Chef",
                "email": "chef@example.com",
                "password": "a-long-test-passphrase-2468",
            },
        )
        self.assertEqual(registered.status_code, 202)
        user = User.objects.get(email="chef@example.com")
        self.assertTrue(user.first_sign_in_notification_pending)
        send_notification.assert_not_called()

        unverified_login = self.post_public(
            "/api/auth/login",
            {"email": user.email, "password": "a-long-test-passphrase-2468"},
        )
        self.assertEqual(unverified_login.status_code, 403)
        send_notification.assert_not_called()

        verified = self.post_public(
            "/api/auth/verify-email",
            {"email": user.email, "code": self.last_code()},
        )
        self.assertEqual(verified.status_code, 200)
        send_notification.assert_called_once()
        self.assertEqual(send_notification.call_args.args[0], "owner@example.com")
        self.assertEqual(send_notification.call_args.kwargs["name"], "Chef")
        self.assertEqual(
            send_notification.call_args.kwargs["email"], "chef@example.com"
        )
        user.refresh_from_db()
        self.assertFalse(user.first_sign_in_notification_pending)

        self.post_public("/api/auth/logout", {})
        signed_in = self.post_public(
            "/api/auth/login",
            {"email": user.email, "password": "a-long-test-passphrase-2468"},
        )
        self.assertEqual(signed_in.status_code, 200)
        send_notification.assert_called_once()

    @override_settings(
        FORKLUCK_REQUIRE_EMAIL_VERIFICATION=True,
        FORKLUCK_REGISTRATION_NOTIFICATION_EMAIL="owner@example.com",
    )
    @mock.patch(
        "forkluck.domains.accounts.views.send_new_user_notification",
        side_effect=ValueError("email unavailable"),
    )
    @mock.patch("forkluck.domains.accounts.views.logger.exception")
    def test_owner_notification_failure_does_not_block_verification_and_retries(
        self, _log_exception, send_notification
    ):
        self.post_public(
            "/api/auth/register",
            {
                "name": "Chef",
                "email": "chef@example.com",
                "password": "a-long-test-passphrase-2468",
            },
        )
        verified = self.post_public(
            "/api/auth/verify-email",
            {"email": "chef@example.com", "code": self.last_code()},
        )
        self.assertEqual(verified.status_code, 200)
        user = User.objects.get(email="chef@example.com")
        self.assertTrue(user.first_sign_in_notification_pending)

        self.post_public("/api/auth/logout", {})
        signed_in = self.post_public(
            "/api/auth/login",
            {"email": user.email, "password": "a-long-test-passphrase-2468"},
        )
        self.assertEqual(signed_in.status_code, 200)
        self.assertEqual(send_notification.call_count, 2)

    @override_settings(FORKLUCK_REQUIRE_EMAIL_VERIFICATION=True)
    def test_signin_on_an_unverified_account_reissues_a_code(self):
        self.post_public(
            "/api/auth/register",
            {
                "name": "Chef",
                "email": "chef@example.com",
                "password": "a-long-test-passphrase-2468",
            },
        )
        response = self.post_public(
            "/api/auth/login",
            {"email": "chef@example.com", "password": "a-long-test-passphrase-2468"},
        )
        self.assertEqual(response.status_code, 403)
        self.assertTrue(response.json()["needsVerification"])
        # register + login each issued one code
        self.assertEqual(self.send_code.call_count, 2)

    @override_settings(FORKLUCK_REQUIRE_EMAIL_VERIFICATION=True)
    def test_code_issuance_is_rate_limited_and_resend_hides_unknown_emails(self):
        self.post_public(
            "/api/auth/register",
            {
                "name": "Chef",
                "email": "chef@example.com",
                "password": "a-long-test-passphrase-2468",
            },
        )
        second = self.post_public(
            "/api/auth/resend-code", {"email": "chef@example.com"}
        )
        third = self.post_public("/api/auth/resend-code", {"email": "chef@example.com"})
        limited = self.post_public(
            "/api/auth/resend-code", {"email": "chef@example.com"}
        )
        self.assertEqual(second.status_code, 200)
        self.assertEqual(third.status_code, 200)
        self.assertEqual(limited.status_code, 400)
        self.assertIn("Too many", limited.json()["error"])

        unknown = self.post_public(
            "/api/auth/resend-code", {"email": "nobody@example.com"}
        )
        self.assertEqual(unknown.status_code, 200)

    @override_settings(ACS_CONNECTION_STRING="test-connection-string")
    def test_password_reset_hides_unknown_accounts_and_changes_password(self):
        unknown = self.post_public(
            "/api/auth/request-password-reset", {"email": "nobody@example.com"}
        )
        self.assertEqual(unknown.status_code, 200)
        self.assertEqual(unknown.json(), {"ok": True})
        self.send_code.assert_not_called()

        user = User.objects.create_user(
            email="chef@example.com",
            name="Chef",
            password="a-long-test-passphrase-2468",
        )
        requested = self.post_public(
            "/api/auth/request-password-reset", {"email": user.email}
        )
        self.assertEqual(requested.status_code, 200)
        self.assertEqual(requested.json(), unknown.json())
        self.assertEqual(
            self.send_code.call_args.kwargs["purpose"],
            EmailVerificationCode.PURPOSE_PASSWORD_RESET,
        )

        wrong = self.post_public(
            "/api/auth/reset-password",
            {
                "email": user.email,
                "code": "000000",
                "password": "a-new-long-test-passphrase-8642",
            },
        )
        self.assertEqual(wrong.status_code, 400)
        user.refresh_from_db()
        self.assertTrue(user.check_password("a-long-test-passphrase-2468"))

        weak = self.post_public(
            "/api/auth/reset-password",
            {
                "email": user.email,
                "code": self.last_code(),
                "password": "password",
            },
        )
        self.assertEqual(weak.status_code, 400)

        reset = self.post_public(
            "/api/auth/reset-password",
            {
                "email": user.email,
                "code": self.last_code(),
                "password": "a-new-long-test-passphrase-8642",
            },
        )
        self.assertEqual(reset.status_code, 200)
        user.refresh_from_db()
        self.assertTrue(user.check_password("a-new-long-test-passphrase-8642"))
        self.assertIsNotNone(user.email_verified_at)
        self.assertFalse(
            EmailVerificationCode.objects.filter(
                email=user.email,
                purpose=EmailVerificationCode.PURPOSE_PASSWORD_RESET,
                used_at__isnull=True,
            ).exists()
        )

    @override_settings(FORKLUCK_ADMIN_CODE_LOGIN=True)
    def test_mommy_login_requires_password_then_code(self):
        User.objects.create_superuser(
            email="boss@example.com", name="Boss", password="a-strong-admin-pass-1357"
        )
        page = self.client.get("/mommy/login/")
        self.assertEqual(page.status_code, 200)

        token = self.csrf()
        wrong_password = self.client.post(
            "/mommy/login/",
            {
                "stage": "password",
                "email": "boss@example.com",
                "password": "nope",
                "csrfmiddlewaretoken": token,
            },
        )
        self.assertContains(wrong_password, "incorrect")

        password_ok = self.client.post(
            "/mommy/login/",
            {
                "stage": "password",
                "email": "boss@example.com",
                "password": "a-strong-admin-pass-1357",
                "csrfmiddlewaretoken": token,
            },
        )
        self.assertContains(password_ok, "6-digit code")
        self.assertEqual(self.client.get("/mommy/").status_code, 302)

        wrong_code = self.client.post(
            "/mommy/login/",
            {"stage": "code", "code": "000000", "csrfmiddlewaretoken": token},
        )
        self.assertContains(wrong_code, "wrong or expired")

        signed_in = self.client.post(
            "/mommy/login/",
            {
                "stage": "code",
                "code": self.last_code(),
                "csrfmiddlewaretoken": token,
            },
        )
        self.assertEqual(signed_in.status_code, 302)
        self.assertEqual(self.client.get("/mommy/").status_code, 200)

    @override_settings(FORKLUCK_ADMIN_CODE_LOGIN=True)
    def test_mommy_login_rejects_non_staff_users(self):
        User.objects.create_user(
            email="user@example.com", name="User", password="a-normal-user-pass-1357"
        )
        token = self.csrf()
        response = self.client.post(
            "/mommy/login/",
            {
                "stage": "password",
                "email": "user@example.com",
                "password": "a-normal-user-pass-1357",
                "csrfmiddlewaretoken": token,
            },
        )
        self.assertContains(response, "incorrect")
        self.assertEqual(self.send_code.call_count, 0)


class MommyIndexTests(TestCase):
    """The staff console deals its tables into sections instead of an A-Z list."""

    def test_every_table_sits_in_exactly_one_section(self):
        registered = {
            model._meta.object_name
            for model in admin.site._registry
            if model._meta.app_label == "forkluck"
        }
        placed = [name for _, _, names in MommyAdminSite.sections for name in names]
        self.assertEqual(
            len(placed), len(set(placed)), "a table is listed in two sections"
        )
        self.assertEqual(
            set(placed),
            registered,
            "every table admin.py registers needs a home in MommyAdminSite.sections",
        )

    def test_index_shows_the_sections_in_order_with_their_descriptions(self):
        staff = User.objects.create_superuser(
            email="staff@example.com", name="Staff", password="a-strong-admin-pass-1357"
        )
        self.client.force_login(staff)
        page = self.client.get("/mommy/")
        self.assertEqual(page.status_code, 200)
        html = page.content.decode()
        titles = [title for title, _, _ in MommyAdminSite.sections]
        # Django's own app keeps its stock heading and follows the sections
        # instead of sorting above them alphabetically.
        titles.append("Authentication and Authorization")
        offsets = [html.index(f"<caption>{title}</caption>") for title in titles]
        self.assertEqual(offsets, sorted(offsets), "sections keep their declared order")
        self.assertContains(page, "What users have asked support to do.")
        self.assertContains(page, 'href="/mommy/forkluck/nutritionrequest/"')
        self.assertNotContains(page, "<caption>Forkluck</caption>")
        # Every other page's sidebar follows the same grouping.
        changelist = self.client.get("/mommy/forkluck/user/")
        self.assertContains(changelist, 'href="/mommy/#support-requests"')
        self.assertNotContains(changelist, 'title="Models in the Forkluck application"')

    def test_sections_with_no_visible_table_are_dropped(self):
        support = User.objects.create_user(
            email="support@example.com",
            name="Support",
            password="a-strong-admin-pass-1357",
            is_staff=True,
        )
        support.user_permissions.add(
            Permission.objects.get(codename="view_nutritionrequest")
        )
        self.client.force_login(support)
        page = self.client.get("/mommy/")
        self.assertContains(page, "<caption>Support requests</caption>")
        self.assertContains(page, 'href="/mommy/forkluck/nutritionrequest/"')
        self.assertNotContains(page, "<caption>Accounts</caption>")
        self.assertNotContains(page, 'href="/mommy/forkluck/user/"')
