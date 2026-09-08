"""The workspace activity log: what writes to it, and what reads it back."""

from datetime import timedelta
from uuid import uuid4

from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from .domains.shared.activity import record_event
from .models import (
    ActivityEvent,
    BenchCostSettings,
    ConnectorConnection,
    Employee,
    Ingredient,
    IngredientCategory,
    Invoice,
    Menu,
    Recipe,
    RecipeCategory,
    SalesChannelConnection,
    SalesProductVariant,
    SalesImport,
    SalesProduct,
    User,
)
from .testing import InternalApiTestCase


def make_ingredient(user: User, name: str) -> Ingredient:
    return Ingredient.objects.create(
        user=user,
        name=name,
        purchase_cost_cents=1200,
        purchase_size=1.0,
        purchase_unit="kg",
    )


def make_user(email: str, name: str) -> User:
    return User.objects.create_user(
        email=email, name=name, password="a-long-test-passphrase-2468"
    )


class RecordEventTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = make_user("activity@example.com", "Activity Chef")

    def test_writes_the_row_with_the_actor_name_copied_in(self):
        event = record_event(
            self.user,
            self.user,
            "recipe",
            "added",
            resource_id=None,
            name="Country loaf",
            publicId="rcp_1",
        )
        self.assertEqual(event.actor_name, "Activity Chef")
        self.assertEqual(event.context, {"publicId": "rcp_1"})
        self.assertEqual(ActivityEvent.objects.filter(user=self.user).count(), 1)

    def test_a_background_write_has_no_actor(self):
        event = record_event(self.user, None, "import", "imported", name="Square sync")
        self.assertIsNone(event.actor)
        self.assertEqual(event.actor_name, "")

    def test_an_unknown_vocabulary_value_is_refused(self):
        with self.assertRaises(ValueError):
            record_event(self.user, self.user, "spaceship", "added")
        with self.assertRaises(ValueError):
            record_event(self.user, self.user, "recipe", "vaporized")


class ActionEventTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = make_user("actions@example.com", "Actions Chef")
        self.client.force_login(self.user)

    def events(self, **filters) -> list[ActivityEvent]:
        return list(ActivityEvent.objects.filter(user=self.user, **filters))

    def save_recipe(self, body: dict):
        return self.post_internal("save-recipe", body)

    def test_a_recipe_save_that_changes_nothing_records_one_edit(self):
        created = self.save_recipe(
            {
                "id": None,
                "title": "Country loaf",
                "body": "500 g Flour",
                "yieldUnit": "pcs",
            }
        )
        recipe_id = created.json()["id"]
        self.assertEqual(
            [event.event for event in self.events(resource_type="recipe")], ["added"]
        )

        payload = {
            "id": recipe_id,
            "title": "Country loaf",
            "body": "500 g Flour",
            "yieldUnit": "pcs",
        }
        self.save_recipe(payload)
        self.save_recipe(payload)
        self.assertEqual(
            sorted(event.event for event in self.events(resource_type="recipe")),
            ["added", "edited"],
        )

        # A real change is a second line, not a suppressed one.
        self.save_recipe({**payload, "body": "500 g Flour\n350 g Water"})
        self.assertEqual(len(self.events(resource_type="recipe", event="edited")), 2)

    def test_archiving_then_restoring_a_recipe_reads_back_as_two_lines(self):
        created = self.save_recipe(
            {"id": None, "title": "Focaccia", "body": "", "yieldUnit": "pcs"}
        )
        recipe_id = created.json()["id"]
        for status in ("archived", "active"):
            self.post_internal(
                "update-recipe-statuses",
                {"recipeIds": [recipe_id], "status": status},
            )
        self.assertEqual(
            [
                event.event
                for event in self.events(resource_type="recipe").__reversed__()
            ][:3],
            ["added", "archived", "restored"],
        )

    def test_a_selection_is_archived_whole_or_not_at_all(self):
        mine = self.save_recipe(
            {"id": None, "title": "Focaccia", "body": "", "yieldUnit": "pcs"}
        ).json()["id"]
        refused = self.post_internal(
            "update-recipe-statuses",
            {"recipeIds": [mine, str(uuid4())], "status": "archived"},
        )
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(Recipe.objects.get(id=mine).status, Recipe.STATUS_ACTIVE)
        self.assertEqual(self.events(resource_type="recipe", event="archived"), [])

    def test_archiving_twice_reads_back_as_one_line(self):
        recipe_id = self.save_recipe(
            {"id": None, "title": "Focaccia", "body": "", "yieldUnit": "pcs"}
        ).json()["id"]
        for _ in range(2):
            answer = self.post_internal(
                "update-recipe-statuses",
                {"recipeIds": [recipe_id, recipe_id], "status": "archived"},
            )
            self.assertEqual(answer.status_code, 200)
        self.assertEqual(answer.json(), {"ok": True, "changed": 0})
        self.assertEqual(len(self.events(resource_type="recipe", event="archived")), 1)

    def test_archiving_a_selection_costs_the_same_queries_at_any_size(self):
        def ids(count: int) -> list[str]:
            return [
                self.save_recipe(
                    {"id": None, "title": f"Loaf {i}", "body": "", "yieldUnit": "pcs"}
                ).json()["id"]
                for i in range(count)
            ]

        def queries(recipe_ids: list[str]) -> int:
            with CaptureQueriesContext(connection) as captured:
                answer = self.post_internal(
                    "update-recipe-statuses",
                    {"recipeIds": recipe_ids, "status": "archived"},
                )
            self.assertEqual(answer.json(), {"ok": True, "changed": len(recipe_ids)})
            return len(captured)

        self.assertEqual(queries(ids(2)), queries(ids(5)))

    def test_archiving_then_restoring_an_ingredient(self):
        ingredient = make_ingredient(self.user, "Butter")
        for archived in (True, False):
            self.post_internal(
                "archive-ingredient", {"id": str(ingredient.id), "archived": archived}
            )
        self.assertEqual(
            [
                event.event
                for event in reversed(self.events(resource_type="ingredient"))
            ],
            ["archived", "restored"],
        )

    def test_renaming_a_recipe_category_is_logged_with_its_kind(self):
        RecipeCategory.objects.create(
            user=self.user, name="Bakery", normalized_name="bakery"
        )
        response = self.post_internal(
            "rename-recipe-category", {"currentName": "Bakery", "name": "Breads"}
        )
        self.assertEqual(response.status_code, 200)
        event = self.events(resource_type="category")[0]
        self.assertEqual(
            (event.event, event.name, event.context),
            ("edited", "Breads", {"kind": "recipe"}),
        )

    def test_renaming_an_ingredient_category_is_logged_with_its_kind(self):
        IngredientCategory.objects.create(
            user=self.user, name="Dairy", normalized_name="dairy"
        )
        self.post_internal(
            "rename-ingredient-category", {"currentName": "Dairy", "name": "Chilled"}
        )
        event = self.events(resource_type="category")[0]
        self.assertEqual(event.context, {"kind": "ingredient"})

    def test_a_settings_save_names_the_fields_it_changed(self):
        self.post_internal(
            "update-business-settings",
            {
                "wagePerHourCents": 3000,
                "measurementSystem": "us",
                "currencyCode": "USD",
                "foodCostTarget": 0.3,
                "overtimeWeeklyMinutes": 2400,
                "expectedCurrencyCode": "USD",
            },
        )
        event = self.events(resource_type="settings")[0]
        self.assertEqual(
            event.context["changed"], ["wagePerHourCents", "measurementSystem"]
        )

        # A save that changes nothing writes nothing.
        self.post_internal(
            "update-business-settings",
            {
                "wagePerHourCents": 3000,
                "measurementSystem": "us",
                "currencyCode": "USD",
                "foodCostTarget": 0.3,
                "overtimeWeeklyMinutes": 2400,
                "expectedCurrencyCode": "USD",
            },
        )
        self.assertEqual(len(self.events(resource_type="settings")), 1)


class ActivityViewTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = make_user("view@example.com", "View Chef")
        self.other = make_user("other@example.com", "Other Chef")
        self.client.force_login(self.user)
        now = timezone.now()
        self.rows = []
        for index, (resource_type, event) in enumerate(
            [
                ("recipe", "added"),
                ("ingredient", "edited"),
                ("recipe", "deleted"),
            ]
        ):
            row = record_event(
                self.user, self.user, resource_type, event, name=f"n{index}"
            )
            # auto_now_add fixes created_at, so the ordering is set afterwards.
            ActivityEvent.objects.filter(id=row.id).update(
                created_at=now - timedelta(minutes=10 - index)
            )
            self.rows.append(row)
        record_event(self.other, self.other, "recipe", "added", name="theirs")

    def load(self, **params):
        response = self.get_internal("activity/", params or None)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_newest_first_and_scoped_to_the_tenant(self):
        payload = self.load()
        self.assertEqual(
            [item["name"] for item in payload["items"]], ["n2", "n1", "n0"]
        )
        self.assertIsNone(payload["nextBefore"])
        self.assertEqual(payload["items"][0]["actorName"], "View Chef")

    def test_filters_by_event_and_by_type(self):
        self.assertEqual(
            [item["name"] for item in self.load(events="added,deleted")["items"]],
            ["n2", "n0"],
        )
        self.assertEqual(
            [item["name"] for item in self.load(types="ingredient")["items"]], ["n1"]
        )

    def test_the_cursor_pages_backwards_and_is_exclusive(self):
        first = self.load(limit="2")
        self.assertEqual([item["name"] for item in first["items"]], ["n2", "n1"])
        self.assertIsNotNone(first["nextBefore"])
        second = self.load(limit="2", before=first["nextBefore"])
        self.assertEqual([item["name"] for item in second["items"]], ["n0"])
        self.assertIsNone(second["nextBefore"])

    def test_an_unknown_filter_value_is_a_400(self):
        for params in ({"events": "vaporized"}, {"types": "spaceship"}, {"limit": "0"}):
            self.assertEqual(self.get_internal("activity/", params).status_code, 400)


class DeleteKitchenDataTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = make_user("reset@example.com", "Reset Chef")
        self.client.force_login(self.user)

    def build_kitchen(self) -> None:
        recipe = Recipe.objects.create(user=self.user, title="Loaf", code="R1")
        make_ingredient(self.user, "Flour")
        RecipeCategory.objects.create(
            user=self.user, name="Bakery", normalized_name="bakery"
        )
        IngredientCategory.objects.create(
            user=self.user, name="Dry", normalized_name="dry"
        )
        Menu.objects.create(user=self.user, name="Winter")
        Invoice.objects.create(
            user=self.user,
            supplier="acme",
            supplier_name="Acme",
            total_cents=1000,
            source_fingerprint="fp-1",
            file_name="acme.pdf",
        )
        Employee.objects.create(user=self.user, name="Sam", normalized_name="sam")
        product = SalesProduct.objects.create(user=self.user, name="Loaf")
        # Every PROTECT edge the reset has to clear in order: a product link
        # protects the recipe, and a bundle protects the product inside it —
        # the latter hangs off a product rather than the user, so only
        # KITCHEN_PRE_DELETES reaches it.
        product.components.create(recipe=recipe, quantity=1)
        box = SalesProduct.objects.create(user=self.user, name="Gift box")
        box.components.create(component_product=product, quantity=1)
        SalesProductVariant.objects.create(
            user=self.user,
            product=product,
            channel=SalesImport.Channel.SQUARE,
            match_key="loaf",
            external_name="Loaf",
        )
        SalesImport.objects.create(
            user=self.user,
            file_name="sales.csv",
            channel=SalesImport.Channel.SQUARE,
        )

    def test_the_reset_clears_the_kitchen_and_keeps_the_account(self):
        self.build_kitchen()
        BenchCostSettings.objects.create(user=self.user, wage_per_hour_cents=3000)
        SalesChannelConnection.objects.create(
            user=self.user, provider=SalesImport.Channel.SQUARE
        )
        ConnectorConnection.objects.create(
            user=self.user,
            provider_key="acme",
            remote_connection_id="connection-acme",
            access_token_encrypted="synthetic-not-read",
        )
        record_event(self.user, self.user, "recipe", "added", name="before the reset")

        response = self.post_internal("delete-kitchen-data", {})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "ok": True,
                "deleted": {
                    "recipes": 1,
                    "ingredients": 1,
                    "menus": 1,
                    "invoices": 1,
                    "employees": 1,
                },
            },
        )

        for relation in (
            "recipes",
            "ingredients",
            "menus",
            "invoices",
            "employees",
            "recipe_categories",
            "ingredient_categories",
            "sales_products",
            "sales_product_variants",
            "sales_imports",
        ):
            self.assertEqual(
                getattr(self.user, relation).count(), 0, f"{relation} survived"
            )

        self.assertTrue(User.objects.filter(id=self.user.id).exists())
        self.assertEqual(self.user.benchcost_settings.wage_per_hour_cents, 3000)
        self.assertEqual(self.user.sales_channel_connections.count(), 1)
        self.assertTrue(ConnectorConnection.objects.filter(user=self.user).exists())
        self.assertEqual(
            [event.event for event in self.user.activity_events.all()][0], "deleted"
        )
        self.assertEqual(self.user.activity_events.count(), 2)

    def test_another_tenant_keeps_its_kitchen(self):
        self.build_kitchen()
        neighbour = make_user("neighbour@example.com", "Neighbour Chef")
        Recipe.objects.create(user=neighbour, title="Theirs", code="R1")

        self.post_internal("delete-kitchen-data", {})
        self.assertEqual(neighbour.recipes.count(), 1)
