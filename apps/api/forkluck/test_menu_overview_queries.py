from datetime import timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.db import connection
from django.utils import timezone

from .domains.sales.bundles import BundleIndex
from .domains.sales.core import (
    action_save_sales_product,
    attributed_cents,
    interpret_line,
    interpreted_recipe_components,
    menu_overview_payload,
    period_product_sales_rows,
    product_sales_stats,
)
from .models import (
    Recipe,
    SalesCatalogItem,
    SalesChannelConnection,
    SalesProductVariant,
    SalesImport,
    SalesLine,
    SalesLineModifier,
    SalesProduct,
    SalesProductComponent,
    SalesSkuIgnore,
    User,
)


class MenuOverviewQueryCountTests(TestCase):
    """The interpret loop must not issue queries proportional to line count.

    `_variant_contributions` and `interpret_line` once chained querysets onto
    already-prefetched related managers, which cloned the prefetch cache away
    and re-queried per line — 4,698 queries against 2,340 production rows.
    """

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="queries@example.com", password="test-password"
        )
        SalesChannelConnection.objects.create(
            user=self.user,
            provider="square",
            provider_account_id="M1",
            access_token_encrypted="token",
            status=SalesChannelConnection.Status.ACTIVE,
        )
        self.first = self.product("First cookie")
        self.second = self.product("Second cookie")
        self.topping = self.product("Extra topping")
        self.variant = self.bundle_variant()
        self.modifier_variant = self.modifier_singleton()
        self.sales_import = SalesImport.objects.create(
            user=self.user, file_name="sales.csv", channel="square"
        )
        self.next_position = 0

    def product(self, name: str) -> SalesProduct:
        return SalesProduct.objects.create(
            user=self.user, name=name, normalized_name=name.casefold()
        )

    def bundle_variant(self) -> SalesProductVariant:
        action_save_sales_product(
            self.user,
            {
                "id": None,
                "name": "Cookie box",
                "isActive": True,
                "components": [
                    {"productId": str(self.first.id), "quantity": 3, "position": 0},
                    {"productId": str(self.second.id), "quantity": 3, "position": 1},
                ],
                "variants": [
                    {
                        "id": None,
                        "channel": "square",
                        "providerAccountId": "M1",
                        "matchKey": "square:item:COOKIE_BOX",
                        "externalName": "Cookie box",
                        "quantityMultiplier": 1,
                    }
                ],
            },
        )
        return SalesProductVariant.objects.get(
            user=self.user, match_key="square:item:COOKIE_BOX"
        )

    def modifier_singleton(self) -> SalesProductVariant:
        return SalesProductVariant.objects.create(
            user=self.user,
            product=self.topping,
            channel="square",
            provider_account_id="M1",
            match_key="square:modifier:TOPPING",
            external_name="Extra topping",
            identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
        )

    def make_lines(self, count: int) -> None:
        """Attached lines that exercise both defeated prefetch paths.

        Every line sells a bundle and carries a mapped modifier, so a per-line
        requery — of the bundle graph or of the modifier's variant — shows up
        in the count.
        """
        start = self.next_position
        self.next_position += count
        for index in range(start, start + count):
            line = SalesLine.objects.create(
                user=self.user,
                sales_import=self.sales_import,
                product=self.variant.product,
                variant=self.variant,
                channel="square",
                provider_account_id="M1",
                source_position=index,
                source_fingerprint=f"line-{index}",
                external_order_id=str(index),
                sold_at=timezone.now(),
                item_name="Cookie box",
                group_key=self.variant.match_key,
                quantity=Decimal("1"),
                gross_cents=101,
                net_sales_cents=101,
            )
            SalesLineModifier.objects.create(
                user=self.user,
                sales_line=line,
                variant=self.modifier_variant,
                source_fingerprint=f"mod-{index}",
                name="Extra topping",
                match_key=self.modifier_variant.match_key,
                quantity=Decimal("1"),
            )

    # Sizing the modifier queue is one distinct scan every section list pays,
    # so the Products toolbar can name it without asking for the rows. Bundles
    # replaced two per-kind walks and their member prefetches with a single
    # graph load, which is where the three that used to be here went. The
    # product SKU table adds one prefetch.
    MENU_OVERVIEW_QUERIES = 18
    PERIOD_ROWS_QUERIES = 5

    def test_menu_overview_query_count_is_independent_of_line_count(self) -> None:
        message = (
            "the products table re-queried per sales line — 4,698 queries "
            "against 2,340 production rows; the bundle graph must be loaded "
            "once per payload, never once per line"
        )
        self.make_lines(10)
        with self.assertNumQueries(self.MENU_OVERVIEW_QUERIES, msg=message):
            menu_overview_payload(self.user, ["items", "stats"])

        self.make_lines(190)
        self.assertEqual(SalesLine.objects.filter(user=self.user).count(), 200)
        with self.assertNumQueries(self.MENU_OVERVIEW_QUERIES, msg=message):
            menu_overview_payload(self.user, ["items", "stats"])

    def test_review_section_skips_the_interpret_walk(self) -> None:
        """A review-only request may aggregate unlinked lines, but it must
        not run the per-line interpretation the products table needs — the
        catalog page re-renders against this payload on every search and
        mutation, and the walk is O(all sales lines). The walk's fingerprint
        is the bundle graph it loads; review has no reason to read it."""
        self.make_lines(10)

        with CaptureQueriesContext(connection) as captured:
            payload = menu_overview_payload(self.user, ["review"])

        self.assertEqual(payload["items"], [])
        for query in captured.captured_queries:
            self.assertNotIn("salesproductcomponent", query["sql"].lower())

    def test_a_modifier_request_never_reads_the_recipe_table(self) -> None:
        self.make_lines(1)

        with CaptureQueriesContext(connection) as captured:
            payload = menu_overview_payload(self.user, ["modifiers"])

        self.assertEqual(payload["recipes"], [])
        for query in captured.captured_queries:
            self.assertNotIn('"forkluck_recipe"', query["sql"].lower())

    def ignore_rows(self) -> None:
        SalesSkuIgnore.objects.create(
            user=self.user,
            channel="square",
            provider_account_id="M1",
            match_key="square:item:IGNORED",
            external_name="Ignored box",
        )
        SalesSkuIgnore.objects.create(
            user=self.user,
            channel="square",
            provider_account_id="M1",
            match_key="square:modifier:*:IGNORED",
            external_name="Ignored topping",
        )

    def test_an_items_request_never_counts_the_ignored_tables(self) -> None:
        self.make_lines(1)
        self.ignore_rows()

        with CaptureQueriesContext(connection) as captured:
            payload = menu_overview_payload(self.user, ["items", "stats"])

        self.assertEqual(payload["review"]["ignoredItemCount"], 0)
        self.assertEqual(payload["review"]["ignoredModifierCount"], 0)
        self.assertEqual(payload["review"]["ignoredCount"], 0)
        for query in captured.captured_queries:
            sql = query["sql"].lower()
            if "forkluck_salesskuignore" in sql:
                self.assertNotIn("count(", sql)

    def test_an_ignored_request_still_counts_both_lists(self) -> None:
        self.make_lines(1)
        self.ignore_rows()

        review = menu_overview_payload(self.user, ["ignored", "items"])["review"]

        self.assertEqual(review["ignoredItemCount"], 1)
        self.assertEqual(review["ignoredModifierCount"], 1)
        self.assertEqual(review["ignoredCount"], 2)

    def period_rows(self) -> list:
        today = timezone.localdate()
        return period_product_sales_rows(
            SalesLine.objects.filter(user=self.user),
            today - timedelta(days=1),
            today + timedelta(days=1),
            ZoneInfo("UTC"),
            set(),
            index=BundleIndex.for_user(self.user),
        )

    def test_period_sales_query_count_is_independent_of_line_count(self) -> None:
        message = (
            "period product totals re-queried per sales line; the bundle graph "
            "is the caller's, built once"
        )
        self.make_lines(10)
        with self.assertNumQueries(self.PERIOD_ROWS_QUERIES, msg=message):
            self.period_rows()

        self.make_lines(190)
        with self.assertNumQueries(self.PERIOD_ROWS_QUERIES, msg=message):
            self.period_rows()

    def test_bundle_members_and_modifiers_still_contribute(self) -> None:
        self.make_lines(1)
        items = {
            item["name"]: item
            for item in menu_overview_payload(self.user, ["items", "stats"])["items"]
        }

        self.assertEqual(items["First cookie"]["sales"]["quantity"], 3)
        self.assertEqual(items["Second cookie"]["sales"]["quantity"], 3)
        self.assertEqual(items["Extra topping"]["sales"]["quantity"], 1)
        self.assertEqual(
            items["First cookie"]["sales"]["netSalesCents"]
            + items["Second cookie"]["sales"]["netSalesCents"],
            101,
        )
        self.assertEqual(items["Extra topping"]["sales"]["netSalesCents"], 0)
        box = items["Cookie box"]["sales"]
        self.assertTrue(box["sharedToMembers"])
        self.assertEqual(box["netSalesCents"], 0)
        self.assertEqual(box["asSoldNetSalesCents"], 101)
        self.assertEqual(box["splitBasis"], "count")
        self.assertEqual(
            box["lineCount"], 1, "only the product the line sold counts the line"
        )


class MenuOverviewStatsParityTests(TestCase):
    """The grouped stats block must equal the per-line interpretation it replaced.

    `menu_overview_payload` aggregates plain products and mapped modifiers in
    SQL and walks only bundle lines, so the oracle below folds the same lines
    through `interpret_line` and demands an exact match.
    """

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="stats-parity@example.com", password="test-password"
        )
        self.sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="parity.csv",
            channel="square",
            provider_account_id="M1",
            timezone="UTC",
        )
        self.next_position = 0
        self.plain = self.product("Plain cookie")
        self.sixpack = self.product("Six pack")
        self.linzer = self.product("Linzer")
        self.kipferl = self.product("Kipferl")
        self.biscuit = self.product("Tea biscuit")
        self.first = self.product("First cookie")
        self.second = self.product("Second cookie")
        self.topping = self.product("Extra topping")
        self.sprinkles = self.product("Sprinkles")
        self.nuts = self.product("Nuts")
        self.orphan = self.product("Never sold")

        single = self.variant("square:item:PLAIN", product=self.plain)
        multiplier = self.variant(
            "square:item:SIXPACK",
            product=self.sixpack,
            multiplier=Decimal("6"),
        )
        self.box = self.bundle("Cookie box", {self.first: 3, self.second: 3})
        box_variant = self.variant("square:item:BOX", product=self.box)
        modifier_single = self.variant(
            "square:modifier:TOPPING",
            product=self.topping,
            identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
            multiplier=Decimal("2"),
        )
        # A modifier may point at a bundle: its units expand, its money stays
        # zero, exactly as for any other modifier.
        self.mix = self.bundle("Mixed topping", {self.sprinkles: 1, self.nuts: 1})
        modifier_bundle = self.variant("square:item:MIX", product=self.mix)

        self.line(single, Decimal("2"), gross=500, discount=50, net=450, tax=40)
        self.line(single, Decimal("1"), gross=200, net=175, tax=15)
        self.line(multiplier, Decimal("1.5"), gross=900, discount=90, net=810, tax=70)
        box = self.line(box_variant, Decimal("1"), gross=101, net=101)
        self.modifier(box, modifier_bundle, Decimal("2"))
        self.modifier(box, modifier_single, Decimal("1"))
        with_topping = self.line(single, Decimal("3"), gross=750, net=750, tax=60)
        self.modifier(with_topping, modifier_single, Decimal("2"))
        # Neither an ignored occurrence nor a modifier on an unattached parent
        # may contribute.
        self.modifier(with_topping, modifier_single, Decimal("0"))
        self.modifier(self.line(None, Decimal("4"), gross=99), modifier_single, Decimal("1"))

        # A partly attributed plain variant and an unevenly filled, partly
        # attributed box: the two shapes whose money the SQL path scales
        # without ever calling the interpreter.
        part_paid = self.variant(
            "square:item:TEABOX",
            product=self.biscuit,
            multiplier=Decimal("6"),
            attribution=50,
        )
        self.line(part_paid, Decimal("1"), gross=701, discount=33, net=701, tax=17)
        self.line(part_paid, Decimal("-1"), gross=-301, net=-301, refund=301)
        self.uneven_box = self.bundle(
            "Tea and biscuits", {self.linzer: 4, self.kipferl: 6}
        )
        uneven = self.variant(
            "square:item:UNEVEN", product=self.uneven_box, attribution=80
        )
        self.line(uneven, Decimal("1"), gross=1001, net=1001, tax=91)
        self.line(uneven, Decimal("-1"), net=-1001, refund=1001)

    def product(self, name: str) -> SalesProduct:
        return SalesProduct.objects.create(
            user=self.user, name=name, normalized_name=name.casefold()
        )

    def bundle(self, name: str, members: dict) -> SalesProduct:
        product = self.product(name)
        for position, (member, count) in enumerate(members.items()):
            SalesProductComponent.objects.create(
                product=product,
                component_product=member,
                quantity=Decimal(str(count)),
                unit="",
                position=position,
            )
        return product

    def variant(
        self,
        match_key: str,
        *,
        product: SalesProduct | None = None,
        identity_kind: str = SalesProductVariant.IdentityKind.ITEM,
        multiplier: Decimal = Decimal("1"),
        attribution: int | None = None,
    ) -> SalesProductVariant:
        return SalesProductVariant.objects.create(
            user=self.user,
            product=product,
            channel="square",
            provider_account_id="M1",
            match_key=match_key,
            external_name=match_key,
            identity_kind=identity_kind,
            quantity_multiplier=multiplier,
            attribution_percent=attribution,
        )

    def line(
        self,
        variant: SalesProductVariant | None,
        quantity: Decimal,
        *,
        gross: int = 0,
        discount: int = 0,
        net: int = 0,
        tax: int = 0,
        refund: int = 0,
    ) -> SalesLine:
        self.next_position += 1
        return SalesLine.objects.create(
            user=self.user,
            sales_import=self.sales_import,
            variant=variant,
            channel="square",
            provider_account_id="M1",
            source_position=self.next_position,
            source_fingerprint=f"line-{self.next_position}",
            external_order_id=str(self.next_position),
            sold_at=timezone.now(),
            item_name="Cookie",
            group_key=variant.match_key if variant else "square:item:UNKNOWN",
            quantity=quantity,
            gross_cents=gross,
            discount_cents=discount,
            net_sales_cents=net,
            tax_cents=tax,
            refund_cents=refund,
        )

    def modifier(
        self, line: SalesLine, variant: SalesProductVariant, quantity: Decimal
    ) -> None:
        SalesLineModifier.objects.create(
            user=self.user,
            sales_line=line,
            variant=variant,
            source_fingerprint=f"mod-{line.source_position}-{variant.match_key}-{quantity}",
            name=variant.external_name,
            match_key=variant.match_key,
            quantity=quantity,
        )

    def oracle(self) -> dict[str, dict]:
        stats: dict[str, dict] = {}
        index = BundleIndex.for_user(self.user)
        lines = (
            SalesLine.objects.filter(user=self.user, variant__isnull=False)
            .select_related("variant__product")
            .prefetch_related("modifiers__variant__product")
        )
        for line in lines:
            for contribution in interpret_line(line, index=index):
                entry = stats.setdefault(
                    str(contribution.product.id),
                    {
                        "lineCount": 0,
                        "quantity": 0,
                        "totalQuantity": 0,
                        "grossCents": 0,
                        "discountCents": 0,
                        "netSalesCents": 0,
                        "attributedNetSalesCents": 0,
                        "taxCents": 0,
                        "refundCents": 0,
                        "sharedToMembers": index.is_bundle(contribution.product.id),
                        "asSoldNetSalesCents": 0,
                        "splitBasis": (
                            index.split_basis(contribution.product.id)
                            if index.is_bundle(contribution.product.id)
                            else None
                        ),
                    },
                )
                if contribution.source == "base" and not contribution.via_bundle:
                    entry["lineCount"] += 1
                    entry["asSoldNetSalesCents"] += attributed_cents(
                        line.variant, line.net_sales_cents
                    )
                entry["quantity"] += float(contribution.quantity)
                entry["totalQuantity"] += float(contribution.quantity)
                entry["grossCents"] += contribution.gross_cents
                entry["discountCents"] += contribution.discount_cents
                entry["netSalesCents"] += contribution.net_sales_cents
                entry["attributedNetSalesCents"] += contribution.net_sales_cents
                entry["taxCents"] += contribution.tax_cents
                entry["refundCents"] += contribution.refund_cents
        return stats

    maxDiff = None

    def test_grouped_stats_equal_the_per_line_interpretation(self) -> None:
        expected = self.oracle()
        self.assertIn(str(self.first.id), expected)
        self.assertIn(str(self.topping.id), expected)
        self.assertNotIn(str(self.orphan.id), expected)

        items = menu_overview_payload(self.user, ["items", "stats"])["items"]
        # A refunded box leaves a product with money but no net units and no
        # line of its own, so "has any figure at all" is the only honest filter.
        actual = {
            item["id"]: item["sales"]
            for item in items
            if any(
                item["sales"][field]
                for field in (
                    "lineCount",
                    "quantity",
                    "grossCents",
                    "discountCents",
                    "netSalesCents",
                    "taxCents",
                    "refundCents",
                )
            )
        }

        self.assertEqual(actual, expected)

    def test_line_counts_sum_to_the_tracked_ledger(self) -> None:
        """A line is counted on the product it sold, once.

        A box used to count its line once per member, so per-product line
        counts never added up to the ledger's own.
        """
        items = menu_overview_payload(self.user, ["items", "stats"])["items"]

        self.assertEqual(
            sum(item["sales"]["lineCount"] for item in items),
            SalesLine.objects.filter(
                user=self.user, variant__isnull=False, variant__product__isnull=False
            ).count(),
        )

    def test_both_views_of_the_catalog_total_the_same_money(self) -> None:
        expanded = product_sales_stats(self.user)
        as_sold = product_sales_stats(self.user, expand_bundles=False)

        self.assertEqual(
            sum(stats["netSalesCents"] for stats in expanded.values()),
            sum(stats["netSalesCents"] for stats in as_sold.values()),
        )
        self.assertEqual(
            sum(stats["asSoldNetSalesCents"] for stats in expanded.values()),
            sum(stats["netSalesCents"] for stats in as_sold.values()),
            "as-sold money is the same money, wherever it is read",
        )

    def test_a_stats_request_never_decodes_a_source_payload(self) -> None:
        with CaptureQueriesContext(connection) as captured:
            menu_overview_payload(self.user, ["items", "stats"])

        for query in captured.captured_queries:
            self.assertNotIn("source_payload", query["sql"].lower())


class RecipeComponentQueryCountTests(TestCase):
    """Recipe expansion must honour a caller's prefetch, and still cost only
    one query without it — chaining select_related() onto the manager did
    neither, re-querying once per component and discarding any cache."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="recipe-queries@example.com", password="test-password"
        )
        self.product = SalesProduct.objects.create(
            user=self.user, name="Cookie", normalized_name="cookie"
        )
        self.variant = SalesProductVariant.objects.create(
            user=self.user,
            product=self.product,
            channel="square",
            provider_account_id="M1",
            match_key="square:sku:cookie",
            identity_kind=SalesProductVariant.IdentityKind.ITEM,
            quantity_multiplier=Decimal("1"),
        )
        self.sales_import = SalesImport.objects.create(
            user=self.user,
            channel="square",
            provider_account_id="M1",
            file_name="recipes.csv",
            timezone="UTC",
        )
        for index in range(3):
            recipe = Recipe.objects.create(user=self.user, title=f"Dough {index}")
            SalesProductComponent.objects.create(
                product=self.product, recipe=recipe, quantity=Decimal("1")
            )
        self.line = SalesLine.objects.create(
            user=self.user,
            sales_import=self.sales_import,
            variant=self.variant,
            channel="square",
            provider_account_id="M1",
            source_position=0,
            source_fingerprint="recipe-line",
            external_order_id="1",
            sold_at=timezone.now(),
            item_name="Cookie",
            group_key=self.variant.match_key,
            quantity=Decimal("2"),
            gross_cents=500,
            net_sales_cents=500,
        )

    def load(self, *, prefetch: bool) -> SalesLine:
        # The modifier hint is always supplied so the counts isolate recipe
        # expansion from interpret_line's own fetches.
        queryset = (
            SalesLine.objects.filter(pk=self.line.pk)
            .select_related("variant__product")
            .prefetch_related("modifiers__variant__product")
        )
        if prefetch:
            queryset = queryset.prefetch_related(
                "variant__product__components__recipe"
            )
        return queryset.first()

    def count(self, line) -> int:
        with CaptureQueriesContext(connection) as captured:
            components = interpreted_recipe_components(line)
        self.assertEqual(len(components), 3)
        return len(captured.captured_queries)

    def test_a_prefetched_caller_issues_no_further_queries(self) -> None:
        self.assertEqual(self.count(self.load(prefetch=True)), 0)

    def test_an_unprefetched_caller_still_joins_the_recipe(self) -> None:
        # One query carrying the links with their recipes, not one per link.
        self.assertEqual(self.count(self.load(prefetch=False)), 1)


class ReviewCountTests(TestCase):
    """A page that renders the review notice without the review tab still has
    to be told the true pending total; `pending` is only built for the tab."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="review-count@example.com", password="test-password"
        )
        self.sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="review.csv",
            channel="square",
            provider_account_id="M1",
            timezone="UTC",
        )
        SalesChannelConnection.objects.create(
            user=self.user,
            provider="square",
            provider_account_id="M1",
            access_token_encrypted="token",
            status=SalesChannelConnection.Status.ACTIVE,
        )
        self.unmatched_line("square:item:UNMATCHED", 0)
        self.unmatched_line("square:item:UNMATCHED", 1)
        self.unmatched_line("square:item:ALSO_UNMATCHED", 2)
        self.unmatched_line("square:item:IGNORED", 3)
        SalesSkuIgnore.objects.create(
            user=self.user,
            channel="square",
            provider_account_id="M1",
            match_key="square:item:IGNORED",
            external_name="Ignored box",
        )
        self.catalog_item("square:item:CATALOG_ONLY", "M1")
        self.catalog_item("square:item:OTHER_ACCOUNT", "M2")

    def unmatched_line(self, match_key: str, position: int) -> None:
        SalesLine.objects.create(
            user=self.user,
            sales_import=self.sales_import,
            channel="square",
            provider_account_id="M1",
            source_position=position,
            source_fingerprint=f"unmatched-{position}",
            external_order_id=str(position),
            sold_at=timezone.now(),
            item_name="Mystery cookie",
            group_key=match_key,
            match_key=match_key,
            quantity=Decimal("1"),
            gross_cents=100,
            net_sales_cents=100,
        )

    def catalog_item(self, match_key: str, provider_account_id: str) -> None:
        SalesCatalogItem.objects.create(
            user=self.user,
            channel="square",
            provider_account_id=provider_account_id,
            match_key=match_key,
            item_name="Catalog cookie",
            last_seen_at=timezone.now(),
        )

    def test_the_count_agrees_whether_or_not_review_was_requested(self) -> None:
        without_review = menu_overview_payload(self.user, ["items", "stats"])
        with_review = menu_overview_payload(self.user, ["review"])

        # Two unmatched identities plus the connected catalog-only item; the
        # ignored identity and the unconnected account's item are excluded.
        self.assertEqual(with_review["review"]["reviewCount"], 3)
        self.assertEqual(
            without_review["review"]["reviewCount"],
            with_review["review"]["reviewCount"],
        )
