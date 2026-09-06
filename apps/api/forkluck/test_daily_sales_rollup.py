"""The daily sales rollup groups in SQL, not in Python.

It used to load every tracked line a workspace had ever recorded, group them in
a dict, sort the whole result and then slice the first 50 — so opening the
sales screen cost time proportional to all sales history to render one
screenful. The grouping key also omitted currency, so lines recorded in
different currencies were summed into a single meaningless figure.
"""

from datetime import date, datetime, timedelta, timezone as datetime_timezone
from decimal import Decimal

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from .domains.sales.core import (
    DAILY_SALES_LIMIT,
    daily_sales_rows,
    interpret_line,
)
from .models import (
    SalesProductVariant,
    SalesImport,
    SalesLine,
    SalesLineModifier,
    SalesProduct,
    SalesProductComponent,
    User,
)


DEFAULT_PRODUCT = object()


class DailySalesRollupTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email="rollup@example.com",
            name="Rollup Chef",
            password="a-long-test-passphrase-2468",
        )
        self.sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="sales.csv",
            channel=SalesImport.Channel.SQUARE,
            timezone="America/New_York",
            currency_code="USD",
            period_start=date(2026, 6, 1),
            period_end=date(2026, 6, 30),
            total_rows=0,
        )
        self.espresso = SalesProduct.objects.create(
            user=self.user, name="Espresso", normalized_name="espresso"
        )
        self.counter = 0

    def add_line(
        self,
        *,
        product=DEFAULT_PRODUCT,
        sold_at=datetime(2026, 6, 15, 13, tzinfo=datetime_timezone.utc),
        zone="America/New_York",
        currency="USD",
        channel=SalesImport.Channel.SQUARE,
        sku="ESP-1",
        net=700,
        quantity="2",
        item_name="Espresso",
    ):
        self.counter += 1
        if product is DEFAULT_PRODUCT:
            product = self.espresso
        variant = None
        if product is not None:
            variant, _ = SalesProductVariant.objects.get_or_create(
                user=self.user,
                channel=channel,
                provider_account_id="",
                match_key=f"test:{product.id}:{channel}",
                defaults={
                    "product": product,
                    "external_name": product.name,
                },
            )
        return SalesLine.objects.create(
            user=self.user,
            sales_import=self.sales_import,
            product=product,
            variant=variant,
            channel=channel,
            source_position=self.counter,
            source_fingerprint=f"fp-{self.counter}",
            external_order_id=f"order-{self.counter}",
            sold_at=sold_at,
            timezone=zone,
            currency_code=currency,
            sku=sku,
            item_name=item_name,
            quantity=Decimal(quantity),
            gross_cents=net + 100,
            discount_cents=100,
            net_sales_cents=net,
            tax_cents=62,
            refund_cents=0,
        )

    # -- derivation -----------------------------------------------------

    def test_sold_on_is_derived_from_the_line_s_own_timezone(self):
        # 01:00 UTC on the 16th is still the 15th in New York.
        line = self.add_line(
            sold_at=datetime(2026, 6, 16, 1, tzinfo=datetime_timezone.utc),
            zone="America/New_York",
        )
        line.refresh_from_db()
        self.assertEqual(line.sold_on, date(2026, 6, 15))

        # The same instant is already the 16th in Berlin. One workspace can
        # sell through providers in different zones, which is why this cannot
        # be computed from sold_at in the query.
        other = self.add_line(
            sold_at=datetime(2026, 6, 16, 1, tzinfo=datetime_timezone.utc),
            zone="Europe/Berlin",
        )
        other.refresh_from_db()
        self.assertEqual(other.sold_on, date(2026, 6, 16))

    def test_sold_on_is_derived_on_bulk_create_too(self):
        # bulk_create bypasses save(), and it is how both real write paths
        # insert lines, so the manager has to fill it.
        self.counter += 1
        (created,) = SalesLine.objects.bulk_create(
            [
                SalesLine(
                    user=self.user,
                    sales_import=self.sales_import,
                    product=self.espresso,
                    channel=SalesImport.Channel.SQUARE,
                    source_position=900,
                    source_fingerprint="fp-bulk",
                    external_order_id="order-bulk",
                    sold_at=datetime(2026, 6, 16, 1, tzinfo=datetime_timezone.utc),
                    timezone="America/New_York",
                    currency_code="USD",
                    item_name="Espresso",
                    quantity=Decimal("1"),
                    gross_cents=100,
                    discount_cents=0,
                    net_sales_cents=100,
                    tax_cents=0,
                    refund_cents=0,
                )
            ]
        )
        created.refresh_from_db()
        self.assertEqual(created.sold_on, date(2026, 6, 15))

    def test_an_unknown_timezone_falls_back_to_utc(self):
        line = self.add_line(
            sold_at=datetime(2026, 6, 16, 1, tzinfo=datetime_timezone.utc),
            zone="Mars/Olympus_Mons",
        )
        line.refresh_from_db()
        self.assertEqual(line.sold_on, date(2026, 6, 16))

    def test_a_naive_timestamp_is_interpreted_as_utc(self):
        with self.assertWarns(RuntimeWarning):
            line = self.add_line(
                sold_at=datetime(2026, 6, 16, 1),
                zone="America/New_York",
            )
        line.refresh_from_db()
        self.assertEqual(line.sold_on, date(2026, 6, 15))

    def test_updating_sale_time_with_update_fields_recomputes_sold_on(self):
        line = self.add_line(
            sold_at=datetime(2026, 6, 16, 1, tzinfo=datetime_timezone.utc),
            zone="America/New_York",
        )
        self.assertEqual(line.sold_on, date(2026, 6, 15))

        line.sold_at = datetime(2026, 6, 17, 1, tzinfo=datetime_timezone.utc)
        line.save(update_fields=["sold_at", "updated_at"])
        line.refresh_from_db()

        self.assertEqual(line.sold_on, date(2026, 6, 16))

    # -- grouping -------------------------------------------------------

    def test_lines_on_the_same_day_and_product_are_summed(self):
        self.add_line(net=700)
        self.add_line(net=300)

        rows = daily_sales_rows(self.user)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["netSalesCents"], 1000)
        self.assertEqual(rows[0]["quantity"], 4.0)

    def test_different_currencies_are_never_summed_together(self):
        # The regression: currency was absent from the grouping key, so a USD
        # line and a EUR line on the same day became one number that is in
        # neither currency.
        self.add_line(currency="USD", net=700)
        self.add_line(currency="EUR", net=500)

        rows = daily_sales_rows(self.user)

        self.assertEqual(len(rows), 2)
        self.assertEqual(
            {(row["currencyCode"], row["netSalesCents"]) for row in rows},
            {("USD", 700), ("EUR", 500)},
        )

    def test_channels_stay_separate_for_reconciliation(self):
        self.add_line(channel=SalesImport.Channel.SQUARE, net=700)
        self.add_line(channel=SalesImport.Channel.SHOPIFY, net=500)

        rows = daily_sales_rows(self.user)

        self.assertEqual(len(rows), 2)
        self.assertEqual({row["channel"] for row in rows}, {"square", "shopify"})

    def test_days_stay_separate(self):
        self.add_line(sold_at=datetime(2026, 6, 15, 13, tzinfo=datetime_timezone.utc))
        self.add_line(sold_at=datetime(2026, 6, 16, 13, tzinfo=datetime_timezone.utc))

        rows = daily_sales_rows(self.user)

        self.assertEqual(len(rows), 2)
        self.assertEqual(
            [row["soldOn"] for row in rows], ["2026-06-16", "2026-06-15"]
        )

    def test_a_sku_is_shown_only_when_the_group_agrees_on_one(self):
        self.add_line(sku="ESP-1")
        self.add_line(sku="ESP-1")
        rows = daily_sales_rows(self.user)
        self.assertEqual(rows[0]["sku"], "ESP-1")

        self.add_line(sku="ESP-2")
        rows = daily_sales_rows(self.user)
        self.assertEqual(
            rows[0]["sku"], "", "a group spanning several SKUs must not pick one"
        )

    def test_blank_skus_do_not_count_as_a_second_sku(self):
        self.add_line(sku="ESP-1")
        self.add_line(sku="")

        rows = daily_sales_rows(self.user)

        self.assertEqual(rows[0]["sku"], "ESP-1")

    def test_untracked_lines_are_excluded(self):
        self.add_line(product=None)
        self.add_line()

        rows = daily_sales_rows(self.user)

        self.assertEqual(len(rows), 1)

    def test_another_workspace_s_sales_are_never_included(self):
        other = User.objects.create_user(
            email="bystander@example.com",
            name="Bystander",
            password="a-long-test-passphrase-1357",
        )
        self.add_line()

        self.assertEqual(daily_sales_rows(other), [])

    def test_rows_are_ordered_newest_first(self):
        for day in (14, 16, 15):
            self.add_line(
                sold_at=datetime(2026, 6, day, 13, tzinfo=datetime_timezone.utc)
            )

        rows = daily_sales_rows(self.user)

        self.assertEqual(
            [row["soldOn"] for row in rows],
            ["2026-06-16", "2026-06-15", "2026-06-14"],
        )

    def test_the_id_distinguishes_every_grouping_dimension(self):
        self.add_line(currency="USD")
        self.add_line(currency="EUR")

        ids = {row["id"] for row in daily_sales_rows(self.user)}

        self.assertEqual(len(ids), 2, "ids must not collide across currencies")

    def test_multiplier_uses_variant_quantity_without_multiplying_revenue(self):
        line = self.add_line(quantity="2", net=700)
        line.variant.quantity_multiplier = Decimal("6")
        line.variant.save(update_fields=["quantity_multiplier", "updated_at"])

        (row,) = daily_sales_rows(self.user)

        self.assertEqual(row["quantity"], 12.0)
        self.assertEqual(row["netSalesCents"], 700)

    def bundle(self, name: str, members: dict) -> SalesProduct:
        product = SalesProduct.objects.create(
            user=self.user, name=name, normalized_name=name.casefold()
        )
        for position, (member, count) in enumerate(members.items()):
            SalesProductComponent.objects.create(
                product=product,
                component_product=member,
                quantity=Decimal(str(count)),
                unit="",
                position=position,
            )
        return product

    def test_bundle_and_modifier_contributions_use_the_shared_interpreter(self):
        first = SalesProduct.objects.create(
            user=self.user, name="Chocolate", normalized_name="chocolate"
        )
        second = SalesProduct.objects.create(
            user=self.user, name="Vanilla", normalized_name="vanilla"
        )
        box = self.bundle("Cookie Six Pack", {first: "2.5", second: "2.5"})
        box_line = self.add_line(product=box, quantity="1", net=701, sku="BOX-1")

        addon = SalesProduct.objects.create(
            user=self.user, name="Sprinkles", normalized_name="sprinkles"
        )
        addon_variant = SalesProductVariant.objects.create(
            user=self.user,
            product=addon,
            channel=SalesImport.Channel.SQUARE,
            match_key="test:modifier",
            external_name="Sprinkles",
            identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
        )
        SalesLineModifier.objects.create(
            user=self.user,
            sales_line=box_line,
            variant=addon_variant,
            source_fingerprint="modifier-1",
            name="Sprinkles",
            quantity=Decimal("2"),
        )

        rows = {row["productName"]: row for row in daily_sales_rows(self.user)}

        self.assertEqual(rows["Chocolate"]["quantity"], 2.5)
        self.assertEqual(rows["Vanilla"]["quantity"], 2.5)
        self.assertEqual(
            rows["Chocolate"]["netSalesCents"] + rows["Vanilla"]["netSalesCents"],
            701,
        )
        self.assertEqual(
            rows["Cookie Six Pack"]["netSalesCents"],
            0,
            "the box hands its money to what is inside it",
        )
        self.assertEqual(rows["Cookie Six Pack"]["quantity"], 1.0)
        self.assertEqual(rows["Sprinkles"]["quantity"], 2.0)
        self.assertEqual(rows["Sprinkles"]["netSalesCents"], 0)

    def test_direct_attribution_matches_the_python_interpreter(self):
        """A direct variant's money is its attributed share, per line.

        The rollup groups direct lines in SQL, so a partial attribution has
        to be applied to each line before summing — the floor of a sum is not
        the sum of the floors — and a refund's negative money must round the
        same way `attributed_cents` does. Quantity is physical and never
        scales. 1001 and 1002 at 40% floor to 400 each and the -303 refund to
        -121, so the 679 total is only reachable per line; the group's raw
        sum (1700 at 40%) would read 680.
        """
        variant = self.add_line(net=1001).variant
        variant.attribution_percent = 40
        variant.save(update_fields=["attribution_percent", "updated_at"])
        self.add_line(net=1002)
        self.add_line(quantity="-1", net=-303)

        (row,) = daily_sales_rows(self.user)
        totals = {
            field: 0
            for field in (
                "gross_cents",
                "discount_cents",
                "net_sales_cents",
                "tax_cents",
                "refund_cents",
            )
        }
        quantity = Decimal("0")
        for line in SalesLine.objects.filter(user=self.user):
            (contribution,) = interpret_line(line)
            for field in totals:
                totals[field] += getattr(contribution, field)
            quantity += contribution.quantity

        self.assertEqual(row["netSalesCents"], 679)
        self.assertEqual(row["netSalesCents"], totals["net_sales_cents"])
        self.assertEqual(row["grossCents"], totals["gross_cents"])
        self.assertEqual(row["discountCents"], totals["discount_cents"])
        self.assertEqual(row["taxCents"], totals["tax_cents"])
        self.assertEqual(row["refundCents"], totals["refund_cents"])
        self.assertEqual(Decimal(str(row["quantity"])), quantity)
        self.assertEqual(row["quantity"], 3.0)

    def test_both_views_and_the_ledger_agree_to_the_cent(self):
        """The two views of one ledger must total the same money.

        There is no longer a SQL twin of the split to compare against, so the
        oracle is the pair of views: expanding a box moves money between
        products and must never create or lose any.
        """
        linzer = SalesProduct.objects.create(
            user=self.user, name="Linzer", normalized_name="linzer"
        )
        kipferl = SalesProduct.objects.create(
            user=self.user, name="Kipferl", normalized_name="kipferl"
        )
        box = self.bundle("Tea and biscuits", {linzer: 4, kipferl: 6})
        line = self.add_line(product=box, quantity="1", net=1001, sku="BOX-2")
        line.variant.attribution_percent = 80
        line.variant.save(update_fields=["attribution_percent", "updated_at"])

        expanded = daily_sales_rows(self.user)
        as_sold = daily_sales_rows(self.user, expand_bundles=False)
        attributed = sum(
            entry.net_sales_cents
            for source in SalesLine.objects.filter(user=self.user)
            for entry in interpret_line(source)
        )

        self.assertEqual(
            sum(row["netSalesCents"] for row in expanded),
            sum(row["netSalesCents"] for row in as_sold),
        )
        self.assertEqual(sum(row["netSalesCents"] for row in expanded), attributed)

        rows = {row["productName"]: row for row in expanded}
        # The counts carry the units, and only the attributed 80% is shared.
        self.assertEqual(rows["Linzer"]["quantity"], 4.0)
        self.assertEqual(rows["Kipferl"]["quantity"], 6.0)
        self.assertEqual(
            rows["Linzer"]["netSalesCents"] + rows["Kipferl"]["netSalesCents"], 800
        )
        self.assertEqual(rows["Tea and biscuits"]["netSalesCents"], 0)


class DailySalesRollupScaleTests(TestCase):
    """The rollup's cost must not follow the size of the ledger."""

    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_user(
            email="scale@example.com",
            name="Scale Chef",
            password="a-long-test-passphrase-2468",
        )
        cls.sales_import = SalesImport.objects.create(
            user=cls.user,
            file_name="sales.csv",
            channel=SalesImport.Channel.SQUARE,
            timezone="UTC",
            currency_code="USD",
            period_start=date(2026, 1, 1),
            period_end=date(2026, 12, 31),
            total_rows=0,
        )
        products = SalesProduct.objects.bulk_create(
            SalesProduct.objects.model(
                user=cls.user, name=f"Item {index}", normalized_name=f"item {index}"
            )
            for index in range(20)
        )
        variants = SalesProductVariant.objects.bulk_create(
            SalesProductVariant(
                user=cls.user,
                product=product,
                channel=SalesImport.Channel.SQUARE,
                match_key=f"test:{product.id}",
                external_name=product.name,
            )
            for product in products
        )
        base = datetime(2026, 1, 1, 12, tzinfo=datetime_timezone.utc)
        # 200 days x 20 products = 4,000 groups, well past the 50-row limit.
        SalesLine.objects.bulk_create(
            SalesLine(
                user=cls.user,
                sales_import=cls.sales_import,
                product=products[index % 20],
                variant=variants[index % 20],
                channel=SalesImport.Channel.SQUARE,
                source_position=index,
                source_fingerprint=f"fp-{index}",
                external_order_id=f"order-{index}",
                sold_at=base + timedelta(days=index % 200),
                timezone="UTC",
                currency_code="USD",
                sku=f"SKU-{index % 20}",
                item_name=f"Item {index % 20}",
                quantity=Decimal("1"),
                gross_cents=100,
                discount_cents=0,
                net_sales_cents=100,
                tax_cents=0,
                refund_cents=0,
            )
            for index in range(4000)
        )

    def test_the_rollup_uses_a_fixed_query_count(self):
        # Previously one query streamed the entire ledger into memory. The
        # count is what matters here: grouping, ordering and limiting all
        # happen in the database.
        with self.assertNumQueries(
            3, msg="the index, the direct group and the modifier group; no per-line read"
        ):
            rows = daily_sales_rows(self.user)
        self.assertEqual(len(rows), DAILY_SALES_LIMIT)

    def test_only_the_limit_is_materialized(self):
        rows = daily_sales_rows(self.user)

        self.assertEqual(len(rows), DAILY_SALES_LIMIT)
        # And it is the newest window, not an arbitrary slice.
        self.assertEqual(rows[0]["soldOn"], "2026-07-19")
        self.assertTrue(
            all(
                rows[index]["soldOn"] >= rows[index + 1]["soldOn"]
                for index in range(len(rows) - 1)
            )
        )

    def test_a_smaller_limit_does_not_read_more(self):
        with self.assertNumQueries(
            3, msg="a smaller limit must not add a query, only narrow the slice"
        ):
            rows = daily_sales_rows(self.user, limit=5)
        self.assertEqual(len(rows), 5)

    def test_a_bundle_does_not_remove_the_direct_group_limit(self):
        first, second = SalesProduct.objects.filter(user=self.user)[:2]
        box = SalesProduct.objects.create(
            user=self.user, name="Box", normalized_name="box"
        )
        SalesProductComponent.objects.bulk_create(
            [
                SalesProductComponent(
                    product=box, component_product=member, quantity=Decimal("1"), position=index
                )
                for index, member in enumerate((first, second))
            ]
        )
        box_variant = SalesProductVariant.objects.create(
            user=self.user,
            product=box,
            channel=SalesImport.Channel.SQUARE,
            match_key="test:scale-box",
            external_name="Box",
            quantity_multiplier=Decimal("2"),
        )
        SalesLine.objects.bulk_create(
            SalesLine(
                user=self.user,
                sales_import=self.sales_import,
                product=box,
                variant=box_variant,
                channel=SalesImport.Channel.SQUARE,
                source_position=5000 + index,
                source_fingerprint=f"fp-special-{index}",
                external_order_id=f"order-special-{index}",
                sold_at=datetime(2026, 7, 20, 12, tzinfo=datetime_timezone.utc),
                timezone="UTC",
                currency_code="USD",
                item_name="Box",
                quantity=Decimal("1"),
                gross_cents=101,
                discount_cents=0,
                net_sales_cents=101,
                tax_cents=0,
                refund_cents=0,
            )
            for index in range(500)
        )

        with CaptureQueriesContext(connection) as captured:
            rows = daily_sales_rows(self.user, limit=5)

        direct_queries = [
            query["sql"]
            for query in captured.captured_queries
            if "GROUP BY" in query["sql"]
            and "variant_id" in query["sql"]
            and "SUM(" in query["sql"]
            and "forkluck_saleslinemodifier" not in query["sql"]
        ]
        self.assertEqual(len(rows), 5)
        self.assertEqual(
            len(captured),
            5,
            "the bundle index is built once; its lines and modifiers are one "
            "pass each, never one per line",
        )
        self.assertEqual(len(direct_queries), 1)
        self.assertIn("LIMIT 5", direct_queries[0])

    def test_modifier_history_is_grouped_and_limited_in_sql(self):
        addon = SalesProduct.objects.create(
            user=self.user, name="Add-on", normalized_name="add-on"
        )
        addon_variant = SalesProductVariant.objects.create(
            user=self.user,
            product=addon,
            channel=SalesImport.Channel.SQUARE,
            match_key="test:scale-modifier",
            external_name="Add-on",
            identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
        )
        SalesLineModifier.objects.bulk_create(
            SalesLineModifier(
                user=self.user,
                sales_line=line,
                variant=addon_variant,
                source_fingerprint=f"modifier-{line.source_position}",
                name="Add-on",
                quantity=Decimal("1"),
            )
            for line in SalesLine.objects.filter(user=self.user)
        )

        with CaptureQueriesContext(connection) as captured:
            rows = daily_sales_rows(self.user, limit=5)

        modifier_queries = [
            query["sql"]
            for query in captured.captured_queries
            if "forkluck_saleslinemodifier" in query["sql"]
            and "GROUP BY" in query["sql"]
        ]
        self.assertEqual(len(rows), 5)
        self.assertEqual(len(modifier_queries), 1)
        self.assertIn("LIMIT 5", modifier_queries[0])
