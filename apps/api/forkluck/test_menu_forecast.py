from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP

from django.test import RequestFactory, TestCase

from .domains.sales.forecast import (
    _seasonal_factor,
    menu_forecast_payload,
    project_product,
)
from .domains.sales.views import menu_forecast
from .models import (
    BenchCostSettings,
    Ingredient,
    Menu,
    MenuItem,
    Recipe,
    RecipeItem,
    SalesProductVariant,
    SalesImport,
    SalesLine,
    SalesLineModifier,
    SalesProduct,
    SalesProductComponent,
    User,
)


class MenuForecastTests(TestCase):
    today = date(2026, 4, 27)

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="forecast@example.com",
            name="Forecast Chef",
            password="a-long-test-passphrase-2468",
        )
        BenchCostSettings.objects.create(
            user=self.user,
            timezone="UTC",
            currency_code="USD",
        )
        self.sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="sales.csv",
            source=SalesImport.Source.CSV,
            channel=SalesImport.Channel.SQUARE,
            timezone="UTC",
            currency_code="USD",
        )
        self.counter = 0

    def product(self, name: str, *, active: bool = True) -> SalesProduct:
        return SalesProduct.objects.create(
            user=self.user,
            name=name,
            normalized_name=name.casefold(),
            is_active=active,
        )

    def menu(self, *products: SalesProduct | None) -> Menu:
        menu = Menu.objects.create(user=self.user, name="Breakfast")
        for position, product in enumerate(products):
            MenuItem.objects.create(
                menu=menu,
                position=position,
                name=product.name if product else "Unlinked item",
                sell_price_cents=0,
                original_sell_price_cents=0,
                product=product,
            )
        return menu

    def variant(
        self,
        product: SalesProduct | None,
        *,
        multiplier: str = "1",
        key: str | None = None,
    ) -> SalesProductVariant:
        return SalesProductVariant.objects.create(
            user=self.user,
            product=product,
            channel=SalesImport.Channel.SQUARE,
            match_key=key or f"forecast:{self.counter}:{product.id if product else 'set'}",
            external_name=product.name if product else "Set menu",
            quantity_multiplier=Decimal(multiplier),
        )

    def line(
        self,
        variant: SalesProductVariant,
        sold_on: date,
        *,
        quantity: str = "1",
    ) -> SalesLine:
        self.counter += 1
        return SalesLine.objects.create(
            user=self.user,
            sales_import=self.sales_import,
            variant=variant,
            channel=SalesImport.Channel.SQUARE,
            source_position=self.counter,
            source_fingerprint=f"forecast-{self.counter}",
            external_order_id=f"order-{self.counter}",
            sold_at=datetime.combine(sold_on, datetime.min.time(), tzinfo=timezone.utc),
            timezone="UTC",
            item_name=variant.external_name,
            quantity=Decimal(quantity),
        )

    @staticmethod
    def cents(value: Decimal) -> int:
        return int(value.quantize(Decimal(1), rounding=ROUND_HALF_UP))

    @staticmethod
    def product_row(payload, product: SalesProduct):
        return next(row for row in payload["products"] if row["productId"] == str(product.id))

    def test_matching_weekdays_include_zeroes_and_clamp_only_final_negative(self):
        coffee = self.product("Coffee", active=False)
        returns = self.product("Returns")
        menu = self.menu(coffee, returns, None)
        variant = self.variant(coffee)
        return_variant = self.variant(returns)
        # The four Mondays before 2026-04-27: 30 Mar, 6/13/20 Apr.
        self.line(variant, date(2026, 3, 30), quantity="4")
        self.line(variant, date(2026, 4, 13), quantity="8")
        self.line(variant, date(2026, 4, 20), quantity="-4")
        for sold_on in (
            date(2026, 3, 30),
            date(2026, 4, 6),
            date(2026, 4, 13),
            date(2026, 4, 20),
        ):
            self.line(return_variant, sold_on, quantity="-1")

        payload = menu_forecast_payload(self.user, menu, today=self.today)
        row = self.product_row(payload, coffee)

        # Only the Monday in the horizon has history, and only back to the
        # first sale: samples -4, 8, 0, 4 weighted 1, .8, .64, .512.
        self.assertEqual(row["totalQuantity"], 1.507)
        self.assertEqual(row["weeksObserved"], 3)
        self.assertFalse(row["isActive"])
        # A negative average is a return, not demand: it clamps rather than
        # subtracting from the other days of the horizon.
        self.assertEqual(self.product_row(payload, returns)["totalQuantity"], 0.0)
        self.assertEqual(payload["basis"]["historyStart"], "2026-03-02")
        self.assertEqual(payload["basis"]["historyWeeks"], 8)
        self.assertEqual(payload["basis"]["plan"], "typical")
        self.assertFalse(payload["basis"]["seasonalAdjustment"])
        self.assertEqual(payload["basis"]["horizonEnd"], "2026-05-03")
        self.assertEqual(payload["basis"]["horizonDays"], 7)
        self.assertEqual(payload["unresolved"][0]["code"], "unlinked-menu-item")

    def test_a_boxs_contents_join_the_menu_and_modifiers_need_an_in_menu_base(self):
        espresso = self.product("Espresso")
        cookie = self.product("Cookie")
        sprinkles = self.product("Sprinkles")
        other = self.product("Other")
        box = self.product("Box")
        SalesProductComponent.objects.create(
            product=box, component_product=espresso, quantity=1, position=0
        )
        SalesProductComponent.objects.create(
            product=box, component_product=cookie, quantity=3, position=1
        )
        menu = self.menu(box)
        box_variant = self.variant(box, key="forecast:box")
        sprinkles_variant = self.variant(sprinkles, key="forecast:sprinkles")
        sale = self.line(box_variant, date(2026, 4, 20), quantity="2")
        SalesLineModifier.objects.create(
            user=self.user,
            sales_line=sale,
            variant=sprinkles_variant,
            source_fingerprint="forecast-sprinkles",
            name="Sprinkles",
            match_key="forecast:sprinkles",
            quantity=Decimal("2"),
        )
        # The same modifier on an out-of-menu base must not enter this menu.
        other_sale = self.line(self.variant(other), date(2026, 4, 13))
        SalesLineModifier.objects.create(
            user=self.user,
            sales_line=other_sale,
            variant=sprinkles_variant,
            source_fingerprint="forecast-sprinkles-outside",
            name="Sprinkles",
            match_key="forecast:sprinkles",
            quantity=Decimal("9"),
        )

        payload = menu_forecast_payload(self.user, menu, today=self.today)
        espresso_row = self.product_row(payload, espresso)
        cookie_row = self.product_row(payload, cookie)
        sprinkles_row = self.product_row(payload, sprinkles)

        self.assertEqual(self.product_row(payload, box)["totalQuantity"], 2.0)
        self.assertEqual(espresso_row["totalQuantity"], 2.0)
        self.assertEqual(cookie_row["totalQuantity"], 6.0)
        self.assertFalse(espresso_row["menuMember"], "the menu names the box, not its contents")
        self.assertEqual(sprinkles_row["totalQuantity"], 4.0)
        self.assertFalse(sprinkles_row["menuMember"])

    def test_a_menu_of_the_box_needs_the_same_materials_as_a_menu_of_its_contents(self):
        """Whichever way the merchant lists it, the kitchen makes the same things."""
        flour = Ingredient.objects.create(
            user=self.user,
            name="Bundle flour",
            normalized_name="bundle flour",
            purchase_cost_cents=0,
            purchase_size=1000,
            purchase_unit="g",
        )
        espresso = self.product("Espresso")
        cookie = self.product("Cookie")
        for product, grams in ((espresso, 5), (cookie, 10)):
            SalesProductComponent.objects.create(
                product=product, ingredient=flour, quantity=grams, unit="g"
            )
        box = self.product("Box")
        SalesProductComponent.objects.create(
            product=box, component_product=espresso, quantity=1, position=0
        )
        SalesProductComponent.objects.create(
            product=box, component_product=cookie, quantity=3, position=1
        )
        box_variant = self.variant(box, key="forecast:box")
        for sold_on in (date(2026, 3, 30), date(2026, 4, 6), date(2026, 4, 13), date(2026, 4, 20)):
            self.line(box_variant, sold_on, quantity="2")

        box_menu = self.menu(box)
        contents_menu = self.menu(espresso, cookie)

        box_materials = menu_forecast_payload(self.user, box_menu, today=self.today)[
            "materialRequirements"
        ]
        contents_materials = menu_forecast_payload(
            self.user, contents_menu, today=self.today
        )["materialRequirements"]

        self.assertEqual(box_materials, contents_materials)
        (row,) = box_materials
        # One matching weekday in the horizon: 2 boxes, so 2 espressos at 5 g
        # and 6 cookies at 10 g.
        self.assertEqual(row["usage"], [{"quantity": 70.0, "unit": "g"}])

    def test_rounds_half_up_and_each_saved_menu_gets_an_independent_forecast(self):
        product = self.product("Tiny batch")
        variant = self.variant(product)
        self.line(variant, date(2026, 4, 20), quantity="0.002")
        first = self.menu(product)
        second = self.menu(product)

        first_payload = menu_forecast_payload(self.user, first, today=self.today)
        second_payload = menu_forecast_payload(self.user, second, today=self.today)

        self.assertEqual(first_payload["products"][0]["totalQuantity"], 0.002)
        self.assertEqual(second_payload["products"][0]["totalQuantity"], 0.002)

    def test_current_composition_expands_recipes_and_supplies_without_prices(self):
        product = self.product("Sandwich")
        menu = self.menu(product)
        variant = self.variant(product)
        for sold_on in (date(2026, 3, 30), date(2026, 4, 6), date(2026, 4, 13), date(2026, 4, 20)):
            self.line(variant, sold_on, quantity="4")
        flour = Ingredient.objects.create(
            user=self.user,
            name="Flour",
            normalized_name="flour",
            purchase_cost_cents=0,
            purchase_size=1000,
            purchase_unit="g",
        )
        wrapper = Ingredient.objects.create(
            user=self.user,
            name="Wrapper",
            normalized_name="wrapper",
            purchase_cost_cents=0,
            purchase_size=None,
            purchase_unit=None,
            non_edible=True,
        )
        recipe = Recipe.objects.create(
            user=self.user,
            title="Bread",
            code="forecast-bread",
            yield_amount=100,
            yield_unit="g",
        )
        RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.INGREDIENT,
            position=0,
            ingredient=flour,
            quantity=Decimal("20"),
            unit="g",
        )
        SalesProductComponent.objects.create(
            product=product,
            recipe=recipe,
            quantity=Decimal("2"),
        )
        SalesProductComponent.objects.create(
            product=product,
            ingredient=wrapper,
            quantity=Decimal("3"),
            unit="g",
            position=1,
        )

        payload = menu_forecast_payload(self.user, menu, today=self.today)
        self.assertEqual(payload["products"][0]["totalQuantity"], 4.0)
        self.assertEqual(payload["recipeRequirements"][0]["batches"], 8.0)
        materials = {row["ingredientId"]: row for row in payload["materialRequirements"]}
        self.assertEqual(materials[str(flour.id)]["usage"], [{"quantity": 160.0, "unit": "g"}])
        self.assertEqual(materials[str(flour.id)]["purchase"], [{"quantity": 160.0, "unit": "g"}])
        self.assertEqual(materials[str(wrapper.id)]["kind"], "supply")
        self.assertEqual(materials[str(wrapper.id)]["usage"], [{"quantity": 12.0, "unit": "g"}])
        self.assertTrue(
            any(issue["code"] == "missing-purchase-size" for issue in payload["unresolved"])
        )

    def test_a_measured_component_plans_its_share_of_the_batch(self):
        product = self.product("Tub 250 g")
        menu = self.menu(product)
        variant = self.variant(product)
        for sold_on in (date(2026, 3, 30), date(2026, 4, 6), date(2026, 4, 13), date(2026, 4, 20)):
            self.line(variant, sold_on, quantity="4")
        flour = Ingredient.objects.create(
            user=self.user,
            name="Flour",
            normalized_name="flour",
            purchase_cost_cents=0,
            purchase_size=1000,
            purchase_unit="g",
        )
        recipe = Recipe.objects.create(
            user=self.user,
            title="Bread",
            code="forecast-tub",
            yield_amount=1000,
            yield_unit="g",
        )
        RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.INGREDIENT,
            position=0,
            ingredient=flour,
            quantity=Decimal("200"),
            unit="g",
        )
        SalesProductComponent.objects.create(
            product=product, recipe=recipe, quantity=Decimal("250"), unit="g"
        )

        payload = menu_forecast_payload(self.user, menu, today=self.today)
        # Four tubs of a quarter batch each: one batch to make, its flour once.
        self.assertEqual(payload["products"][0]["totalQuantity"], 4.0)
        self.assertEqual(payload["recipeRequirements"][0]["batches"], 1.0)
        materials = {row["ingredientId"]: row for row in payload["materialRequirements"]}
        self.assertEqual(materials[str(flour.id)]["usage"], [{"quantity": 200.0, "unit": "g"}])

    def test_a_family_the_yield_does_not_state_is_unresolved_not_planned(self):
        product = self.product("Tub 500 g")
        menu = self.menu(product)
        variant = self.variant(product)
        self.line(variant, date(2026, 4, 20), quantity="4")
        recipe = Recipe.objects.create(
            user=self.user, title="Rolls", yield_amount=12, yield_unit="pcs"
        )
        component = SalesProductComponent.objects.create(
            product=product, recipe=recipe, quantity=Decimal("500"), unit="g"
        )

        payload = menu_forecast_payload(self.user, menu, today=self.today)
        self.assertEqual(payload["recipeRequirements"], [])
        self.assertIn(
            {
                "code": "unresolved-yield",
                "path": [str(product.id), str(component.id)],
                "detail": "mass",
                "recipeId": str(recipe.id),
            },
            payload["unresolved"],
        )

    def test_a_bundle_expands_into_its_members_and_keeps_its_own_supplies(self):
        box = self.product("Gift box")
        cookie = self.product("Cookie")
        brownie = self.product("Brownie")
        menu = self.menu(box)
        variant = self.variant(box)
        for sold_on in (date(2026, 3, 30), date(2026, 4, 6), date(2026, 4, 13), date(2026, 4, 20)):
            self.line(variant, sold_on, quantity="2")
        flour = Ingredient.objects.create(
            user=self.user,
            name="Flour",
            normalized_name="flour",
            purchase_cost_cents=0,
            purchase_size=1000,
            purchase_unit="g",
        )
        sugar = Ingredient.objects.create(
            user=self.user,
            name="Sugar",
            normalized_name="sugar",
            purchase_cost_cents=0,
            purchase_size=1000,
            purchase_unit="g",
        )
        ribbon = Ingredient.objects.create(
            user=self.user,
            name="Ribbon",
            normalized_name="ribbon",
            purchase_cost_cents=0,
            purchase_size=1000,
            purchase_unit="g",
            non_edible=True,
        )
        recipe = Recipe.objects.create(
            user=self.user,
            title="Cookie dough",
            code="forecast-dough",
            yield_amount=100,
            yield_unit="g",
        )
        RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.INGREDIENT,
            position=0,
            ingredient=flour,
            quantity=Decimal("20"),
            unit="g",
        )
        SalesProductComponent.objects.create(
            product=cookie, recipe=recipe, quantity=Decimal("1")
        )
        SalesProductComponent.objects.create(
            product=brownie, ingredient=sugar, quantity=Decimal("5"), unit="g"
        )
        SalesProductComponent.objects.create(
            product=box, component_product=cookie, quantity=Decimal("3")
        )
        SalesProductComponent.objects.create(
            product=box, component_product=brownie, quantity=Decimal("1"), position=1
        )
        SalesProductComponent.objects.create(
            product=box,
            ingredient=ribbon,
            quantity=Decimal("4"),
            unit="g",
            position=2,
        )

        payload = menu_forecast_payload(self.user, menu, today=self.today)
        self.assertEqual(payload["products"][0]["totalQuantity"], 2.0)
        self.assertEqual(payload["recipeRequirements"][0]["batches"], 6.0)
        materials = {row["ingredientId"]: row for row in payload["materialRequirements"]}
        self.assertEqual(materials[str(flour.id)]["usage"], [{"quantity": 120.0, "unit": "g"}])
        self.assertEqual(materials[str(sugar.id)]["usage"], [{"quantity": 10.0, "unit": "g"}])
        # The ribbon ties the box, not each thing inside it.
        self.assertEqual(materials[str(ribbon.id)]["usage"], [{"quantity": 8.0, "unit": "g"}])
        self.assertFalse(payload["unresolved"])

    def test_nested_recipes_apply_batch_share_efficiency_and_purchase_yield(self):
        product = self.product("Nested loaf")
        menu = self.menu(product)
        variant = self.variant(product)
        for sold_on in (
            date(2026, 3, 30),
            date(2026, 4, 6),
            date(2026, 4, 13),
            date(2026, 4, 20),
        ):
            self.line(variant, sold_on, quantity="4")
        flour = Ingredient.objects.create(
            user=self.user,
            name="Nested flour",
            normalized_name="nested flour",
            purchase_cost_cents=0,
            purchase_size=1000,
            purchase_unit="g",
            yield_percent=80,
        )
        child = Recipe.objects.create(
            user=self.user,
            title="Starter",
            yield_amount=100,
            yield_unit="g",
        )
        RecipeItem.objects.create(
            recipe=child,
            kind=RecipeItem.INGREDIENT,
            position=0,
            ingredient=flour,
            quantity=Decimal("20"),
            unit="g",
            efficiency=Decimal("50"),
            excluded_from_cost=True,
        )
        root = Recipe.objects.create(
            user=self.user,
            title="Nested loaf recipe",
            yield_amount=100,
            yield_unit="g",
        )
        RecipeItem.objects.create(
            recipe=root,
            kind=RecipeItem.SUBRECIPE,
            position=0,
            subrecipe=child,
            quantity=Decimal("50"),
            unit="g",
        )
        SalesProductComponent.objects.create(
            product=product,
            recipe=root,
            quantity=Decimal("2"),
        )

        payload = menu_forecast_payload(self.user, menu, today=self.today)
        material = payload["materialRequirements"][0]

        self.assertEqual(payload["recipeRequirements"][0]["batches"], 8.0)
        self.assertEqual(material["usage"], [{"quantity": 80.0, "unit": "g"}])
        self.assertEqual(material["purchase"], [{"quantity": 200.0, "unit": "g"}])
        self.assertFalse(payload["unresolved"])

    def test_recipe_cycles_are_reported_as_unresolved_paths(self):
        product = self.product("Cyclic special")
        menu = self.menu(product)
        variant = self.variant(product)
        self.line(variant, date(2026, 4, 20), quantity="4")
        first = Recipe.objects.create(
            user=self.user,
            title="Cycle A",
            yield_amount=1,
            yield_unit="each",
        )
        second = Recipe.objects.create(
            user=self.user,
            title="Cycle B",
            yield_amount=1,
            yield_unit="each",
        )
        RecipeItem.objects.create(
            recipe=first,
            kind=RecipeItem.SUBRECIPE,
            position=0,
            subrecipe=second,
            quantity=1,
            unit="each",
        )
        RecipeItem.objects.create(
            recipe=second,
            kind=RecipeItem.SUBRECIPE,
            position=0,
            subrecipe=first,
            quantity=1,
            unit="each",
        )
        SalesProductComponent.objects.create(product=product, recipe=first, quantity=1)

        payload = menu_forecast_payload(self.user, menu, today=self.today)
        cycle = next(issue for issue in payload["unresolved"] if issue["code"] == "recipe-cycle")

        self.assertGreaterEqual(len(cycle["path"]), 5)

    def test_a_thirty_day_horizon_sums_every_matching_weekday_it_covers(self):
        product = self.product("Croissant")
        menu = self.menu(product)
        variant = self.variant(product)
        for monday in (
            date(2026, 3, 30),
            date(2026, 4, 6),
            date(2026, 4, 13),
            date(2026, 4, 20),
        ):
            self.line(variant, monday, quantity="4")
        self.line(variant, date(2026, 4, 21), quantity="8")

        week = menu_forecast_payload(self.user, menu, today=self.today)
        month = menu_forecast_payload(
            self.user, menu, today=self.today, horizon_days=30
        )

        # Mondays average 4; Tuesdays weight one sale of 8 against three empty
        # Tuesdays for 2.71. The week holds one of each; the month holds five
        # of each, and the fifth Monday reads the same sold Mondays as the
        # first.
        self.assertEqual(week["products"][0]["totalQuantity"], 6.71)
        self.assertEqual(month["products"][0]["totalQuantity"], 33.55)
        self.assertEqual(month["basis"]["horizonDays"], 30)
        self.assertEqual(month["basis"]["horizonEnd"], "2026-05-26")

    def test_weeks_observed_counts_the_history_weeks_a_product_sold_in(self):
        twice = self.product("Twice")
        never = self.product("Never")
        menu = self.menu(twice, never)
        variant = self.variant(twice)
        # Two sales share the newest week; the third falls in the oldest.
        self.line(variant, date(2026, 4, 21))
        self.line(variant, date(2026, 4, 25))
        self.line(variant, date(2026, 3, 30))

        payload = menu_forecast_payload(self.user, menu, today=self.today)

        self.assertEqual(self.product_row(payload, twice)["weeksObserved"], 2)
        self.assertEqual(self.product_row(payload, never)["weeksObserved"], 0)

    def test_recent_weeks_weigh_more_than_older_ones(self):
        rising = self.product("Rising")
        fading = self.product("Fading")
        menu = self.menu(rising, fading)
        rising_variant = self.variant(rising)
        fading_variant = self.variant(fading)
        self.line(rising_variant, date(2026, 4, 13), quantity="2")
        self.line(rising_variant, date(2026, 4, 20), quantity="10")
        self.line(fading_variant, date(2026, 4, 13), quantity="10")
        self.line(fading_variant, date(2026, 4, 20), quantity="2")

        payload = menu_forecast_payload(self.user, menu, today=self.today)

        # The same two Mondays either way round: (10 + .8·2) / 1.8 against
        # (2 + .8·10) / 1.8.
        self.assertEqual(self.product_row(payload, rising)["totalQuantity"], 6.444)
        self.assertEqual(self.product_row(payload, fading)["totalQuantity"], 5.556)

    def test_samples_start_when_the_product_started_existing(self):
        ledger = self.product("Ledger anchored")
        made = self.product("Made in January")
        menu = self.menu(ledger, made)
        self.line(self.variant(ledger), date(2026, 4, 20), quantity="6")
        self.line(self.variant(made), date(2026, 4, 20), quantity="6")
        SalesProduct.objects.filter(id=made.id).update(
            created_at=datetime(2026, 1, 1, tzinfo=timezone.utc)
        )

        payload = menu_forecast_payload(self.user, menu, today=self.today)

        # Created after the dates it is forecast from, so the first sale is the
        # anchor and last Monday is the only sample it can honestly have.
        self.assertEqual(self.product_row(payload, ledger)["totalQuantity"], 6.0)
        # Made in January, so the seven quiet Mondays since are real zeroes.
        self.assertEqual(self.product_row(payload, made)["totalQuantity"], 1.442)

    def test_busy_pools_variance_over_the_horizon_not_over_daily_peaks(self):
        projection = project_product(
            {date(2026, 4, 20): Decimal(4), date(2026, 4, 21): Decimal(4)},
            exists_from=date(2026, 4, 13),
            history_end=date(2026, 4, 26),
            horizon_start=self.today,
            horizon_days=7,
        )

        self.assertEqual(projection.typical_total, Decimal("4.444"))
        self.assertEqual(projection.busy_total, Decimal("8.042"))
        # Two busy days do not land in the same week as often as adding their
        # own P90s together would have the kitchen believe.
        daily_peaks = projection.typical_total + sum(
            (
                Decimal("1.28") * day.variance.sqrt()
                for day in projection.days.values()
            ),
            Decimal(),
        )
        self.assertLess(projection.busy_total, daily_peaks)

    def test_menu_busy_money_pools_variance_across_products(self):
        latte = self.product("Latte")
        scone = self.product("Scone")
        menu = self.menu(latte, scone)
        MenuItem.objects.filter(menu=menu, product=latte).update(sell_price_cents=500)
        MenuItem.objects.filter(menu=menu, product=scone).update(sell_price_cents=300)
        latte_variant = self.variant(latte)
        scone_variant = self.variant(scone)
        history = {
            latte_variant: {
                date(2026, 4, 13): "2",
                date(2026, 4, 14): "1",
                date(2026, 4, 20): "10",
                date(2026, 4, 21): "5",
            },
            scone_variant: {date(2026, 4, 13): "5", date(2026, 4, 20): "6"},
        }
        for variant, days in history.items():
            for sold_on, quantity in days.items():
                self.line(variant, sold_on, quantity=quantity)

        payload = menu_forecast_payload(self.user, menu, today=self.today)
        revenue = payload["revenue"]

        typical = 0
        variance = Decimal()
        own_busy = 0
        for variant, price in ((latte_variant, 500), (scone_variant, 300)):
            projection = project_product(
                {day: Decimal(qty) for day, qty in history[variant].items()},
                exists_from=date(2026, 4, 13),
                history_end=date(2026, 4, 26),
                horizon_start=self.today,
                horizon_days=7,
            )
            for entry in projection.days.values():
                typical += self.cents(entry.typical * price)
                variance += Decimal(price) ** 2 * entry.variance
            own_busy += self.cents(projection.busy_total * price)
        busy = typical + self.cents(Decimal("1.28") * variance.sqrt())

        self.assertEqual(revenue["typicalCents"], typical)
        self.assertEqual(revenue["busyCents"], busy)
        # One menu-level rush, not both products' rushes landing the same week.
        self.assertLess(revenue["busyCents"], own_busy)
        self.assertEqual(
            sum(
                row["typicalCents"]
                for row in payload["series"]
                if row["actualCents"] is None
            ),
            revenue["typicalCents"],
        )

    def test_only_menu_members_are_priced_and_a_zero_price_is_unpriced(self):
        latte = self.product("Latte")
        water = self.product("Water")
        scone = self.product("Scone")
        espresso = self.product("Espresso")
        box = self.product("Box")
        SalesProductComponent.objects.create(
            product=box, component_product=espresso, quantity=1
        )
        SalesProduct.objects.filter(id=water.id).update(sell_price_cents=300)
        SalesProduct.objects.filter(id=espresso.id).update(sell_price_cents=900)
        menu = self.menu(latte, water, scone, box)
        MenuItem.objects.filter(menu=menu, product=latte).update(sell_price_cents=500)
        self.line(self.variant(latte), date(2026, 4, 20), quantity="2")
        self.line(self.variant(water), date(2026, 4, 20), quantity="1")
        self.line(self.variant(box, key="forecast:box"), date(2026, 4, 20), quantity="3")

        revenue = menu_forecast_payload(self.user, menu, today=self.today)["revenue"]

        # Two lattes at the menu's price plus one water at the product's; the
        # espressos inside the boxes are demand the box's money already covers.
        self.assertEqual(revenue["currencyCode"], "USD")
        self.assertEqual(revenue["typicalCents"], 1300)
        self.assertEqual(revenue["plannedCents"], 1300)
        self.assertEqual(revenue["pricedProducts"], 2)
        self.assertEqual(revenue["unpricedProducts"], 2)

    def test_series_bridges_the_last_history_day_into_the_horizon(self):
        scone = self.product("Scone")
        menu = self.menu(scone)
        MenuItem.objects.filter(menu=menu).update(sell_price_cents=200)
        self.line(self.variant(scone), date(2026, 4, 26), quantity="3")

        series = menu_forecast_payload(self.user, menu, today=self.today)["series"]
        bridge = series[27]

        self.assertEqual(len(series), 35)
        self.assertEqual(series[0]["date"], "2026-03-30")
        self.assertIsNone(series[26]["typicalCents"])
        self.assertEqual(bridge["date"], "2026-04-26")
        self.assertEqual(
            (bridge["actualCents"], bridge["typicalCents"], bridge["busyCents"]),
            (600, 600, 600),
        )
        self.assertEqual(series[28]["date"], "2026-04-27")
        self.assertIsNone(series[28]["actualCents"])

    def test_backtest_replays_the_live_projection_at_four_past_weeks(self):
        toast = self.product("Toast")
        menu = self.menu(toast)
        MenuItem.objects.filter(menu=menu).update(sell_price_cents=500)
        variant = self.variant(toast)
        for monday in (
            date(2026, 3, 30),
            date(2026, 4, 6),
            date(2026, 4, 13),
            date(2026, 4, 20),
        ):
            self.line(variant, monday, quantity="4")

        backtest = menu_forecast_payload(self.user, menu, today=self.today)["backtest"]
        replay = project_product(
            {date(2026, 3, 30): Decimal(4), date(2026, 4, 6): Decimal(4)},
            exists_from=date(2026, 3, 30),
            history_end=date(2026, 4, 12),
            horizon_start=date(2026, 4, 13),
            horizon_days=7,
        )

        self.assertEqual(backtest["weeks"][0]["start"], "2026-03-30")
        self.assertEqual(backtest["weeks"][2]["start"], "2026-04-13")
        self.assertEqual(replay.typical_total, Decimal("4.000"))
        self.assertEqual(backtest["weeks"][2]["typicalCents"], 2000)
        # The oldest week predates the first sale, so it forecast nothing
        # against 2000 of actual: 2000 missed out of 8000 sold.
        self.assertEqual(backtest["weeks"][0]["typicalCents"], 0)
        self.assertEqual(backtest["scoredWeeks"], 4)
        self.assertEqual(backtest["errorPercent"], 25.0)
        self.assertEqual(backtest["busyCoveredWeeks"], 3)

    def test_backtest_has_no_accuracy_without_sales_in_the_scored_weeks(self):
        menu = self.menu(self.product("Toast"))
        MenuItem.objects.filter(menu=menu).update(sell_price_cents=500)

        backtest = menu_forecast_payload(self.user, menu, today=self.today)["backtest"]

        self.assertEqual(len(backtest["weeks"]), 4)
        self.assertEqual(backtest["scoredWeeks"], 0)
        self.assertIsNone(backtest["errorPercent"])
        self.assertEqual(backtest["busyCoveredWeeks"], 0)

    # Last year's windows for today=2026-04-27, both shifted back 364 days:
    # the eight history weeks end 2025-04-27 and the horizon runs from the
    # 2025-04-28 Monday.
    LAST_YEAR_HISTORY_START = date(2025, 3, 3)
    LAST_YEAR_HORIZON_START = date(2025, 4, 28)

    @staticmethod
    def days(start: date, count: int, quantity: str) -> dict[date, Decimal]:
        return {
            start + timedelta(days=offset): Decimal(quantity)
            for offset in range(count)
        }

    def factor(
        self, daily: dict[date, Decimal], *, exists_from: date | None = None
    ) -> Decimal:
        return _seasonal_factor(
            daily,
            exists_from=exists_from,
            history_end=date(2026, 4, 26),
            horizon_start=self.today,
            horizon_days=7,
        )

    def test_the_seasonal_factor_halves_last_years_deviation(self):
        factor = self.factor(
            {
                **self.days(self.LAST_YEAR_HISTORY_START, 56, "1"),
                **self.days(self.LAST_YEAR_HORIZON_START, 7, "2"),
            }
        )

        # Twice the baseline last year, so half of that lift carries over.
        self.assertEqual(factor, Decimal("1.5"))

    def test_the_seasonal_factor_clamps_at_half_and_double(self):
        history = self.days(self.LAST_YEAR_HISTORY_START, 56, "1")

        busy = self.factor(
            {**history, **self.days(self.LAST_YEAR_HORIZON_START, 7, "10")}
        )
        quiet = self.factor(
            {**history, **self.days(self.LAST_YEAR_HORIZON_START, 7, "0.001")}
        )

        # Ten times last year would damp to 5.5; nobody orders five times.
        self.assertEqual(busy, Decimal(2))
        # A window that sold anything at all cannot damp below half, so the
        # floor is the guarantee rather than a number often reached.
        self.assertEqual(quiet, Decimal("0.5005"))
        self.assertGreaterEqual(quiet, Decimal("0.5"))

    def test_the_seasonal_factor_needs_both_windows(self):
        self.assertEqual(self.factor({}), Decimal(1))
        self.assertEqual(
            self.factor(self.days(self.LAST_YEAR_HISTORY_START, 56, "1")), Decimal(1)
        )
        self.assertEqual(
            self.factor(self.days(self.LAST_YEAR_HORIZON_START, 7, "2")), Decimal(1)
        )

    def test_the_seasonal_windows_shift_back_whole_weeks(self):
        history = self.days(self.LAST_YEAR_HISTORY_START, 56, "1")

        aligned = self.factor({**history, self.LAST_YEAR_HORIZON_START: Decimal(14)})
        one_day_earlier = self.factor(
            {**history, self.LAST_YEAR_HORIZON_START - timedelta(days=1): Decimal(14)}
        )

        # 364 days back is the same weekday, not the same calendar date.
        self.assertEqual(self.LAST_YEAR_HORIZON_START.weekday(), self.today.weekday())
        self.assertEqual(aligned, Decimal("1.5"))
        # A day earlier falls in last year's history instead, leaving the
        # horizon window empty and the factor at one.
        self.assertEqual(one_day_earlier, Decimal(1))

    def sold_mondays(self, variant, quantity: str = "4") -> None:
        for monday in (
            date(2026, 3, 30),
            date(2026, 4, 6),
            date(2026, 4, 13),
            date(2026, 4, 20),
        ):
            self.line(variant, monday, quantity=quantity)

    def sold_last_year(self, variant, history_start: date, horizon_start: date) -> None:
        for offset in range(56):
            self.line(variant, history_start + timedelta(days=offset), quantity="1")
        for offset in range(7):
            self.line(variant, horizon_start + timedelta(days=offset), quantity="2")

    def test_last_years_busier_horizon_scales_the_projection(self):
        toast = self.product("Toast")
        plain = self.product("Plain")
        menu = self.menu(toast, plain)
        toast_variant = self.variant(toast)
        self.sold_mondays(toast_variant)
        self.sold_mondays(self.variant(plain))
        self.sold_last_year(
            toast_variant, self.LAST_YEAR_HISTORY_START, self.LAST_YEAR_HORIZON_START
        )

        payload = menu_forecast_payload(self.user, menu, today=self.today)

        self.assertTrue(payload["basis"]["seasonalAdjustment"])
        # Selling last year makes the four quiet Mondays since real zeroes, and
        # the damped 1.5 lifts what is left of the average.
        self.assertEqual(self.product_row(payload, toast)["typicalQuantity"], 4.257)
        self.assertEqual(self.product_row(payload, plain)["typicalQuantity"], 4.0)

    def test_a_product_with_no_last_year_is_left_alone(self):
        plain = self.product("Plain")
        menu = self.menu(plain)
        self.sold_mondays(self.variant(plain))

        payload = menu_forecast_payload(self.user, menu, today=self.today)

        self.assertFalse(payload["basis"]["seasonalAdjustment"])
        self.assertEqual(self.product_row(payload, plain)["typicalQuantity"], 4.0)

    def test_the_backtest_uses_each_replayed_weeks_own_seasonal_factor(self):
        toast = self.product("Toast")
        menu = self.menu(toast)
        MenuItem.objects.filter(menu=menu).update(sell_price_cents=500)
        variant = self.variant(toast)
        self.sold_mondays(variant)
        # Aligned to the 2026-04-13 replay, not to today: its horizon window is
        # 2025-04-14..2025-04-20 and its history the 56 days before that.
        self.sold_last_year(variant, date(2025, 2, 17), date(2025, 4, 14))

        payload = menu_forecast_payload(self.user, menu, today=self.today)
        replay = project_product(
            {date(2026, 3, 30): Decimal(4), date(2026, 4, 6): Decimal(4)},
            exists_from=date(2025, 2, 17),
            history_end=date(2026, 4, 12),
            horizon_start=date(2026, 4, 13),
            horizon_days=7,
            last_year={
                **self.days(date(2025, 2, 17), 56, "1"),
                **self.days(date(2025, 4, 14), 7, "2"),
            },
        )

        self.assertEqual(replay.seasonal_factor, Decimal("1.5"))
        self.assertEqual(payload["backtest"]["weeks"][2]["start"], "2026-04-13")
        self.assertEqual(replay.typical_total, Decimal("2.595"))
        self.assertEqual(payload["backtest"]["weeks"][2]["typicalCents"], 1298)
        # Today's own windows saw nothing last year, so the live flag stays down
        # while the replay was still scaled.
        self.assertFalse(payload["basis"]["seasonalAdjustment"])

    def test_a_product_that_only_existed_for_part_of_last_year_is_not_scaled(self):
        newcomer = self.product("Newcomer")
        menu = self.menu(newcomer)
        variant = self.variant(newcomer)
        self.sold_mondays(variant)
        # First sold 2025-04-21, inside last year's history window: a launch
        # ramp, not a season, and the near-empty denominator would say 2x.
        for offset in range(14):
            self.line(variant, date(2025, 4, 21) + timedelta(days=offset), quantity="10")

        payload = menu_forecast_payload(self.user, menu, today=self.today)

        self.assertFalse(payload["basis"]["seasonalAdjustment"])
        # Four Mondays of four against four empty ones, unscaled.
        self.assertEqual(
            self.product_row(payload, newcomer)["typicalQuantity"], 2.838
        )

    def test_last_years_first_sighting_also_anchors_when_a_product_existed(self):
        backfilled = self.product("Backfilled")
        menu = self.menu(backfilled)
        variant = self.variant(backfilled)
        # A workspace connected this morning backfills two years of sales onto
        # products created today, and last year's read sees them first.
        self.line(variant, date(2025, 4, 1), quantity="1")
        self.line(variant, date(2026, 4, 20), quantity="6")

        payload = menu_forecast_payload(self.user, menu, today=self.today)

        # Eight honest Mondays [6, 0 x 7], not the single sample a product that
        # began last Monday would get.
        self.assertEqual(
            self.product_row(payload, backfilled)["totalQuantity"], 1.442
        )

    def test_a_return_carries_no_spread_for_the_busy_plan_to_expand(self):
        projection = project_product(
            {date(2026, 4, 20): Decimal(-5)},
            exists_from=None,
            history_end=date(2026, 4, 26),
            horizon_start=self.today,
            horizon_days=7,
        )

        self.assertEqual(projection.typical_total, Decimal(0))
        self.assertEqual(projection.busy_total, Decimal(0))

    def test_a_returns_only_product_orders_nothing_on_the_busy_plan(self):
        refunded = self.product("Refunded")
        menu = self.menu(refunded)
        MenuItem.objects.filter(menu=menu).update(sell_price_cents=500)
        SalesProduct.objects.filter(id=refunded.id).update(
            created_at=datetime(2026, 1, 1, tzinfo=timezone.utc)
        )
        self.line(self.variant(refunded), date(2026, 4, 20), quantity="-5")
        flour = Ingredient.objects.create(
            user=self.user,
            name="Refund flour",
            normalized_name="refund flour",
            purchase_cost_cents=0,
            purchase_size=1000,
            purchase_unit="g",
        )
        SalesProductComponent.objects.create(
            product=refunded, ingredient=flour, quantity=Decimal("10"), unit="g"
        )

        payload = menu_forecast_payload(self.user, menu, today=self.today, plan="busy")

        self.assertEqual(payload["products"][0]["busyQuantity"], 0.0)
        self.assertEqual(payload["recipeRequirements"], [])
        self.assertEqual(payload["materialRequirements"], [])
        self.assertEqual(payload["revenue"]["busyCents"], 0)

    def test_the_backtest_window_does_not_widen_the_product_roster(self):
        espresso = self.product("Espresso")
        box = self.product("Box")
        SalesProductComponent.objects.create(
            product=box, component_product=espresso, quantity=1
        )
        menu = self.menu(box)
        self.line(
            self.variant(box, key="forecast:box"),
            self.today - timedelta(days=70),
            quantity="2",
        )

        payload = menu_forecast_payload(self.user, menu, today=self.today)

        # The twelve-week read exists for the backtest; a member last sold
        # before the history window must not join as a zero row.
        self.assertEqual([row["productName"] for row in payload["products"]], ["Box"])
        self.assertEqual(payload["coverage"]["products"], 1)

    def test_the_busy_plan_expands_the_busy_number_into_materials(self):
        loaf = self.product("Loaf")
        menu = self.menu(loaf)
        variant = self.variant(loaf)
        self.line(variant, date(2026, 4, 13), quantity="2")
        self.line(variant, date(2026, 4, 20), quantity="6")
        flour = Ingredient.objects.create(
            user=self.user,
            name="Busy flour",
            normalized_name="busy flour",
            purchase_cost_cents=0,
            purchase_size=1000,
            purchase_unit="g",
        )
        SalesProductComponent.objects.create(
            product=loaf, ingredient=flour, quantity=Decimal("10"), unit="g"
        )

        payload = menu_forecast_payload(self.user, menu, today=self.today, plan="busy")
        row = payload["products"][0]

        self.assertEqual(payload["basis"]["plan"], "busy")
        self.assertEqual(row["typicalQuantity"], 4.222)
        self.assertEqual(row["busyQuantity"], 6.766)
        self.assertEqual(row["totalQuantity"], row["busyQuantity"])
        self.assertEqual(
            payload["materialRequirements"][0]["usage"],
            [{"quantity": 67.66, "unit": "g"}],
        )

    def test_endpoint_takes_a_plan_and_refuses_an_unknown_one(self):
        menu = self.menu(self.product("Toast"))

        def response(query: dict):
            request = RequestFactory().get("/", query)
            request.user = self.user
            return menu_forecast(request, menu_ref=menu.public_id)

        self.assertEqual(json.loads(response({}).content)["basis"]["plan"], "typical")
        self.assertEqual(
            json.loads(response({"plan": "busy"}).content)["basis"]["plan"], "busy"
        )
        refused = response({"plan": "quiet"})
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(
            json.loads(refused.content),
            {"error": "Forecast plan must be typical or busy"},
        )

    def test_the_ledger_window_is_one_read_however_many_days_it_holds(self):
        product = self.product("Daily bread")
        menu = self.menu(product)
        variant = self.variant(product)
        self.line(variant, date(2026, 4, 20), quantity="2")
        # Last year's windows are read too, and hold rows of their own.
        self.line(variant, date(2025, 4, 20), quantity="2")
        self.line(variant, date(2025, 4, 28), quantity="2")

        with self.assertNumQueries(17):
            menu_forecast_payload(self.user, menu, today=self.today)

        for offset in range(1, 85):
            self.line(variant, self.today - timedelta(days=offset), quantity="1")

        with self.assertNumQueries(
            17,
            msg="The twelve-week ledger window is one read whatever it holds",
        ):
            menu_forecast_payload(self.user, menu, today=self.today)

    def test_endpoint_takes_a_seven_or_thirty_day_horizon_and_refuses_others(self):
        menu = self.menu(self.product("Toast"))

        def response(query: dict):
            request = RequestFactory().get("/", query)
            request.user = self.user
            return menu_forecast(request, menu_ref=menu.public_id)

        self.assertEqual(json.loads(response({}).content)["basis"]["horizonDays"], 7)
        self.assertEqual(
            json.loads(response({"days": "30"}).content)["basis"]["horizonDays"], 30
        )
        refused = response({"days": "5"})
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(
            json.loads(refused.content),
            {"error": "Forecast horizon must be 7 or 30 days"},
        )

    def test_endpoint_accepts_both_refs_and_hides_foreign_or_missing_menus(self):
        menu = self.menu(self.product("Toast"))
        request = RequestFactory().get("/")
        request.user = self.user

        by_public = menu_forecast(request, menu_ref=menu.public_id)
        by_uuid = menu_forecast(request, menu_ref=str(menu.id))

        self.assertEqual(by_public.status_code, 200)
        self.assertEqual(by_uuid.status_code, 200)
        self.assertEqual(json.loads(by_public.content)["menu"]["publicId"], menu.public_id)

        other = User.objects.create_user(
            email="forecast-other@example.com", password="test-password"
        )
        foreign = Menu.objects.create(user=other, name="Foreign")
        self.assertEqual(
            menu_forecast(request, menu_ref=str(foreign.id)).status_code, 404
        )
        self.assertEqual(menu_forecast(request, menu_ref="mnu_missing").status_code, 404)

    def test_query_count_does_not_grow_with_ledger_or_component_rows(self):
        product = self.product("Query sandwich")
        menu = self.menu(product)
        variant = self.variant(product)
        self.line(variant, date(2026, 4, 20), quantity="2")
        ingredient = Ingredient.objects.create(
            user=self.user,
            name="Query paper",
            normalized_name="query paper",
            purchase_cost_cents=0,
            purchase_size=100,
            purchase_unit="each",
            non_edible=True,
        )
        SalesProductComponent.objects.create(
            product=product,
            ingredient=ingredient,
            quantity=1,
            unit="each",
        )

        with self.assertNumQueries(
            17,
            msg=(
                "Menu forecast must prefetch ledger interpretation, the bundle "
                "graph and current composition independently of row counts"
            ),
        ):
            menu_forecast_payload(self.user, menu, today=self.today)

        for index in range(2, 8):
            self.line(variant, date(2026, 4, 20), quantity=str(index))
            SalesProductComponent.objects.create(
                product=product,
                ingredient=Ingredient.objects.create(
                    user=self.user,
                    name=f"Query paper {index}",
                    normalized_name=f"query paper {index}",
                    purchase_cost_cents=0,
                    purchase_size=100,
                    purchase_unit="each",
                    non_edible=True,
                ),
                quantity=1,
                unit="each",
                position=index,
            )
        with self.assertNumQueries(
            17,
            msg="Menu forecast query count must not grow with ledger or component rows",
        ):
            menu_forecast_payload(self.user, menu, today=self.today)

    def test_query_count_does_not_grow_with_nested_recipe_depth(self):
        product = self.product("Deep sandwich")
        menu = self.menu(product)
        variant = self.variant(product)
        self.line(variant, date(2026, 4, 20), quantity="4")
        ingredient = Ingredient.objects.create(
            user=self.user,
            name="Deep flour",
            normalized_name="deep flour",
            purchase_cost_cents=0,
            purchase_size=1000,
            purchase_unit="g",
        )
        root = Recipe.objects.create(
            user=self.user,
            title="Depth zero",
            yield_amount=100,
            yield_unit="g",
        )
        RecipeItem.objects.create(
            recipe=root,
            kind=RecipeItem.INGREDIENT,
            position=0,
            ingredient=ingredient,
            quantity=10,
            unit="g",
        )
        SalesProductComponent.objects.create(product=product, recipe=root, quantity=1)

        with self.assertNumQueries(
            22,
            msg="Menu forecast pins the recipe graph to a constant number of reads",
        ):
            menu_forecast_payload(self.user, menu, today=self.today)

        parent = root
        for depth in range(1, 7):
            child = Recipe.objects.create(
                user=self.user,
                title=f"Depth {depth}",
                yield_amount=100,
                yield_unit="g",
            )
            RecipeItem.objects.create(
                recipe=parent,
                kind=RecipeItem.SUBRECIPE,
                position=depth,
                subrecipe=child,
                quantity=100,
                unit="g",
            )
            parent = child
        RecipeItem.objects.create(
            recipe=parent,
            kind=RecipeItem.INGREDIENT,
            position=0,
            ingredient=ingredient,
            quantity=10,
            unit="g",
        )

        with self.assertNumQueries(
            22,
            msg="Menu forecast query count must not grow with recipe graph depth",
        ):
            menu_forecast_payload(self.user, menu, today=self.today)

    def ingredient(
        self,
        name: str,
        *,
        cost: int = 0,
        size=1000,
        unit: str | None = "g",
        yield_percent: str = "100",
        supply: bool = False,
    ) -> Ingredient:
        return Ingredient.objects.create(
            user=self.user,
            name=name,
            normalized_name=name.casefold(),
            purchase_cost_cents=cost,
            purchase_size=size,
            purchase_unit=unit,
            yield_percent=Decimal(yield_percent),
            non_edible=supply,
        )

    def four_mondays_of(self, product: SalesProduct, quantity: str = "4") -> None:
        variant = self.variant(product)
        for sold_on in (date(2026, 3, 30), date(2026, 4, 6), date(2026, 4, 13), date(2026, 4, 20)):
            self.line(variant, sold_on, quantity=quantity)

    def test_materials_carry_packs_and_cost_at_the_pack_price(self):
        loaf = self.product("Loaf")
        menu = self.menu(loaf)
        self.four_mondays_of(loaf)
        flour = self.ingredient("Flour", cost=300, size=1, unit="kg")
        cream = self.ingredient("Cream", cost=800, size=2, unit="kg")
        salt = self.ingredient("Salt", cost=0, size=500)
        bag = self.ingredient("Bag", size=None, unit=None, supply=True)
        for position, (ingredient, grams) in enumerate(
            ((flour, "250"), (cream, "100"), (salt, "50"), (bag, "1"))
        ):
            SalesProductComponent.objects.create(
                product=loaf,
                ingredient=ingredient,
                quantity=Decimal(grams),
                unit="g",
                position=position,
            )

        payload = menu_forecast_payload(self.user, menu, today=self.today)
        rows = {row["ingredientName"]: row for row in payload["materialRequirements"]}

        # A kilo of flour is exactly one pack; 400 g of cream is a fifth of a
        # two-kilo pack, charged at a fifth of its price.
        self.assertEqual(rows["Flour"]["purchase"], [{"quantity": 1.0, "unit": "kg"}])
        self.assertEqual(rows["Flour"]["purchaseSize"], 1.0)
        self.assertEqual(rows["Flour"]["purchaseUnit"], "kg")
        self.assertEqual(rows["Flour"]["packs"], 1.0)
        self.assertEqual(rows["Flour"]["costCents"], 300)
        self.assertEqual(rows["Cream"]["packs"], 0.2)
        self.assertEqual(rows["Cream"]["costCents"], 160)
        # A pack size without a price still counts packs; no pack size counts
        # nothing, and neither joins the total.
        self.assertEqual(rows["Salt"]["packs"], 0.4)
        self.assertIsNone(rows["Salt"]["costCents"])
        self.assertIsNone(rows["Bag"]["purchaseSize"])
        self.assertIsNone(rows["Bag"]["purchaseUnit"])
        self.assertIsNone(rows["Bag"]["packs"])
        self.assertIsNone(rows["Bag"]["costCents"])
        self.assertEqual(
            payload["materialCost"],
            {"costCents": 460, "costedMaterials": 2, "uncostedMaterials": 2},
        )

    def test_trim_loss_makes_the_pack_count_gross(self):
        loaf = self.product("Loaf")
        menu = self.menu(loaf)
        self.four_mondays_of(loaf)
        onion = self.ingredient("Onion", cost=300, size=1, unit="kg", yield_percent="50")
        SalesProductComponent.objects.create(
            product=loaf, ingredient=onion, quantity=Decimal("250"), unit="g"
        )

        row = menu_forecast_payload(self.user, menu, today=self.today)["materialRequirements"][0]

        # A kilo of usable onion at half yield is two kilos bought.
        self.assertEqual(row["usage"], [{"quantity": 1000.0, "unit": "g"}])
        self.assertEqual(row["purchase"], [{"quantity": 2.0, "unit": "kg"}])
        self.assertEqual(row["packs"], 2.0)
        self.assertEqual(row["costCents"], 600)

    def test_the_busy_plan_charges_the_busy_quantity(self):
        loaf = self.product("Loaf")
        menu = self.menu(loaf)
        variant = self.variant(loaf)
        self.line(variant, date(2026, 4, 13), quantity="2")
        self.line(variant, date(2026, 4, 20), quantity="6")
        flour = self.ingredient("Busy flour", cost=200)
        SalesProductComponent.objects.create(
            product=loaf, ingredient=flour, quantity=Decimal("10"), unit="g"
        )

        typical = menu_forecast_payload(self.user, menu, today=self.today)
        busy = menu_forecast_payload(self.user, menu, today=self.today, plan="busy")

        # 42.22 g and 67.66 g of a kilo pack at $2: 8 cents typical, 14 busy.
        self.assertEqual(typical["materialRequirements"][0]["packs"], 0.042)
        self.assertEqual(typical["materialCost"]["costCents"], 8)
        self.assertEqual(busy["materialRequirements"][0]["packs"], 0.068)
        self.assertEqual(busy["materialCost"]["costCents"], 14)

    def test_recipe_rows_say_what_a_batch_makes(self):
        rolls = self.product("Roll")
        dough = self.product("Dough tub")
        menu = self.menu(rolls, dough)
        self.four_mondays_of(rolls)
        self.four_mondays_of(dough, quantity="1")
        flour = self.ingredient("Roll flour")
        roll_recipe = Recipe.objects.create(
            user=self.user, title="Rolls", yield_amount=12, yield_unit="pcs"
        )
        unsized = Recipe.objects.create(user=self.user, title="Dough")
        for recipe in (roll_recipe, unsized):
            RecipeItem.objects.create(
                recipe=recipe,
                kind=RecipeItem.INGREDIENT,
                position=0,
                ingredient=flour,
                quantity=Decimal("500"),
                unit="g",
            )
        SalesProductComponent.objects.create(product=rolls, recipe=roll_recipe, quantity=Decimal("0.25"))
        SalesProductComponent.objects.create(product=dough, recipe=unsized, quantity=Decimal("1"))

        rows = {
            row["recipeTitle"]: row
            for row in menu_forecast_payload(self.user, menu, today=self.today)["recipeRequirements"]
        }

        self.assertEqual(rows["Rolls"]["batches"], 1.0)
        self.assertEqual(rows["Rolls"]["yieldAmount"], 12.0)
        self.assertEqual(rows["Rolls"]["yieldUnit"], "pcs")
        self.assertEqual(rows["Dough"]["batches"], 1.0)
        self.assertIsNone(rows["Dough"]["yieldAmount"])
        self.assertIsNone(rows["Dough"]["yieldUnit"])

    def test_product_rows_carry_their_price_and_their_share_of_the_money(self):
        latte = self.product("Latte")
        water = self.product("Water")
        scone = self.product("Scone")
        espresso = self.product("Espresso")
        box = self.product("Box")
        SalesProductComponent.objects.create(
            product=box, component_product=espresso, quantity=1
        )
        SalesProduct.objects.filter(id=water.id).update(sell_price_cents=300)
        SalesProduct.objects.filter(id=espresso.id).update(sell_price_cents=900)
        menu = self.menu(latte, water, scone, box)
        MenuItem.objects.filter(menu=menu, product=latte).update(sell_price_cents=500)
        self.line(self.variant(latte), date(2026, 4, 20), quantity="2")
        self.line(self.variant(water), date(2026, 4, 20), quantity="1")
        self.line(self.variant(box, key="forecast:box"), date(2026, 4, 20), quantity="3")

        payload = menu_forecast_payload(self.user, menu, today=self.today)

        # The rows add up to the menu's money: two lattes at the menu's price,
        # one water at the product's; the unpriced scone and the espressos
        # inside the boxes carry no money of their own.
        self.assertEqual(self.product_row(payload, latte)["priceCents"], 500)
        self.assertEqual(self.product_row(payload, latte)["typicalCents"], 1000)
        self.assertEqual(self.product_row(payload, latte)["busyCents"], 1000)
        self.assertEqual(self.product_row(payload, water)["priceCents"], 300)
        self.assertEqual(self.product_row(payload, water)["typicalCents"], 300)
        self.assertIsNone(self.product_row(payload, scone)["priceCents"])
        self.assertIsNone(self.product_row(payload, scone)["typicalCents"])
        self.assertIsNone(self.product_row(payload, espresso)["priceCents"])
        self.assertIsNone(self.product_row(payload, box)["priceCents"])
        self.assertEqual(
            sum(row["typicalCents"] or 0 for row in payload["products"]),
            payload["revenue"]["typicalCents"],
        )
