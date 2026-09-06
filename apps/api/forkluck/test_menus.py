"""The menu worksheet: every row is a recipe or a product, costed through the link."""

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from .domains.recipes.actions import (
    action_delete_menu,
    action_delete_recipe,
    action_save_menu,
)
from .domains.recipes.health import (
    RecipeHealthReadModel,
    catalog_measure_sources,
    menu_detail_payload,
    menu_items_queryset,
    menu_sources_payload,
)
from .domains.recipes.views import (
    menu_component_price,
    menu_sources,
    menus,
    recipe_health,
)
from .domains.sales.core import action_delete_sales_product, product_cost
from .domains.sales.views import product_categories
from .models import (
    BenchCostSettings,
    Ingredient,
    Menu,
    MenuItem,
    Recipe,
    RecipeCategory,
    RecipeItem,
    SalesImport,
    SalesLine,
    SalesProduct,
    SalesProductComponent,
    SalesProductVariant,
    User,
    normalized_name,
)
from .testing import InternalApiTestCase, internal_payload

MENUS_LIST_QUERIES = 1
MENU_DETAIL_QUERIES = 23
MENU_SOURCES_QUERIES = 13
MENU_COMPONENT_PRICE_QUERIES = 8

DETAIL_QUERY_MESSAGE = (
    "10 dashboard read model (bench settings, recipes, 2 prefetches, 5 "
    "resolver tables, bench-cost row) + 1 product components + 1 items + 2 "
    "attributed sales (lines, modifiers) + 6 product cost walk (subrecipe "
    "edges, recipe items, conversions, preparations, recipes, equivalencies) "
    "+ 1 ingredients + 2 product options (products, bundle membership). Every "
    "row costs and counts out of those loads; a per-row query would make "
    "opening a worksheet O(rows)"
)


class MenuFixture:
    """A costed recipe, an uncosted one, and a pantry priced in four families."""

    @classmethod
    def build_workspace(cls) -> None:
        cls.user = User.objects.create_user(
            email="menus@example.com",
            password="a-long-test-passphrase-2468",
            name="Menu Chef",
        )
        BenchCostSettings.objects.get_or_create(user=cls.user)
        cls.category = RecipeCategory.objects.create(
            user=cls.user, name="Pastry", normalized_name="pastry"
        )
        cls.butter = Ingredient.objects.create(
            user=cls.user,
            name="Butter",
            normalized_name="butter",
            purchase_cost_cents=1200,
            purchase_size=1.0,
            purchase_unit="kg",
        )
        # 800c a pound is 150c for three ounces (3/16 of a pound).
        cls.chicken = Ingredient.objects.create(
            user=cls.user,
            name="Chicken",
            normalized_name="chicken",
            purchase_cost_cents=800,
            purchase_size=1.0,
            purchase_unit="lb",
        )
        cls.egg = Ingredient.objects.create(
            user=cls.user,
            name="Egg",
            normalized_name="egg",
            purchase_cost_cents=50,
            purchase_size=1.0,
            purchase_unit="each",
        )
        cls.wine = Ingredient.objects.create(
            user=cls.user,
            name="Wine",
            normalized_name="wine",
            purchase_cost_cents=2500,
            purchase_size=1.0,
            purchase_unit="bottle",
        )
        # 1200 g of butter at 1200c/kg is 1440c a batch; twelve pieces is 120c
        # a piece, and the sale unit is a piece, so the suffix is "/pc".
        cls.croissant = Recipe.objects.create(
            user=cls.user,
            title="Croissant",
            code="R1",
            category=cls.category,
            body="1200 g Butter",
            yield_amount=12.0,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
            menu_price_cents=450,
        )
        RecipeItem.objects.create(
            recipe=cls.croissant,
            kind=RecipeItem.INGREDIENT,
            position=0,
            display_name="Butter",
            quantity=Decimal("1200"),
            unit="g",
            ingredient=cls.butter,
        )
        cls.mystery = Recipe.objects.create(
            user=cls.user,
            title="Mystery",
            code="R2",
            body="1 pc Unicorn horn",
        )
        cls.product = SalesProduct.objects.create(
            user=cls.user, name="Croissant box", normalized_name="croissant box"
        )
        SalesProductComponent.objects.create(
            product=cls.product, recipe=cls.croissant, quantity=Decimal("2.000")
        )

        cls.stranger = User.objects.create_user(
            email="stranger-menus@example.com",
            password="a-long-test-passphrase-1357",
            name="Stranger",
        )
        BenchCostSettings.objects.get_or_create(user=cls.stranger)
        cls.stranger_recipe = Recipe.objects.create(
            user=cls.stranger, title="Their scone", code="S1", body="100 g Butter"
        )
        cls.stranger_ingredient = Ingredient.objects.create(
            user=cls.stranger,
            name="Their butter",
            normalized_name="their butter",
            purchase_cost_cents=900,
            purchase_size=1.0,
            purchase_unit="kg",
        )
        cls.stranger_product = SalesProduct.objects.create(
            user=cls.stranger, name="Their box", normalized_name="their box"
        )
        cls.stranger_menu = Menu.objects.create(user=cls.stranger, name="Their menu")
        # The shared measure table is read once per process behind an
        # lru_cache, so whichever test ran first would otherwise own that query.
        catalog_measure_sources()


class MenuReadTests(MenuFixture, InternalApiTestCase):
    @classmethod
    def setUpTestData(cls) -> None:
        cls.build_workspace()
        cls.menu = Menu.objects.create(
            user=cls.user,
            name="Spring",
            period_start=date(2026, 3, 1),
            period_end=date(2026, 3, 31),
        )
        cls.product_row = MenuItem.objects.create(
            menu=cls.menu,
            position=0,
            name="Croissant box",
            category="Pastry",
            sell_price_cents=900,
            qty_sold=Decimal("12.500"),
            product=cls.product,
            original_sell_price_cents=800,
            original_qty_sold=Decimal("10.000"),
            original_food_cost_cents=240,
        )
        cls.recipe_row = MenuItem.objects.create(
            menu=cls.menu,
            position=1,
            name="Croissant",
            category="Pastry",
            sell_price_cents=450,
            qty_sold=Decimal("30.000"),
            recipe=cls.croissant,
            original_sell_price_cents=450,
            original_qty_sold=Decimal("30.000"),
            original_food_cost_cents=120,
        )
        cls.mystery_row = MenuItem.objects.create(
            menu=cls.menu,
            position=2,
            name="Mystery",
            sell_price_cents=700,
            qty_sold=Decimal("4.000"),
            recipe=cls.mystery,
            original_sell_price_cents=700,
            original_qty_sold=Decimal("4.000"),
        )
        # A migration leftover: a row 0020 could not link.
        cls.free_row = MenuItem.objects.create(
            menu=cls.menu,
            position=3,
            name="Coffee",
            sell_price_cents=300,
            qty_sold=Decimal("40.000"),
            original_sell_price_cents=300,
            original_qty_sold=Decimal("40.000"),
        )
        sales_import = SalesImport.objects.create(
            user=cls.user,
            file_name="sales.csv",
            source=SalesImport.Source.CSV,
            channel=SalesImport.Channel.SQUARE,
            timezone="UTC",
            currency_code="USD",
        )
        variant = SalesProductVariant.objects.create(
            user=cls.user,
            product=cls.product,
            channel=SalesImport.Channel.SQUARE,
            match_key="square:box",
            external_name="Croissant box",
            quantity_multiplier=Decimal("1"),
        )
        # Twelve inside the menu's period, five after it.
        for position, (sold_on, quantity) in enumerate(
            [(date(2026, 3, 10), "12"), (date(2026, 4, 2), "5")]
        ):
            SalesLine.objects.create(
                user=cls.user,
                sales_import=sales_import,
                variant=variant,
                channel=SalesImport.Channel.SQUARE,
                source_position=position,
                source_fingerprint=f"box-{position}",
                external_order_id=f"order-{position}",
                sold_at=datetime.combine(
                    sold_on, datetime.min.time(), tzinfo=timezone.utc
                ),
                timezone="UTC",
                item_name="Croissant box",
                quantity=Decimal(quantity),
            )

    def detail(self, user=None, menu=None) -> dict:
        return menu_detail_payload(user or self.user, menu or self.menu)

    def test_the_menu_list_is_one_query(self):
        with self.assertNumQueries(
            MENUS_LIST_QUERIES,
            msg="1 annotated menus query. The list counts items in that one "
            "query; serializing a row must never count that row's items on "
            "its own, which is what would make the list O(menus)",
        ):
            payload = internal_payload(menus, self.user)
        self.assertTrue(payload["hasAnyMenu"])
        self.assertEqual([row["name"] for row in payload["menus"]], ["Spring"])
        self.assertEqual(payload["menus"][0]["itemCount"], 4)

    def test_the_menu_list_shows_only_the_reading_tenants_menus(self):
        payload = internal_payload(menus, self.stranger)
        self.assertEqual([row["name"] for row in payload["menus"]], ["Their menu"])
        self.assertTrue(payload["hasAnyMenu"])

    def test_a_product_row_costs_what_its_product_page_shows(self):
        item = self.detail()["items"][0]
        self.assertEqual(item["productId"], str(self.product.id))
        self.assertEqual(item["productPublicId"], self.product.public_id)
        self.assertEqual(item["productName"], "Croissant box")
        self.assertEqual(item["name"], "Croissant box")
        self.assertIsNone(item["recipeId"])
        self.assertEqual(item["foodCostCents"], product_cost(self.product).cents)
        # Two batches of croissant, as the product page counts a recipe
        # component, rather than two pieces.
        self.assertEqual(item["foodCostCents"], 2880)

    def test_a_recipe_row_costs_per_unit_of_sale_as_the_cost_tab_does(self):
        item = self.detail()["items"][1]
        self.assertEqual(item["recipeId"], str(self.croissant.id))
        self.assertEqual(item["recipePublicId"], self.croissant.public_id)
        self.assertEqual(item["recipeName"], "Croissant")
        self.assertEqual(item["name"], "Croissant")
        self.assertEqual(item["category"], "Pastry")
        self.assertIsNone(item["productId"])
        self.assertEqual(item["foodCostCents"], 120)
        self.assertEqual(item["sourceSellPriceCents"], 450)
        self.assertIsNone(item["sourceQtySold"])

    def test_an_uncostable_source_leaves_the_row_uncosted_not_zero(self):
        item = self.detail()["items"][2]
        self.assertEqual(item["name"], "Mystery")
        self.assertEqual(item["category"], "")
        self.assertIsNone(item["foodCostCents"])
        self.assertIsNone(item["sourceSellPriceCents"])

    def test_a_leftover_without_a_link_keeps_its_saved_name(self):
        item = self.detail()["items"][3]
        self.assertEqual(item["name"], "Coffee")
        self.assertIsNone(item["recipeId"])
        self.assertIsNone(item["productId"])
        self.assertIsNone(item["foodCostCents"])
        self.assertIsNone(item["sourceSellPriceCents"])
        self.assertIsNone(item["sourceQtySold"])

    def test_the_name_follows_the_link_not_the_column(self):
        Recipe.objects.filter(id=self.croissant.id).update(title="Croissant, butter")
        self.assertEqual(self.detail()["items"][1]["name"], "Croissant, butter")

    def test_a_product_rows_units_are_its_sales_in_the_menu_period(self):
        self.assertEqual(self.detail()["items"][0]["sourceQtySold"], 12.0)
        Menu.objects.filter(id=self.menu.id).update(period_start=None, period_end=None)
        self.menu.refresh_from_db()
        self.assertEqual(self.detail()["items"][0]["sourceQtySold"], 17.0)

    def test_a_products_price_is_the_source_price_and_zero_is_none(self):
        self.assertIsNone(self.detail()["items"][0]["sourceSellPriceCents"])
        SalesProduct.objects.filter(id=self.product.id).update(sell_price_cents=950)
        self.assertEqual(self.detail()["items"][0]["sourceSellPriceCents"], 950)

    def test_the_cost_follows_the_products_composition(self):
        SalesProductComponent.objects.filter(product=self.product).update(
            quantity=Decimal("1.000")
        )
        self.assertEqual(self.detail()["items"][0]["foodCostCents"], 1440)

    def test_no_row_carries_a_composition(self):
        for item in self.detail()["items"]:
            self.assertNotIn("components", item)

    def test_quantities_cross_the_wire_as_numbers_not_decimal_strings(self):
        item = self.detail()["items"][0]
        self.assertIsInstance(item["qtySold"], float)
        self.assertEqual(item["qtySold"], 12.5)

    def test_the_detail_carries_the_pickers_recipes_and_ingredients(self):
        payload = self.detail()
        self.assertEqual(
            {row["title"] for row in payload["recipes"]}, {"Croissant", "Mystery"}
        )
        by_name = {row["name"]: row for row in payload["ingredients"]}
        self.assertEqual(set(by_name), {"Butter", "Chicken", "Egg", "Wine"})
        self.assertEqual(by_name["Chicken"]["purchaseUnit"], "lb")
        self.assertEqual(by_name["Chicken"]["id"], str(self.chicken.id))

    def test_the_original_snapshot_is_echoed_verbatim(self):
        items = self.detail()["items"]
        self.assertEqual(
            items[0]["original"],
            {"sellPriceCents": 800, "qtySold": 10.0, "foodCostCents": 240},
        )
        self.assertIsNone(items[2]["original"]["foodCostCents"])

    def test_the_detail_names_the_workspace_currency(self):
        self.assertEqual(self.detail()["currencyCode"], "USD")

    def test_the_detail_reads_the_period_as_date_only_strings(self):
        menu = self.detail()["menu"]
        self.assertEqual(menu["periodStart"], "2026-03-01")
        self.assertEqual(menu["periodEnd"], "2026-03-31")

    def test_the_detail_query_count_does_not_grow_with_rows(self):
        small = Menu.objects.create(user=self.user, name="Two")
        self.add_rows(small, 2)
        with self.assertNumQueries(MENU_DETAIL_QUERIES, msg=DETAIL_QUERY_MESSAGE):
            menu_detail_payload(self.user, small)

        large = Menu.objects.create(user=self.user, name="Twenty")
        self.add_rows(large, 20)
        with self.assertNumQueries(MENU_DETAIL_QUERIES, msg=DETAIL_QUERY_MESSAGE):
            menu_detail_payload(self.user, large)

    def add_rows(self, menu: Menu, count: int) -> None:
        """Product and recipe rows alternating, each product its own."""
        rows = []
        for index in range(count):
            if index % 2:
                link = {"recipe": self.croissant if index % 4 == 1 else self.mystery}
            else:
                product = SalesProduct.objects.create(
                    user=self.user,
                    name=f"Box {menu.name} {index}",
                    normalized_name=f"box {menu.name} {index}".casefold(),
                )
                SalesProductComponent.objects.create(
                    product=product, recipe=self.croissant, quantity=Decimal("1")
                )
                link = {"product": product}
            rows.append(
                MenuItem(
                    menu=menu,
                    position=index,
                    name=f"Row {index}",
                    sell_price_cents=500,
                    qty_sold=Decimal("1.000"),
                    original_sell_price_cents=500,
                    original_qty_sold=Decimal("1.000"),
                    original_food_cost_cents=240,
                    **link,
                )
            )
        MenuItem.objects.bulk_create(rows)

    def test_the_items_queryset_is_scoped_to_one_menu(self):
        other = Menu.objects.create(user=self.user, name="Autumn")
        MenuItem.objects.create(
            menu=other,
            position=0,
            name="Elsewhere",
            sell_price_cents=100,
            original_sell_price_cents=100,
        )
        self.assertEqual(
            {item.name for item in menu_items_queryset(self.menu)},
            {"Croissant box", "Croissant", "Mystery", "Coffee"},
        )

    def test_a_menu_resolves_by_public_id_and_by_uuid(self):
        self.client.force_login(self.user)
        for ref in (self.menu.public_id, str(self.menu.id)):
            with self.subTest(ref=ref):
                response = self.get_internal(f"menu/{ref}/")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["menu"]["name"], "Spring")

    def test_an_unknown_reference_is_a_404_rather_than_a_crash(self):
        self.client.force_login(self.user)
        for ref in ("mnu_doesnotexist", "not-a-uuid", str(self.stranger_menu.id)):
            with self.subTest(ref=ref):
                response = self.get_internal(f"menu/{ref}/")
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), {"error": "Menu not found"})

    def test_another_tenants_menu_is_not_found_by_its_public_id(self):
        self.client.force_login(self.user)
        response = self.get_internal(f"menu/{self.stranger_menu.public_id}/")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json(), {"error": "Menu not found"})

    # --- sources ------------------------------------------------------------

    def test_the_sources_read_costs_every_owned_recipe(self):
        payload = menu_sources_payload(self.user)
        by_title = {row["title"]: row for row in payload["recipes"]}
        self.assertEqual(set(by_title), {"Croissant", "Mystery"})
        self.assertEqual(by_title["Croissant"]["ingredientCents"], 120.0)
        self.assertEqual(by_title["Croissant"]["suffix"], "/1 each")
        self.assertEqual(by_title["Croissant"]["menuPriceCents"], 450)
        self.assertEqual(by_title["Croissant"]["category"], "Pastry")
        self.assertIsNone(by_title["Mystery"]["ingredientCents"])
        self.assertEqual(payload["currencyCode"], "USD")

    def test_the_sources_read_names_every_owned_ingredient(self):
        payload = menu_sources_payload(self.user)
        self.assertEqual(
            [row["name"] for row in payload["ingredients"]],
            ["Butter", "Chicken", "Egg", "Wine"],
        )
        self.assertEqual(payload["ingredients"][1]["purchaseUnit"], "lb")

    def test_the_sources_query_count_does_not_grow_with_the_library(self):
        message = (
            "10 dashboard read model + 1 ingredient options + 2 product "
            "options (products, bundle membership). The picker costs the "
            "whole library through one read model; a per-recipe, "
            "per-ingredient or per-product query would make it O(library)"
        )
        with self.assertNumQueries(MENU_SOURCES_QUERIES, msg=message):
            menu_sources_payload(self.user)

        for index in range(10):
            Recipe.objects.create(
                user=self.user,
                title=f"Extra {index}",
                body="1200 g Butter",
                yield_amount=12.0,
                yield_unit="pcs",
            )
            Ingredient.objects.create(
                user=self.user,
                name=f"Spice {index}",
                normalized_name=f"spice {index}",
                purchase_cost_cents=100,
                purchase_size=1.0,
                purchase_unit="kg",
            )
        with self.assertNumQueries(MENU_SOURCES_QUERIES, msg=message):
            menu_sources_payload(self.user)

    def test_the_sources_never_show_another_tenants_rows(self):
        payload = menu_sources_payload(self.user)
        self.assertNotIn("Their scone", {row["title"] for row in payload["recipes"]})
        self.assertNotIn(
            "Their butter", {row["name"] for row in payload["ingredients"]}
        )
        theirs = menu_sources_payload(self.stranger)
        self.assertEqual({row["title"] for row in theirs["recipes"]}, {"Their scone"})
        self.assertEqual(
            {row["name"] for row in theirs["ingredients"]}, {"Their butter"}
        )

    def test_the_sources_route_answers_the_same_payload(self):
        payload = internal_payload(menu_sources, self.user)
        self.assertEqual(
            {row["title"] for row in payload["recipes"]}, {"Croissant", "Mystery"}
        )
        self.assertEqual(
            {row["name"] for row in payload["ingredients"]},
            {"Butter", "Chicken", "Egg", "Wine"},
        )

    def test_a_recipes_cost_matches_the_recipe_health_read(self):
        # Two read models cost the same recipe; a divergence here means the
        # worksheet and the recipe table would disagree about the same dish.
        health = {
            row["title"]: row["ingredientCents"]
            for row in internal_payload(recipe_health, self.user)["items"]
        }
        picker = {
            row["title"]: row["ingredientCents"]
            for row in menu_sources_payload(self.user)["recipes"]
        }
        self.assertEqual(picker["Croissant"], health["Croissant"])
        self.assertEqual(picker["Mystery"], health["Mystery"])

    # --- component price ----------------------------------------------------

    def price(self, ingredient_id: str, unit: str) -> dict:
        return internal_payload(
            menu_component_price,
            self.user,
            query={"ingredientId": ingredient_id, "unit": unit},
        )

    def test_the_component_price_converts_into_the_asked_unit(self):
        self.assertEqual(
            self.price(str(self.chicken.id), "oz"), {"unitCostCents": 50.0}
        )
        self.assertEqual(self.price(str(self.butter.id), "g"), {"unitCostCents": 1.2})
        self.assertEqual(
            self.price(str(self.wine.id), "bottle"), {"unitCostCents": 2500.0}
        )

    def test_a_dimensionless_unit_is_answered_with_a_null_cost_not_an_error(self):
        self.assertEqual(
            self.price(str(self.butter.id), "splash"), {"unitCostCents": None}
        )

    def test_the_component_price_is_one_read_model_and_no_more(self):
        with self.assertNumQueries(
            MENU_COMPONENT_PRICE_QUERIES,
            msg="8 for a non-dashboard read model (bench settings, catalog "
            "ingredients, preparations, owned ingredients, their measures "
            "and conversions, line matches, measures). Pricing one component "
            "must never build the dashboard model, which reads the whole "
            "recipe library",
        ):
            self.price(str(self.chicken.id), "oz")

    def test_a_recipe_id_is_not_an_ingredient(self):
        self.client.force_login(self.user)
        response = self.get_internal(
            "menu-component-price/",
            {"ingredientId": str(self.croissant.id), "unit": "g"},
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json(), {"error": "Ingredient not found"})

    def test_the_pricer_itself_refuses_anything_that_is_not_a_pantry_row(self):
        # The route takes a bare UUID, so the ownership check is not the only
        # thing standing between a recipe id and an ingredient price.
        model = RecipeHealthReadModel(self.user)
        self.assertIsNone(model.ingredient_cents(str(self.croissant.id), 1.0, "g"))
        self.assertIsNone(
            model.ingredient_cents(str(self.stranger_ingredient.id), 1.0, "g")
        )

    def test_another_tenants_ingredient_is_not_found(self):
        self.client.force_login(self.user)
        response = self.get_internal(
            "menu-component-price/",
            {"ingredientId": str(self.stranger_ingredient.id), "unit": "g"},
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json(), {"error": "Ingredient not found"})

    def test_a_bad_unit_or_id_is_refused(self):
        self.client.force_login(self.user)
        for query in (
            {"ingredientId": str(self.butter.id), "unit": "furlong"},
            {"ingredientId": str(self.butter.id), "unit": ""},
            {"ingredientId": "not-a-uuid", "unit": "g"},
        ):
            with self.subTest(query=query):
                response = self.get_internal("menu-component-price/", query)
                self.assertEqual(response.status_code, 400)


class IngredientCentsParityTests(MenuFixture, TestCase):
    """The extraction is lossless: one recipe, costed both ways, one number."""

    @classmethod
    def setUpTestData(cls) -> None:
        cls.build_workspace()
        cls.parity = Recipe.objects.create(
            user=cls.user,
            title="Parity plate",
            code="R3",
            body="4 oz Chicken\n100 g Butter",
            yield_amount=1.0,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )
        # Efficiency belongs to the recipe line, not to the pricer: the gross
        # amount is what reaches `ingredient_cents`. Yield after cooking is
        # nutrition's field and leaves the cost alone: the butter the oven
        # takes out of the dish was still bought.
        RecipeItem.objects.create(
            recipe=cls.parity,
            kind=RecipeItem.INGREDIENT,
            position=0,
            display_name="Chicken",
            quantity=Decimal("4"),
            unit="oz",
            ingredient=cls.chicken,
            efficiency=80,
        )
        RecipeItem.objects.create(
            recipe=cls.parity,
            kind=RecipeItem.INGREDIENT,
            position=1,
            display_name="Butter",
            quantity=Decimal("100"),
            unit="g",
            ingredient=cls.butter,
            efficiency_after_cooking=50,
        )

    def test_a_recipes_cost_is_the_sum_of_its_lines_priced_one_by_one(self):
        model = RecipeHealthReadModel(self.user, dashboard=True)
        row = next(
            row
            for row in model.rows(model.all_recipes)
            if row["title"] == "Parity plate"
        )
        total = 0.0
        for item in self.parity.items.all():
            quantity = float(item.quantity) * 100.0 / float(item.efficiency or 100)
            cents = model.ingredient_cents(
                str(item.ingredient_id),
                quantity,
                item.unit,
                normalized_name(item.preparation_note),
            )
            self.assertIsNotNone(cents)
            total += cents
        self.assertAlmostEqual(row["ingredientCents"], total, delta=0.5)
        self.assertAlmostEqual(total, 370.0, delta=0.01)


class MenuSaveTests(MenuFixture, TestCase):
    @classmethod
    def setUpTestData(cls) -> None:
        cls.build_workspace()

    def row(self, **overrides) -> dict:
        body = {
            "id": None,
            "name": "",
            "recipeId": str(self.croissant.id),
            "productId": None,
            "sellPriceCents": 450,
            "qtySold": 30,
        }
        body.update(overrides)
        return body

    def product_row(self, **overrides) -> dict:
        return self.row(
            **{"recipeId": None, "productId": str(self.product.id), **overrides}
        )

    def save(self, user=None, **overrides) -> dict:
        body = {
            "id": None,
            "name": "Spring",
            "periodStart": None,
            "periodEnd": None,
            "items": [],
        }
        body.update(overrides)
        return action_save_menu(user or self.user, body)

    def created_menu(self) -> dict:
        return self.save(
            items=[
                self.product_row(sellPriceCents=900, qtySold=12),
                self.row(),
                self.row(recipeId=str(self.mystery.id), sellPriceCents=700),
            ]
        )

    def test_a_new_menu_gets_a_prefixed_public_id(self):
        payload = self.save()
        self.assertTrue(payload["menu"]["publicId"].startswith("mnu_"))
        self.assertEqual(Menu.objects.filter(user=self.user).count(), 1)

    def test_creation_snapshots_the_food_cost_of_each_row_through_its_link(self):
        payload = self.created_menu()
        self.assertEqual(
            [item["original"]["foodCostCents"] for item in payload["items"]],
            [product_cost(self.product).cents, 120, None],
        )
        self.assertEqual(
            [item["foodCostCents"] for item in payload["items"]], [2880, 120, None]
        )

    def test_the_name_and_category_columns_follow_the_link(self):
        payload = self.created_menu()
        self.assertEqual(
            [(item["name"], item["category"]) for item in payload["items"]],
            [("Croissant box", ""), ("Croissant", "Pastry"), ("Mystery", "")],
        )
        self.assertEqual(
            list(
                MenuItem.objects.filter(menu_id=payload["menu"]["id"]).values_list(
                    "name", "category"
                )
            ),
            [("Croissant box", ""), ("Croissant", "Pastry"), ("Mystery", "")],
        )

    def test_creation_snapshots_the_submitted_price_and_quantity(self):
        item = self.created_menu()["items"][1]
        self.assertEqual(
            item["original"],
            {"sellPriceCents": 450, "qtySold": 30.0, "foodCostCents": 120},
        )

    def test_an_update_moves_the_live_fields_and_leaves_the_snapshot_alone(self):
        created = self.created_menu()
        first = created["items"][1]
        payload = self.save(
            id=created["menu"]["id"],
            items=[self.row(id=first["id"], sellPriceCents=525, qtySold=44)],
        )
        item = payload["items"][0]
        self.assertEqual(item["sellPriceCents"], 525)
        self.assertEqual(item["qtySold"], 44.0)
        self.assertEqual(item["original"], first["original"])

    def test_an_update_may_change_the_link_and_keeps_the_snapshot(self):
        created = self.save(items=[self.row()])
        kept = created["items"][0]
        payload = self.save(
            id=created["menu"]["id"],
            items=[
                self.row(id=kept["id"], recipeId=None, productId=str(self.product.id))
            ],
        )
        item = payload["items"][0]
        self.assertEqual(item["id"], kept["id"])
        self.assertEqual(item["name"], "Croissant box")
        self.assertEqual(item["productId"], str(self.product.id))
        self.assertIsNone(item["recipeId"])
        self.assertEqual(item["foodCostCents"], 2880)
        self.assertEqual(item["original"]["foodCostCents"], 120)

    def test_an_update_renumbers_positions_from_the_payload_order(self):
        created = self.created_menu()
        reversed_items = list(reversed(created["items"]))
        payload = self.save(
            id=created["menu"]["id"],
            items=[
                self.row(
                    id=item["id"],
                    recipeId=item["recipeId"],
                    productId=item["productId"],
                )
                for item in reversed_items
            ],
        )
        self.assertEqual([item["position"] for item in payload["items"]], [0, 1, 2])
        self.assertEqual(
            [item["name"] for item in payload["items"]],
            [item["name"] for item in reversed_items],
        )

    def test_a_save_always_moves_the_menus_updated_at(self):
        created = self.created_menu()
        menu = Menu.objects.get(id=created["menu"]["id"])
        before = menu.updated_at
        self.save(id=str(menu.id), items=[])
        menu.refresh_from_db()
        self.assertGreater(menu.updated_at, before)

    def test_rows_left_out_of_the_payload_are_deleted(self):
        created = self.created_menu()
        keep = created["items"][0]
        payload = self.save(
            id=created["menu"]["id"], items=[self.product_row(id=keep["id"])]
        )
        self.assertEqual([item["id"] for item in payload["items"]], [keep["id"]])
        self.assertEqual(
            MenuItem.objects.filter(menu_id=created["menu"]["id"]).count(), 1
        )

    def test_a_row_added_later_snapshots_the_price_of_the_day_it_arrived(self):
        created = self.created_menu()
        self.butter.purchase_cost_cents = 2400
        self.butter.save(update_fields=["purchase_cost_cents", "updated_at"])
        payload = self.save(
            id=created["menu"]["id"],
            items=[
                self.row(id=created["items"][1]["id"]),
                self.row(recipeId=str(self.mystery.id)),
            ],
        )
        # Mystery is uncosted, so the day's price shows on the croissant row
        # being live and on a fresh croissant row's snapshot.
        self.assertEqual(payload["items"][0]["original"]["foodCostCents"], 120)
        self.assertEqual(payload["items"][0]["foodCostCents"], 240)
        fresh = self.save(items=[self.row()])["items"][0]
        self.assertEqual(fresh["original"]["foodCostCents"], 240)

    # --- rebaseline ---------------------------------------------------------

    def test_a_plain_save_never_moves_the_baseline(self):
        created = self.created_menu()
        kept = created["items"][1]
        payload = self.save(
            id=created["menu"]["id"],
            items=[self.row(id=kept["id"], sellPriceCents=900, qtySold=5)],
        )
        self.assertEqual(payload["items"][0]["original"], kept["original"])

    def test_rebaseline_freezes_todays_price_quantity_and_food_cost(self):
        created = self.created_menu()
        kept = [created["items"][0], created["items"][1]]
        SalesProductComponent.objects.filter(product=self.product).update(
            quantity=Decimal("1.000")
        )
        payload = self.save(
            id=created["menu"]["id"],
            rebaseline=True,
            items=[
                self.product_row(id=kept[0]["id"], sellPriceCents=1000, qtySold=7),
                self.row(id=kept[1]["id"], sellPriceCents=900, qtySold=5),
            ],
        )
        self.assertEqual(
            [item["original"] for item in payload["items"]],
            [
                {"sellPriceCents": 1000, "qtySold": 7.0, "foodCostCents": 1440},
                {"sellPriceCents": 900, "qtySold": 5.0, "foodCostCents": 120},
            ],
        )

    def test_rebaseline_snapshots_a_brand_new_row_the_same_way(self):
        payload = self.save(rebaseline=True, items=[self.row()])
        self.assertEqual(
            payload["items"][0]["original"],
            {"sellPriceCents": 450, "qtySold": 30.0, "foodCostCents": 120},
        )

    def test_rebaseline_must_be_a_boolean(self):
        with self.assertRaises(ValueError):
            self.save(rebaseline="yes")

    # --- validation ---------------------------------------------------------

    def test_a_blank_name_is_refused(self):
        with self.assertRaises(ValueError):
            self.save(name="   ")

    def test_a_one_sided_period_is_refused(self):
        for period in ({"periodStart": "2026-03-01"}, {"periodEnd": "2026-03-31"}):
            with self.subTest(period=period):
                with self.assertRaisesMessage(
                    ValueError, "Period needs a start and an end"
                ):
                    self.save(**period)

    def test_a_backwards_period_is_refused(self):
        with self.assertRaisesMessage(
            ValueError, "Period start must be on or before period end"
        ):
            self.save(periodStart="2026-03-31", periodEnd="2026-03-01")

    def test_a_period_longer_than_a_year_is_refused(self):
        start = date(2026, 1, 1)
        with self.assertRaisesMessage(ValueError, "Period can cover at most a year"):
            self.save(
                periodStart=start.isoformat(),
                periodEnd=(start + timedelta(days=366)).isoformat(),
            )

    def test_a_period_of_exactly_a_year_is_accepted(self):
        start = date(2026, 1, 1)
        payload = self.save(
            periodStart=start.isoformat(),
            periodEnd=(start + timedelta(days=365)).isoformat(),
        )
        self.assertEqual(payload["menu"]["periodStart"], "2026-01-01")

    def test_more_rows_than_the_limit_are_refused(self):
        with self.assertRaises(ValueError):
            self.save(items=[self.row() for _ in range(501)])

    def test_a_composition_on_a_row_is_refused(self):
        with self.assertRaisesMessage(
            ValueError, "A menu item is a recipe or a product, not a composition"
        ):
            self.save(items=[self.row(components=[])])

    def test_a_row_links_a_recipe_or_a_product_but_never_both(self):
        with self.assertRaisesMessage(
            ValueError, "A menu item is a recipe or a product, not both"
        ):
            self.save(items=[self.row(productId=str(self.product.id))])

    def test_an_unlinked_row_keeps_the_name_it_was_saved_with(self):
        payload = self.save(
            items=[self.row(recipeId=None, name="Daily special", sellPriceCents=800)]
        )
        item = payload["items"][0]
        self.assertEqual(item["name"], "Daily special")
        self.assertEqual(item["sellPriceCents"], 800)
        self.assertIsNone(item["recipeId"])
        self.assertIsNone(item["productId"])
        self.assertIsNone(item["category"])
        self.assertIsNone(item["foodCostCents"])
        self.assertIsNone(item["sourceSellPriceCents"])
        self.assertIsNone(item["sourceQtySold"])

    def test_more_than_one_unlinked_row_is_allowed(self):
        payload = self.save(
            items=[
                self.row(recipeId=None, name="Soup"),
                self.row(recipeId=None, name="Special"),
            ]
        )
        self.assertEqual(
            [item["name"] for item in payload["items"]], ["Soup", "Special"]
        )

    def test_an_unlinked_row_needs_a_name(self):
        for name in ("", "   "):
            with self.subTest(name=name):
                with self.assertRaisesMessage(ValueError, "Name every item"):
                    self.save(items=[self.row(recipeId=None, name=name)])

    def test_the_same_row_may_not_be_listed_twice(self):
        created = self.created_menu()
        existing = created["items"][1]["id"]
        with self.assertRaisesMessage(ValueError, "Menu row listed twice"):
            self.save(
                id=created["menu"]["id"],
                items=[
                    self.row(id=existing),
                    self.row(id=existing, recipeId=str(self.mystery.id)),
                ],
            )

    def test_the_same_product_may_not_be_listed_twice(self):
        with self.assertRaisesMessage(ValueError, "Product listed twice"):
            self.save(items=[self.product_row(), self.product_row()])

    def test_the_same_recipe_may_not_be_listed_twice(self):
        with self.assertRaisesMessage(ValueError, "Recipe listed twice"):
            self.save(items=[self.row(), self.row()])

    def test_an_unknown_product_is_refused(self):
        with self.assertRaisesMessage(ValueError, "Product not found"):
            self.save(items=[self.product_row(productId=str(self.stranger_product.id))])

    def test_another_tenants_recipe_is_refused(self):
        with self.assertRaisesMessage(ValueError, "Recipe not found"):
            self.save(items=[self.row(recipeId=str(self.stranger_recipe.id))])

    def test_another_tenants_menu_cannot_be_saved_over(self):
        with self.assertRaisesMessage(ValueError, "Menu not found"):
            self.save(id=str(self.stranger_menu.id))

    def test_a_row_may_not_migrate_between_the_users_own_menus(self):
        created = self.created_menu()
        other = self.save(name="Autumn", items=[self.row()])
        with self.assertRaisesMessage(ValueError, "Menu row not found"):
            self.save(
                id=created["menu"]["id"],
                items=[self.row(id=other["items"][0]["id"])],
            )

    def test_a_negative_price_is_refused(self):
        with self.assertRaises(ValueError):
            self.save(items=[self.row(sellPriceCents=-1)])

    def test_a_negative_quantity_is_refused(self):
        with self.assertRaises(ValueError):
            self.save(items=[self.row(qtySold=-1)])

    def test_an_absurd_quantity_is_refused(self):
        with self.assertRaises(ValueError):
            self.save(items=[self.row(qtySold=1_000_001)])

    def test_items_must_be_a_list_of_objects(self):
        with self.assertRaises(ValueError):
            self.save(items="everything")
        with self.assertRaises(ValueError):
            self.save(items=["Croissant"])

    def test_the_save_query_count_does_not_grow_with_rows(self):
        recipes = [
            Recipe.objects.create(
                user=self.user,
                title=f"Dish {index}",
                body="1200 g Butter",
                yield_amount=12.0,
                yield_unit="pcs",
            )
            for index in range(12)
        ]
        # Two fresh menus, so both saves write the same statements and only the
        # number of rows behind them differs.
        with CaptureQueriesContext(connection) as small:
            self.save(
                name="Small",
                items=[self.row(recipeId=str(recipe.id)) for recipe in recipes[:2]],
            )
        with CaptureQueriesContext(connection) as large:
            self.save(
                name="Large",
                items=[self.row(recipeId=str(recipe.id)) for recipe in recipes],
            )

        self.assertEqual(
            len(large),
            len(small),
            "A whole-menu save batches its writes and its ownership lookups. "
            "A per-row query here makes saving a 500-row worksheet O(rows)",
        )

    # --- rows outliving what they point at -----------------------------------

    def test_deleting_the_linked_product_is_blocked_by_the_saved_menu(self):
        created = self.created_menu()
        SalesProductComponent.objects.filter(product=self.product).delete()
        with self.assertRaisesMessage(ValueError, "saved menus"):
            action_delete_sales_product(self.user, {"id": str(self.product.id)})
        item = menu_detail_payload(
            self.user, Menu.objects.get(id=created["menu"]["id"])
        )["items"][0]
        self.assertEqual(item["productId"], str(self.product.id))
        self.assertIsNone(item["foodCostCents"])
        self.assertEqual(item["original"]["foodCostCents"], 2880)

    def test_deleting_a_recipe_a_product_uses_is_protected(self):
        created = self.created_menu()
        with self.assertRaisesMessage(ValueError, "used by a product"):
            action_delete_recipe(self.user, {"id": str(self.croissant.id)})
        item = menu_detail_payload(
            self.user, Menu.objects.get(id=created["menu"]["id"])
        )["items"][1]
        self.assertEqual(item["recipeId"], str(self.croissant.id))

    def test_deleting_a_linked_recipe_takes_its_row_with_it(self):
        created = self.created_menu()
        action_delete_recipe(self.user, {"id": str(self.mystery.id)})
        payload = menu_detail_payload(
            self.user, Menu.objects.get(id=created["menu"]["id"])
        )
        self.assertEqual(
            [item["name"] for item in payload["items"]], ["Croissant box", "Croissant"]
        )


class MenuDeleteTests(MenuFixture, TestCase):
    @classmethod
    def setUpTestData(cls) -> None:
        cls.build_workspace()

    def test_deleting_a_menu_takes_its_rows_with_it(self):
        menu = Menu.objects.create(user=self.user, name="Spring")
        MenuItem.objects.create(
            menu=menu,
            position=0,
            name="Croissant",
            recipe=self.croissant,
            sell_price_cents=450,
            original_sell_price_cents=450,
        )
        self.assertEqual(
            action_delete_menu(self.user, {"id": str(menu.id)}), {"ok": True}
        )
        self.assertFalse(Menu.objects.filter(id=menu.id).exists())
        self.assertFalse(MenuItem.objects.filter(menu_id=menu.id).exists())
        self.assertTrue(Recipe.objects.filter(id=self.croissant.id).exists())

    def test_deleting_an_unknown_menu_is_refused(self):
        with self.assertRaisesMessage(ValueError, "Menu not found"):
            action_delete_menu(
                self.user, {"id": "00000000-0000-0000-0000-000000000000"}
            )

    def test_deleting_another_tenants_menu_is_refused(self):
        with self.assertRaisesMessage(ValueError, "Menu not found"):
            action_delete_menu(self.user, {"id": str(self.stranger_menu.id)})
        self.assertTrue(Menu.objects.filter(id=self.stranger_menu.id).exists())


class ProductCategoryVocabularyTests(MenuFixture, TestCase):
    @classmethod
    def setUpTestData(cls) -> None:
        cls.build_workspace()

    def test_the_vocabulary_is_the_tenants_distinct_non_blank_categories(self):
        for name, category in (
            ("Sourdough", "breads"),
            ("Baguette", "breads"),
            ("Brioche", "Pastry"),
            ("Plain roll", ""),
        ):
            SalesProduct.objects.create(
                user=self.user,
                name=name,
                normalized_name=normalized_name(name),
                category=category,
            )
        SalesProduct.objects.filter(id=self.stranger_product.id).update(
            category="Their shelf"
        )
        payload = internal_payload(product_categories, self.user)
        self.assertEqual(
            payload["items"],
            [
                {"id": "breads", "label": "breads"},
                {"id": "Pastry", "label": "Pastry"},
            ],
        )
