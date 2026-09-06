import json
from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.test import Client, RequestFactory
from django.utils import timezone

from .domains.sales.core import product_sales_stats, refresh_sales_import_totals
from .domains.sales.views import menu_items, menu_product_rows
from .models import (
    Employee,
    Ingredient,
    Invoice,
    LaborImport,
    Recipe,
    SalesChannelConnection,
    SalesProductVariant,
    SalesImport,
    SalesLine,
    SalesModifierList,
    SalesProduct,
    SalesProductComponent,
    SalesSkuIgnore,
    TimeEntry,
    User,
)
from .testing import InternalApiTestCase


class SalesApiTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="sales@example.com",
            name="Sales Tester",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)

    def sales_overview(self) -> dict:
        response = self.get_internal("/internal/v1/sales-overview/")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def menu_overview(self) -> dict:
        response = self.get_internal("/internal/v1/menu-overview/")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def seed_menu_overview_sections(self) -> None:
        self.store_sales()
        SalesChannelConnection.objects.create(
            user=self.user,
            provider=SalesImport.Channel.SQUARE,
            provider_account_id="M1",
            merchant_id="M1",
            access_token_encrypted="unused-in-test",
        )
        SalesSkuIgnore.objects.create(
            user=self.user,
            channel=SalesImport.Channel.SQUARE,
            match_key="sku:retired-item",
            sku="retired-item",
            external_name="Retired item",
        )
        SalesModifierList.objects.create(
            user=self.user,
            channel=SalesImport.Channel.SQUARE,
            provider_account_id="M1",
            external_object_id="LIST_TOPPINGS",
            name="Toppings",
            last_synced_at=timezone.now(),
        )

    def save_menu_item(
        self,
        name: str,
        *,
        product_id: str | None = None,
        recipe_links: list[dict] | None = None,
        variants: list[dict] | None = None,
        is_active: bool = True,
    ):
        normalized_variants: list[dict] = []
        for raw_variant in variants or []:
            variant = dict(raw_variant)
            if variant.get("id") is None:
                variant.setdefault("channel", SalesImport.Channel.SQUARE)
                variant.setdefault("externalName", name)
                if not variant.get("matchKey"):
                    if variant.get("externalObjectId"):
                        variant["matchKey"] = (
                            f"square:item:{variant['externalObjectId']}"
                        )
                    else:
                        variant["matchKey"] = f"sku:{variant.get('sku', '').casefold()}"
            normalized_variants.append(variant)
        body: dict = {
            "id": product_id,
            "name": name,
            "isActive": is_active,
            "recipeLinks": recipe_links or [],
            # Products may still be created before their manual catalog link.
            # The rewritten action requires an explicit (possibly empty)
            # variant collection rather than inferring the legacy SKU shape.
            "variants": normalized_variants,
        }
        if product_id is not None:
            body["expectedEditVersion"] = SalesProduct.objects.get(
                user=self.user, id=product_id
            ).edit_version
        return self.post_internal("save-sales-product", body)

    def test_overview_keeps_costs_when_no_sales_are_tracked(self) -> None:
        employee = Employee.objects.create(
            user=self.user,
            name="Alex Baker",
            normalized_name="alex baker",
        )
        labor_import = LaborImport.objects.create(
            user=self.user,
            file_name="hours.csv",
            timezone="America/New_York",
        )
        TimeEntry.objects.create(
            user=self.user,
            employee=employee,
            labor_import=labor_import,
            source_position=1,
            source_fingerprint="costs-without-sales",
            clock_in=datetime.fromisoformat("2026-07-08T12:00:00-04:00"),
            clock_out=datetime.fromisoformat("2026-07-08T14:00:00-04:00"),
            paid_seconds=7200,
            labor_cost_cents=3750,
        )
        Invoice.objects.create(
            user=self.user,
            supplier="test-supplier",
            supplier_name="Test Supplier",
            invoice_date=datetime.fromisoformat("2026-07-08T00:00:00").date(),
            total_cents=4200,
            source_fingerprint="costs-without-sales-invoice",
            file_name="invoice.pdf",
        )

        trend = self.sales_overview()["netSalesTrend"]

        self.assertEqual(trend["periodStart"], "2026-07-08")
        self.assertEqual(trend["periodEnd"], "2026-07-08")
        self.assertEqual(trend["timezone"], "America/New_York")
        self.assertEqual(trend["availableDates"], ["2026-07-08"])
        self.assertEqual(trend["financials"]["currentLaborCents"], 3750)
        self.assertEqual(trend["financials"]["currentInvoiceCents"], 4200)
        self.assertEqual(trend["financials"]["currentInvoiceCount"], 1)
        self.assertTrue(
            all(
                hour["currentSquareCents"] == 0
                and hour["currentShopifyCents"] == 0
                for hour in trend["hours"]
            )
        )

    def test_full_year_comparison_window_does_not_overlap_current_range(self) -> None:
        Invoice.objects.create(
            user=self.user,
            supplier="test-supplier",
            supplier_name="Test Supplier",
            invoice_date=datetime.fromisoformat("2025-01-01T00:00:00").date(),
            total_cents=4200,
            source_fingerprint="full-year-comparison",
            file_name="invoice.pdf",
        )

        response = self.get_internal(
            "/internal/v1/sales-overview/"
            "?start=2025-01-01&end=2025-12-31"
            "&comparison=fifty_two_weeks_prior"
        )

        self.assertEqual(response.status_code, 200)
        trend = response.json()["netSalesTrend"]
        self.assertEqual(trend["comparisonStart"], "2024-01-02")
        self.assertEqual(trend["comparisonEnd"], "2024-12-31")
        self.assertLess(trend["comparisonEnd"], trend["periodStart"])

    def store_sales(
        self,
        channel: str = "square",
        *,
        decision: str = "pending",
        product_id: str | None = None,
        file_name: str = "square-sync",
        external_name: str = "Pineapple Linzer",
        order_prefix: str = "payment",
    ):
        """One stored batch: a sale and its refund, as a sync pass leaves them.

        Sales arrive from the providers now, so the rows are written here
        rather than posted through an importer. `decision` reproduces the end
        state the identity would be in — untouched, ignored, or already
        claimed by a variant — which is what the tests downstream depend on.
        """
        batch = SalesImport.objects.create(
            user=self.user,
            file_name=file_name,
            channel=channel,
            timezone="America/New_York",
            currency_code="USD",
        )
        variant = None
        if decision == "track":
            product = SalesProduct.objects.get(user=self.user, id=product_id)
            variant = SalesProductVariant.objects.create(
                user=self.user,
                product=product,
                channel=channel,
                match_key="sku:200120",
                sku="200120",
                external_name=external_name,
                external_variant_title="Regular",
            )
        elif decision == "ignore":
            SalesSkuIgnore.objects.update_or_create(
                user=self.user,
                channel=channel,
                provider_account_id="",
                match_key="sku:200120",
                defaults={
                    "sku": "200120",
                    "external_name": external_name,
                    "external_variant_title": "Regular",
                },
            )
            # How a batch records the ignores it made, so undo can reverse
            # them: no "before" means the row did not exist until this batch.
            batch.ignored_items = [
                {
                    "channel": channel,
                    "providerAccountId": "",
                    "matchKey": "sku:200120",
                    "before": None,
                }
            ]
            batch.ignored_count = 1
            batch.save(update_fields=["ignored_items", "ignored_count"])
        sold = datetime(2026, 7, 1, 9, 0, tzinfo=ZoneInfo("America/New_York"))
        for position, order, quantity, gross, discount, net, tax, refund, when in (
            (2, f"{order_prefix}-1", "2", 800, 100, 700, 62, 0, sold),
            (
                3,
                f"{order_prefix}-2",
                "-1",
                -400,
                0,
                -400,
                -36,
                400,
                sold + timedelta(days=1, hours=4),
            ),
        ):
            SalesLine.objects.create(
                user=self.user,
                sales_import=batch,
                variant=variant,
                product=variant.product if variant else None,
                channel=channel,
                source_position=position,
                source_fingerprint=f"{batch.id}-{position}",
                external_order_id=order,
                sold_at=when,
                timezone="America/New_York",
                sku="200120",
                item_name=external_name,
                external_variant_title="Regular",
                group_key="sku:200120",
                quantity=Decimal(quantity),
                gross_cents=gross,
                discount_cents=discount,
                net_sales_cents=net,
                tax_cents=tax,
                refund_cents=refund,
                currency_code="USD",
                location="West Village",
                order_source="WV",
            )
        refresh_sales_import_totals(batch)
        return batch

    def test_identity_lines_returns_the_recent_financial_lines(self) -> None:
        self.store_sales()

        response = self.get_internal(
            "/internal/v1/sales-identity-lines/",
            {"channel": "square", "account": "", "key": "sku:200120"},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["lineCount"], 2)
        newest, oldest = payload["items"]
        self.assertEqual(newest["externalOrderId"], "payment-2")
        self.assertEqual(newest["refundCents"], 400)
        self.assertEqual(oldest["externalOrderId"], "payment-1")
        self.assertEqual(oldest["quantity"], 2.0)
        self.assertEqual(oldest["grossCents"], 800)
        self.assertEqual(oldest["discountCents"], 100)
        self.assertEqual(oldest["netSalesCents"], 700)
        self.assertEqual(oldest["currencyCode"], "USD")
        self.assertEqual(oldest["location"], "West Village")
        self.assertEqual(oldest["orderSource"], "WV")
        self.assertEqual(oldest["timezone"], "America/New_York")

        empty = self.get_internal(
            "/internal/v1/sales-identity-lines/",
            {"channel": "square", "account": "", "key": "sku:other"},
        )
        self.assertEqual(empty.json(), {"items": [], "lineCount": 0})

        other = User.objects.create_user(
            email="other@example.com",
            name="Other Tester",
            password="a-long-test-passphrase-2468",
        )
        other_client = Client()
        other_client.force_login(other)
        isolated = self.get_internal(
            "/internal/v1/sales-identity-lines/",
            {"channel": "square", "account": "", "key": "sku:200120"},
            client=other_client,
        )
        self.assertEqual(isolated.json(), {"items": [], "lineCount": 0})

        self.assertEqual(
            self.get_internal(
                "/internal/v1/sales-identity-lines/",
                {"channel": "csv", "account": "", "key": "sku:200120"},
            ).status_code,
            400,
        )
        self.assertEqual(
            self.get_internal(
                "/internal/v1/sales-identity-lines/",
                {"channel": "square", "account": "", "key": ""},
            ).status_code,
            400,
        )

    def test_menu_overview_without_sections_keeps_the_full_payload(self) -> None:
        self.seed_menu_overview_sections()
        self.assertEqual(self.save_menu_item("Linked cookie").status_code, 200)

        full_response = self.get_internal("/internal/v1/menu-overview/")
        explicit_response = self.get_internal(
            "/internal/v1/menu-overview/"
            "?sections=modifiers,review,ignored,items,stats"
        )

        self.assertEqual(full_response.status_code, 200)
        self.assertEqual(explicit_response.status_code, 200)
        self.assertEqual(full_response.json(), explicit_response.json())
        payload = full_response.json()
        self.assertTrue(payload["items"])
        self.assertTrue(payload["modifierCatalog"]["lists"])
        self.assertTrue(payload["review"]["items"])
        self.assertTrue(payload["review"]["categories"])
        self.assertTrue(payload["review"]["ignoredItems"])

    def test_menu_overview_review_section_omits_other_heavy_arrays(self) -> None:
        self.seed_menu_overview_sections()
        full_payload = self.menu_overview()

        response = self.get_internal("/internal/v1/menu-overview/?sections=review")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["review"]["items"], full_payload["review"]["items"])
        self.assertEqual(
            payload["review"]["categories"], full_payload["review"]["categories"]
        )
        self.assertEqual(
            payload["review"]["reviewCount"], full_payload["review"]["reviewCount"]
        )
        self.assertEqual(
            payload["review"]["modifierReviewCount"],
            full_payload["review"]["modifierReviewCount"],
        )
        self.assertEqual(payload["items"], [])
        self.assertEqual(payload["modifierCatalog"]["lists"], [])
        self.assertEqual(payload["modifierCatalog"]["unassignedRecords"], [])
        self.assertEqual(payload["review"]["ignoredItems"], [])
        self.assertEqual(payload["review"]["ignoredModifiers"], [])
        # The ignored counts caption the ignored lists, so they follow them.
        self.assertTrue(full_payload["review"]["ignoredItemCount"])
        self.assertEqual(payload["review"]["ignoredItemCount"], 0)
        self.assertEqual(payload["review"]["ignoredModifierCount"], 0)

    def test_menu_overview_empty_sections_preserves_contract_and_counts(self) -> None:
        self.seed_menu_overview_sections()
        full_payload = self.menu_overview()

        response = self.get_internal("/internal/v1/menu-overview/?sections=")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(set(payload), set(full_payload))
        self.assertEqual(
            set(payload["modifierCatalog"]), set(full_payload["modifierCatalog"])
        )
        self.assertEqual(set(payload["review"]), set(full_payload["review"]))
        for key in (
            "ignoredItemCount",
            "ignoredModifierCount",
            "ignoredCount",
        ):
            self.assertEqual(payload["review"][key], 0)
        # Both queue sizes are drawn by pages that never open the tab — the
        # Products toolbar names them side by side — so they survive an empty
        # section list even though the rows behind them do not.
        self.assertEqual(
            payload["review"]["modifierReviewCount"],
            full_payload["review"]["modifierReviewCount"],
        )
        self.assertEqual(
            payload["review"]["reviewCount"],
            full_payload["review"]["reviewCount"],
        )
        self.assertEqual(payload["items"], [])
        self.assertEqual(payload["modifierCatalog"]["lists"], [])
        self.assertEqual(payload["modifierCatalog"]["unassignedRecords"], [])
        for key in (
            "items",
            "categories",
            "modifiers",
            "ignoredItems",
            "ignoredModifiers",
        ):
            self.assertEqual(payload["review"][key], [])

    def test_menu_overview_items_and_stats_sections(self) -> None:
        created = self.save_menu_item("Pineapple Linzer")
        self.assertEqual(created.status_code, 200)
        self.store_sales(decision="track", product_id=created.json()["id"])
        full_payload = self.menu_overview()
        self.assertTrue(full_payload["items"])
        self.assertGreater(full_payload["items"][0]["sales"]["netSalesCents"], 0)

        stats_response = self.get_internal(
            "/internal/v1/menu-overview/?sections=items,stats"
        )
        items_response = self.get_internal(
            "/internal/v1/menu-overview/?sections=items"
        )

        self.assertEqual(stats_response.status_code, 200)
        self.assertEqual(items_response.status_code, 200)
        # `items,stats` reproduces the full product list, sales included.
        self.assertEqual(stats_response.json()["items"], full_payload["items"])
        # `items` alone keeps every product but zeroes the sales block —
        # pages that never render sales numbers skip the interpret walk.
        items_payload = items_response.json()["items"]
        self.assertEqual(
            [item["id"] for item in items_payload],
            [item["id"] for item in full_payload["items"]],
        )
        for item, full_item in zip(items_payload, full_payload["items"]):
            stripped = {**full_item, "sales": item["sales"]}
            self.assertEqual(item, stripped)
            self.assertEqual(item["sales"]["netSalesCents"], 0)
        # `stats` implies `items`.
        implied = self.get_internal("/internal/v1/menu-overview/?sections=stats")
        self.assertEqual(implied.json()["items"], full_payload["items"])

    def test_menu_overview_validates_review_search(self) -> None:
        duplicate = self.get_internal(
            "/internal/v1/menu-overview/?sections=review&q=tea&q=retail"
        )
        overlong = self.get_internal(
            f"/internal/v1/menu-overview/?sections=review&q={'x' * 201}"
        )

        self.assertEqual(duplicate.status_code, 400)
        self.assertEqual(duplicate.json(), {"error": "Invalid q"})
        self.assertEqual(overlong.status_code, 400)
        self.assertEqual(overlong.json(), {"error": "Invalid q"})

    # --- tracked imports -------------------------------------------------

    def test_overview_rolls_up_tracked_sales_by_local_day(self):
        product = SalesProduct.objects.create(
            user=self.user,
            name="Pineapple Cake",
            normalized_name="pineapple cake",
        )
        sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="daily-rollup.csv",
            channel="square",
            timezone="America/New_York",
            currency_code="USD",
        )

        def sale(
            *,
            position: int,
            channel: str,
            sold_at: datetime,
            quantity: int,
            net_sales_cents: int,
        ):
            variant, _ = SalesProductVariant.objects.get_or_create(
                user=self.user,
                product=product,
                channel=channel,
                match_key="sku:pineapple-cake",
                defaults={"sku": "PINEAPPLE-CAKE", "external_name": "Pineapple Cake"},
            )
            return SalesLine.objects.create(
                user=self.user,
                sales_import=sales_import,
                product=product,
                variant=variant,
                channel=channel,
                source_position=position,
                source_fingerprint=f"daily-rollup-{position}",
                external_order_id=f"order-{position}",
                sold_at=sold_at,
                timezone="America/New_York",
                sku="PINEAPPLE-CAKE",
                item_name="Pineapple Cake",
                group_key=variant.match_key,
                quantity=quantity,
                gross_cents=net_sales_cents,
                net_sales_cents=net_sales_cents,
                currency_code="USD",
            )

        ny = ZoneInfo("America/New_York")
        sale(
            position=1,
            channel="square",
            sold_at=datetime(2026, 8, 9, 10, 30, tzinfo=ny),
            quantity=1,
            net_sales_cents=400,
        )
        sale(
            position=2,
            channel="square",
            sold_at=datetime(2026, 8, 9, 14, 45, tzinfo=ny),
            quantity=2,
            net_sales_cents=800,
        )
        sale(
            position=3,
            channel="shopify",
            sold_at=datetime(2026, 8, 9, 16, 15, tzinfo=ny),
            quantity=1,
            net_sales_cents=400,
        )
        sale(
            position=4,
            channel="square",
            sold_at=datetime(2026, 8, 10, 9, 5, tzinfo=ny),
            quantity=1,
            net_sales_cents=400,
        )

        daily_sales = self.sales_overview()["dailySales"]
        self.assertEqual(len(daily_sales), 3)
        groups = {
            (row["soldOn"], row["channel"]): row for row in daily_sales
        }
        self.assertEqual(groups[("2026-08-09", "square")]["quantity"], 3)
        self.assertEqual(
            groups[("2026-08-09", "square")]["netSalesCents"], 1200
        )
        self.assertEqual(groups[("2026-08-09", "shopify")]["quantity"], 1)
        self.assertEqual(groups[("2026-08-10", "square")]["netSalesCents"], 400)

        period_payload = self.get_internal(
            "/internal/v1/sales-overview/?start=2026-08-09&end=2026-08-10"
        ).json()
        product_totals = {
            (row["productId"], row["channel"]): row
            for row in period_payload["topProducts"]
        }
        self.assertEqual(
            product_totals[(str(product.id), "square")]["netSalesCents"], 1600
        )
        self.assertEqual(
            product_totals[(str(product.id), "shopify")]["netSalesCents"], 400
        )

    def test_top_products_are_uncapped_and_scoped_to_the_selected_period(self):
        sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="top-products.csv",
            channel="square",
            timezone="UTC",
            currency_code="USD",
        )
        products = [
            SalesProduct(
                user=self.user,
                name=f"Z Product {index:02d}",
                normalized_name=f"z product {index:02d}",
            )
            for index in range(55)
        ]
        leader = SalesProduct(
            user=self.user,
            name="A Period Leader",
            normalized_name="a period leader",
        )
        SalesProduct.objects.bulk_create([*products, leader])
        all_products = [*products, leader]
        SalesProductVariant.objects.bulk_create(
            [
                SalesProductVariant(
                    user=self.user,
                    product=product,
                    channel="square",
                    match_key=f"sku:top-product-{index}",
                    external_name=product.name,
                )
                for index, product in enumerate(all_products, start=1)
            ]
        )
        variants = {
            variant.product_id: variant
            for variant in SalesProductVariant.objects.filter(user=self.user)
        }

        sold_at = datetime(2026, 8, 9, 12, tzinfo=ZoneInfo("UTC"))
        SalesLine.objects.bulk_create(
            [
                SalesLine(
                    user=self.user,
                    sales_import=sales_import,
                    product=product,
                    variant=variants[product.id],
                    channel="square",
                    source_position=index,
                    source_fingerprint=f"top-product-{index}",
                    external_order_id=f"top-order-{index}",
                    sold_at=sold_at,
                    timezone="UTC",
                    item_name=product.name,
                    group_key=variants[product.id].match_key,
                    quantity=1,
                    gross_cents=100,
                    net_sales_cents=100,
                    currency_code="USD",
                )
                for index, product in enumerate(all_products, start=1)
            ]
        )
        SalesLine.objects.filter(product=leader).update(
            gross_cents=10_000, net_sales_cents=10_000
        )

        response = self.get_internal(
            "/internal/v1/sales-overview/?start=2026-08-09&end=2026-08-09"
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload["dailySales"]), 50)
        self.assertNotIn(
            str(leader.id), {row["productId"] for row in payload["dailySales"]}
        )
        self.assertEqual(len(payload["topProducts"]), 56)
        self.assertEqual(payload["topProducts"][0]["productId"], str(leader.id))

        outside = self.get_internal(
            "/internal/v1/sales-overview/?start=2026-08-08&end=2026-08-08"
        )
        self.assertEqual(outside.status_code, 200)
        self.assertEqual(outside.json()["topProducts"], [])

    def test_sales_cards_share_the_requested_period_timezone(self):
        product = SalesProduct.objects.create(
            user=self.user,
            name="Late Cookie",
            normalized_name="late cookie",
        )
        sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="timezone.csv",
            channel="square",
            timezone="UTC",
            currency_code="USD",
        )
        variant = SalesProductVariant.objects.create(
            user=self.user,
            product=product,
            channel="square",
            match_key="sku:late-cookie",
            external_name=product.name,
        )
        SalesLine.objects.create(
            user=self.user,
            sales_import=sales_import,
            product=product,
            variant=variant,
            channel="square",
            source_position=1,
            source_fingerprint="timezone-boundary",
            external_order_id="timezone-order",
            sold_at=datetime(2026, 8, 9, 2, 30, tzinfo=ZoneInfo("UTC")),
            timezone="UTC",
            item_name=product.name,
            group_key=variant.match_key,
            quantity=1,
            gross_cents=800,
            net_sales_cents=800,
            currency_code="USD",
        )

        response = self.get_internal(
            "/internal/v1/sales-overview/"
            "?start=2026-08-08&end=2026-08-08&timezone=America%2FNew_York"
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["netSalesTrend"]["timezone"], "America/New_York")
        self.assertEqual(
            sum(row["currentSquareCents"] for row in payload["netSalesTrend"]["hours"]),
            800,
        )
        self.assertEqual(payload["topProducts"][0]["netSalesCents"], 800)

        invalid = self.get_internal(
            "/internal/v1/sales-overview/?timezone=Not%2FA_Timezone"
        )
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.json(), {"error": "Timezone is not recognized"})

    def test_the_hourly_trend_buckets_by_the_requested_timezone(self):
        product = SalesProduct.objects.create(
            user=self.user,
            name="Midnight Cookie",
            normalized_name="midnight cookie",
        )
        sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="hours.csv",
            channel="square",
            timezone="UTC",
            currency_code="USD",
        )
        variant = SalesProductVariant.objects.create(
            user=self.user,
            product=product,
            channel="square",
            match_key="sku:midnight-cookie",
            external_name=product.name,
        )
        SalesLine.objects.create(
            user=self.user,
            sales_import=sales_import,
            product=product,
            variant=variant,
            channel="square",
            source_position=1,
            source_fingerprint="hour-boundary",
            external_order_id="hour-order",
            # 23:00 on August 8 in New York.
            sold_at=datetime(2026, 8, 9, 3, 0, tzinfo=ZoneInfo("UTC")),
            timezone="UTC",
            item_name=product.name,
            group_key=variant.match_key,
            quantity=1,
            gross_cents=900,
            net_sales_cents=900,
            currency_code="USD",
        )

        response = self.get_internal(
            "/internal/v1/sales-overview/"
            "?start=2026-08-08&end=2026-08-08&timezone=America%2FNew_York"
        )
        self.assertEqual(response.status_code, 200)
        trend = response.json()["netSalesTrend"]
        self.assertEqual(trend["hours"][23]["currentSquareCents"], 900)
        self.assertEqual(
            sum(row["currentSquareCents"] for row in trend["hours"]), 900
        )
        self.assertEqual(trend["availableDates"], ["2026-08-08"])

    # --- pending ---------------------------------------------------------

    def test_pending_skus_are_stored_without_a_product_and_await_review(self):
        self.store_sales()

        self.assertEqual(SalesProduct.objects.count(), 0)
        self.assertEqual(SalesProductVariant.objects.count(), 0)
        self.assertEqual(SalesLine.objects.filter(product__isnull=True).count(), 2)
        self.assertEqual(
            {line.group_key for line in SalesLine.objects.all()}, {"sku:200120"}
        )

        overview = self.sales_overview()
        self.assertEqual(overview["summary"]["lineCount"], 0)
        self.assertEqual(overview["summary"]["netSalesCents"], 0)
        self.assertEqual(overview["scope"]["pendingSkuCount"], 1)
        self.assertEqual(overview["scope"]["pendingLineCount"], 2)
        self.assertEqual(overview["scope"]["pendingNetSalesCents"], 300)

        review = self.menu_overview()["review"]
        self.assertEqual(review["reviewCount"], 1)
        self.assertEqual(review["ignoredItems"], [])
        item = review["items"][0]
        self.assertEqual(item["matchKey"], "sku:200120")
        self.assertEqual(item["sku"], "200120")
        self.assertEqual(item["itemName"], "Pineapple Linzer")
        self.assertEqual(item["lineCount"], 2)
        self.assertEqual(item["orderSources"], ["WV"])
        self.assertEqual(item["netSalesCents"], 300)

    def test_review_row_names_every_order_source_biggest_earner_first(self):
        batch = self.store_sales()
        lines = SalesLine.objects.filter(sales_import=batch)
        lines.filter(source_position=2).update(order_source="Point of Sale")
        lines.filter(source_position=3).update(order_source="Invoices")

        item = self.menu_overview()["review"]["items"][0]

        self.assertEqual(item["orderSources"], ["Point of Sale", "Invoices"])

    # --- ignore ----------------------------------------------------------

    def test_ignored_skus_are_recorded_and_excluded_from_reporting(self):
        self.store_sales(decision="ignore")

        ignore = SalesSkuIgnore.objects.get()
        self.assertEqual(ignore.match_key, "sku:200120")
        self.assertEqual(ignore.sku, "200120")
        self.assertEqual(ignore.external_name, "Pineapple Linzer")
        self.assertEqual(SalesProduct.objects.count(), 0)
        self.assertEqual(SalesLine.objects.filter(product__isnull=True).count(), 2)

        overview = self.sales_overview()
        self.assertEqual(overview["summary"]["lineCount"], 0)
        self.assertEqual(overview["scope"]["ignoredSkuCount"], 1)
        self.assertEqual(overview["scope"]["ignoredLineCount"], 2)
        self.assertEqual(overview["scope"]["ignoredNetSalesCents"], 300)
        self.assertEqual(overview["scope"]["pendingSkuCount"], 0)
        self.assertEqual(overview["imports"][0]["ignoredCount"], 1)

        review = self.menu_overview()["review"]
        self.assertEqual(review["items"], [])
        self.assertEqual(review["ignoredItemCount"], 1)
        self.assertEqual(review["ignoredModifierCount"], 0)
        self.assertEqual(review["ignoredModifiers"], [])
        ignored = review["ignoredItems"][0]
        self.assertEqual(ignored["matchKey"], "sku:200120")
        self.assertEqual(ignored["identityKind"], "item")
        self.assertEqual(ignored["lineCount"], 2)
        self.assertEqual(ignored["quantity"], 1)
        self.assertEqual(ignored["netSalesCents"], 300)
        self.assertEqual(ignored["lastSoldAt"], "2026-07-02T17:00:00+00:00")

    # --- tracking from the menu page --------------------------------------

    def test_adding_a_variant_claims_pending_history(self):
        self.store_sales()

        saved = self.save_menu_item(
            "Pineapple Linzer", variants=[{"id": None, "sku": "200120"}]
        )

        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()["claimedLines"], 2)
        product_id = saved.json()["id"]
        self.assertEqual(SalesLine.objects.filter(product_id=product_id).count(), 2)

        overview = self.sales_overview()
        self.assertEqual(overview["summary"]["lineCount"], 2)
        self.assertEqual(overview["summary"]["netSalesCents"], 300)
        self.assertEqual(overview["scope"]["pendingSkuCount"], 0)
        self.assertEqual(self.menu_overview()["review"]["items"], [])

    def test_tracking_a_sku_supersedes_its_ignore_row(self):
        self.store_sales(decision="ignore")

        saved = self.save_menu_item(
            "Pineapple Linzer", variants=[{"id": None, "sku": "200120"}]
        )

        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()["claimedLines"], 2)
        self.assertEqual(SalesSkuIgnore.objects.count(), 0)
        self.assertEqual(self.sales_overview()["scope"]["ignoredSkuCount"], 0)

    def test_a_sku_cannot_be_claimed_by_two_menu_items(self):
        first = self.save_menu_item(
            "Pineapple Linzer", variants=[{"id": None, "sku": "200120"}]
        )
        self.assertEqual(first.status_code, 200)

        second = self.save_menu_item(
            "Pineapple Linzer box", variants=[{"id": None, "sku": "200120"}]
        )

        self.assertEqual(second.status_code, 400)
        self.assertIn("already connected to another menu item", second.json()["error"])
        self.assertEqual(SalesProductVariant.objects.count(), 1)

    def test_menu_items_can_link_several_recipes(self):
        cookie = Recipe.objects.create(user=self.user, title="Cookie", body="")
        tart = Recipe.objects.create(user=self.user, title="Tart", body="")

        saved = self.save_menu_item(
            "Cookie box",
            recipe_links=[
                {"recipeId": str(cookie.id), "quantity": 6},
                {"recipeId": str(tart.id), "quantity": 1},
            ],
        )
        self.assertEqual(saved.status_code, 200)

        item = self.menu_overview()["items"][0]
        self.assertTrue(item["costed"])
        self.assertEqual(
            sorted(
                (link["recipeTitle"], link["quantity"]) for link in item["recipeLinks"]
            ),
            [("Cookie", 6.0), ("Tart", 1.0)],
        )

        duplicate = self.save_menu_item(
            "Cookie duo",
            recipe_links=[
                {"recipeId": str(cookie.id), "quantity": 1},
                {"recipeId": str(cookie.id), "quantity": 2},
            ],
        )
        self.assertEqual(duplicate.status_code, 400)

    # --- ignore / unignore actions ----------------------------------------

    def test_ignore_and_unignore_actions_round_trip(self):
        self.store_sales()

        ignored = self.post_internal(
            "ignore-sales-skus",
            {
                "items": [
                    {
                        "channel": "square",
                        "matchKey": "sku:200120",
                        "sku": "200120",
                        "externalName": "Pineapple Linzer",
                        "externalVariantTitle": "Regular",
                    }
                ]
            },
        )
        self.assertEqual(ignored.status_code, 200)
        self.assertEqual(ignored.json(), {"ignored": 1})
        scope = self.sales_overview()["scope"]
        self.assertEqual(scope["ignoredSkuCount"], 1)
        self.assertEqual(scope["pendingSkuCount"], 0)
        self.assertEqual(self.menu_overview()["review"]["items"], [])

        removed = self.post_internal(
            "unignore-sales-skus",
            {"items": [{"channel": "square", "matchKey": "sku:200120"}]},
        )
        self.assertEqual(removed.status_code, 200)
        self.assertEqual(removed.json(), {"removed": 1})
        self.assertEqual(SalesSkuIgnore.objects.count(), 0)
        self.assertEqual(self.sales_overview()["scope"]["pendingSkuCount"], 1)

    def test_a_tracked_sku_cannot_be_ignored(self):
        self.save_menu_item(
            "Pineapple Linzer", variants=[{"id": None, "sku": "200120"}]
        )

        response = self.post_internal(
            "ignore-sales-skus",
            {
                "items": [
                    {
                        "channel": "square",
                        "matchKey": "sku:200120",
                        "sku": "200120",
                        "externalName": "Pineapple Linzer",
                        "externalVariantTitle": "Regular",
                    }
                ]
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("tracked", response.json()["error"])
        # The bulk path refuses whole batches, so the message names offenders.
        self.assertIn("200120", response.json()["error"])
        self.assertEqual(SalesSkuIgnore.objects.count(), 0)

    def test_removing_a_sku_detaches_history_that_lost_its_variant(self):
        self.store_sales()
        saved = self.save_menu_item(
            "Pineapple Linzer", variants=[{"id": None, "sku": "200120"}]
        )
        product_id = saved.json()["id"]
        # Migration 0021 merges duplicate variants across channels, so real
        # history can carry the product without the variant FK.
        SalesLine.objects.filter(product_id=product_id).update(variant=None)

        cleared = self.save_menu_item(
            "Pineapple Linzer", product_id=product_id, variants=[]
        )

        self.assertEqual(cleared.status_code, 200)
        self.assertEqual(SalesLine.objects.filter(product_id=product_id).count(), 0)
        self.assertEqual(self.sales_overview()["summary"]["lineCount"], 0)
        self.assertEqual(self.sales_overview()["scope"]["pendingSkuCount"], 1)

    def test_an_archived_recipe_stays_saveable_where_it_is_already_linked(self):
        recipe = Recipe.objects.create(user=self.user, title="Cookie", body="")
        saved = self.save_menu_item(
            "Cookie box",
            recipe_links=[{"recipeId": str(recipe.id), "quantity": 2}],
        )
        product_id = saved.json()["id"]
        recipe.status = Recipe.STATUS_ARCHIVED
        recipe.save(update_fields=["status"])

        again = self.save_menu_item(
            "Cookie box",
            product_id=product_id,
            recipe_links=[{"recipeId": str(recipe.id), "quantity": 3}],
        )
        fresh = self.save_menu_item(
            "Cookie tin",
            recipe_links=[{"recipeId": str(recipe.id), "quantity": 1}],
        )

        self.assertEqual(again.status_code, 200)
        self.assertEqual(fresh.status_code, 400)

    # --- undo --------------------------------------------------------------

    def test_only_latest_import_can_be_undone(self):
        first = self.store_sales()
        second = self.store_sales(file_name="square-sync-2", order_prefix="later")

        blocked = self.post_internal("undo-sales-import", {"id": str(first.id)})
        self.assertEqual(blocked.status_code, 400)
        self.assertIn("newest", blocked.json()["error"])

        undone = self.post_internal("undo-sales-import", {"id": str(second.id)})
        self.assertEqual(undone.status_code, 200)
        self.assertEqual(undone.json()["deletedLines"], 2)
        # The older batch keeps its own lines: undo is per batch.
        self.assertEqual(SalesLine.objects.count(), 2)

    def test_undo_removes_ignores_that_import_created(self):
        batch = self.store_sales(decision="ignore")
        self.assertEqual(SalesSkuIgnore.objects.count(), 1)

        undone = self.post_internal("undo-sales-import", {"id": str(batch.id)})

        self.assertEqual(undone.status_code, 200)
        self.assertEqual(undone.json()["deletedLines"], 2)
        self.assertEqual(SalesLine.objects.count(), 0)
        self.assertEqual(SalesSkuIgnore.objects.count(), 0)

    def test_undo_restores_the_previous_ignore_state(self):
        """A batch that overwrote an ignore has to put the old one back."""
        self.store_sales(decision="ignore")
        second = self.store_sales(
            file_name="square-sync-2", order_prefix="later"
        )
        # The newer batch took the identity over, keeping what it replaced.
        SalesSkuIgnore.objects.update(external_name="Pineapple Linzer Cookie")
        second.ignored_items = [
            {
                "channel": "square",
                "providerAccountId": "",
                "matchKey": "sku:200120",
                "before": {
                    "sku": "200120",
                    "externalName": "Pineapple Linzer",
                    "externalVariantTitle": "Regular",
                },
            }
        ]
        second.save(update_fields=["ignored_items"])

        undone = self.post_internal("undo-sales-import", {"id": str(second.id)})

        self.assertEqual(undone.status_code, 200)
        ignore = SalesSkuIgnore.objects.get()
        self.assertEqual(ignore.external_name, "Pineapple Linzer")

    def test_saved_variant_sku_cannot_change(self):
        saved = self.save_menu_item(
            "Linzer box", variants=[{"id": None, "sku": "200120"}]
        )
        product_id = saved.json()["id"]
        variant = SalesProductVariant.objects.get()

        response = self.save_menu_item(
            "Linzer box",
            product_id=product_id,
            variants=[{"id": str(variant.id), "sku": "999999"}],
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("can't be edited", response.json()["error"])
        variant.refresh_from_db()
        self.assertEqual(variant.sku, "200120")

    def test_variant_row_without_catalog_key_is_rejected_not_500(self):
        response = self.post_internal(
            "save-sales-product",
            {
                "id": None,
                "name": "Linzer box",
                "isActive": True,
                "recipeLinks": [],
                "variants": [{"id": None, "channel": "square", "matchKey": ""}],
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("Product key", response.json()["error"])


    def test_delete_detaches_history_and_removes_the_item(self):
        saved = self.save_menu_item(
            "Croissant", variants=[{"id": None, "sku": "CR-1"}]
        )
        self.assertEqual(saved.status_code, 200)
        product_id = saved.json()["id"]

        line = SalesLine.objects.create(
            user=self.user,
            sales_import=SalesImport.objects.create(
                user=self.user,
                file_name="t.csv",
                channel="square",
                timezone="UTC",
                currency_code="USD",
                total_rows=1,
                imported_count=1,
            ),
            product_id=product_id,
            variant=SalesProductVariant.objects.get(product_id=product_id),
            channel="square",
            external_order_id="o1",
            source_fingerprint="fp-delete-1",
            source_position=0,
            group_key="sku:cr-1",
            sold_at=timezone.now(),
            sku="CR-1",
            item_name="Croissant",
            external_variant_title="",
            quantity=1,
            gross_cents=500,
            discount_cents=0,
            net_sales_cents=500,
            tax_cents=0,
            refund_cents=0,
            currency_code="USD",
        )

        deleted = self.post_internal("delete-sales-product", {"id": product_id})
        self.assertEqual(deleted.status_code, 200)
        self.assertFalse(SalesProduct.objects.filter(id=product_id).exists())
        self.assertFalse(
            SalesProductVariant.objects.filter(product_id=product_id).exists()
        )
        line.refresh_from_db()
        self.assertIsNone(line.product_id)
        self.assertIsNone(line.variant_id)
        # The orphaned line resurfaces in the review bucket.
        review = self.menu_overview()["review"]
        self.assertEqual(review["reviewCount"], 1)

    def test_delete_rejects_another_users_item(self):
        saved = self.save_menu_item("Mine")
        product_id = saved.json()["id"]
        other = User.objects.create_user(
            email="other@example.com", name="Other", password="a-strong-pass-9753"
        )
        other_client = Client()
        other_client.force_login(other)
        response = self.post_internal(
            "delete-sales-product", {"id": product_id}, client=other_client
        )
        self.assertEqual(response.status_code, 400)
        self.assertTrue(SalesProduct.objects.filter(id=product_id).exists())


class MenuItemsBrowseTests(InternalApiTestCase):
    """The Products table reads one page at a time.

    Search and sort therefore have to hold across the whole catalog, not just
    the rows the browser happens to be holding.
    """

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="browse@example.com",
            name="Browse Tester",
            password="a-long-test-passphrase-1357",
        )
        self.client = Client()
        self.client.force_login(self.user)
        self.sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="browse.csv",
            channel="square",
            provider_account_id="M1",
            timezone="UTC",
        )
        self.position = 0

    def product(self, name: str, **fields) -> SalesProduct:
        return SalesProduct.objects.create(
            user=self.user,
            name=name,
            normalized_name=name.casefold(),
            **fields,
        )

    def variant(
        self,
        match_key: str,
        *,
        product: SalesProduct | None = None,
        sku: str = "",
        external_name: str = "",
        members: list[SalesProduct] | None = None,
    ) -> SalesProductVariant:
        if members:
            product = self.product("Cookie box")
            for position, member in enumerate(members):
                SalesProductComponent.objects.create(
                    product=product,
                    component_product=member,
                    quantity=Decimal("1"),
                    position=position,
                )
        return SalesProductVariant.objects.create(
            user=self.user,
            product=product,
            channel="square",
            provider_account_id="M1",
            match_key=match_key,
            sku=sku,
            external_name=external_name or match_key,
        )

    def line(self, variant: SalesProductVariant | None, net: int) -> SalesLine:
        self.position += 1
        return SalesLine.objects.create(
            user=self.user,
            sales_import=self.sales_import,
            variant=variant,
            product=variant.product if variant else None,
            channel="square",
            provider_account_id="M1",
            source_position=self.position,
            source_fingerprint=f"browse-{self.position}",
            external_order_id=str(self.position),
            sold_at=timezone.now(),
            item_name=variant.external_name if variant else "Unlinked",
            group_key=variant.match_key if variant else "square:item:UNKNOWN",
            quantity=Decimal("1"),
            gross_cents=net,
            net_sales_cents=net,
        )

    def browse(self, **params) -> dict:
        response = self.get_internal("menu-items/", params or None)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def names(self, payload: dict) -> list[str]:
        return [item["name"] for item in payload["items"]]

    def test_a_row_carries_the_whole_composition(self) -> None:
        product = self.product("Cookie")
        recipe = Recipe.objects.create(user=self.user, title="Dough", body="")
        ingredient = Ingredient.objects.create(
            user=self.user,
            name="Butter",
            normalized_name="butter",
            purchase_cost_cents=500,
            purchase_size=Decimal("1000"),
            purchase_unit="g",
        )
        SalesProductComponent.objects.create(
            product=product, recipe=recipe, quantity=Decimal("2")
        )
        SalesProductComponent.objects.create(
            product=product,
            ingredient=ingredient,
            quantity=Decimal("25"),
            unit="g",
            position=1,
        )

        item = self.browse()["items"][0]

        self.assertEqual(
            [
                (row["recipeId"], row["ingredientId"], row["quantity"], row["unit"])
                for row in item["components"]
            ],
            [(str(recipe.id), None, 2.0, ""), (None, str(ingredient.id), 25.0, "g")],
        )
        self.assertEqual(
            [link["recipeId"] for link in item["recipeLinks"]], [str(recipe.id)]
        )

    def test_a_page_carries_the_browse_envelope_and_its_slice(self) -> None:
        for index in range(5):
            self.product(f"Cookie {index}")

        # Name order, so the slice this envelope describes is a fixed one.
        payload = self.browse(limit="2", page="2", order="name")

        self.assertEqual(self.names(payload), ["Cookie 2", "Cookie 3"])
        self.assertEqual(
            payload["meta"]["pagination"],
            {
                "page": 2,
                "limit": 2,
                "pages": 3,
                "total": 5,
                "next": 3,
                "prev": 1,
            },
        )
        self.assertTrue(payload["hasAnyProduct"])

    def test_the_default_page_leads_with_the_most_recently_saved_product(
        self,
    ) -> None:
        """A product list is a list of documents the merchant authors."""
        for name in ("Almond cake", "Brownie", "Cookie"):
            self.product(name)

        self.assertEqual(
            self.names(self.browse()), ["Cookie", "Brownie", "Almond cake"]
        )
        # The alphabet is still one click away.
        self.assertEqual(
            self.names(self.browse(order="name")),
            ["Almond cake", "Brownie", "Cookie"],
        )

    def test_search_matches_the_product_name_and_its_variant_identities(self) -> None:
        croissant = self.product("Croissant")
        self.variant("square:item:CR", product=croissant, sku="CR-1")
        eclair = self.product("Eclair")
        self.variant(
            "square:item:EC", product=eclair, sku="EC-9", external_name="Chocolate log"
        )

        self.assertEqual(self.names(self.browse(q="crois")), ["Croissant"])
        self.assertEqual(self.names(self.browse(q="EC-9")), ["Eclair"])
        self.assertEqual(self.names(self.browse(q="chocolate log")), ["Eclair"])
        empty = self.browse(q="nothing here")
        self.assertEqual(empty["items"], [])
        # A search that finds nothing still has to admit the catalog exists.
        self.assertTrue(empty["hasAnyProduct"])

    def test_a_box_is_found_by_its_own_sku_and_name(self) -> None:
        """A box is a product row, so it searches and sorts like every other.

        Its contents are their own rows; a box SKU no longer drags them into
        a search that was asking about the box.
        """
        button = self.product("Button")
        self.variant(
            "square:item:MIXED",
            members=[button, self.product("Filler")],
            sku="BOX-7",
            external_name="Mixed bag",
        )
        plain = self.product("Plain")
        self.variant("square:item:PLAIN", product=plain, sku="AAA-1")

        self.assertEqual(self.names(self.browse(q="BOX-7")), ["Cookie box"])
        self.assertEqual(self.names(self.browse(q="mixed bag")), ["Cookie box"])
        self.assertEqual(
            self.names(self.browse(order="sku"))[:2], ["Plain", "Cookie box"]
        )

    def test_an_empty_catalog_says_so(self) -> None:
        self.assertFalse(self.browse()["hasAnyProduct"])

    def test_the_type_filter_runs_on_the_server(self) -> None:
        self.product("Live cookie")
        SalesProduct.objects.create(
            user=self.user,
            name="Retired cookie",
            normalized_name="retired cookie",
            is_active=False,
        )

        active = self.browse(status="active")
        self.assertEqual(self.names(active), ["Live cookie"])
        self.assertEqual(active["meta"]["pagination"]["total"], 1)
        self.assertEqual(
            self.names(self.browse(status="inactive")), ["Retired cookie"]
        )
        self.assertEqual(
            self.get_internal("menu-items/", {"status": "retired"}).status_code, 400
        )

    def test_a_filter_that_matches_nothing_is_not_an_empty_catalog(self) -> None:
        self.product("Live cookie")

        payload = self.browse(status="inactive")

        self.assertEqual(payload["items"], [])
        self.assertTrue(payload["hasAnyProduct"])

    def test_sku_order_uses_the_lowest_variant_sku_case_insensitively(self) -> None:
        zeta = self.product("Zeta")
        self.variant("square:item:Z1", product=zeta, sku="aa-1")
        self.variant("square:item:Z2", product=zeta, sku="ZZ-9")
        alpha = self.product("Alpha")
        self.variant("square:item:A1", product=alpha, sku="MM-5")
        self.product("Bare")

        self.assertEqual(
            self.names(self.browse(order="sku")), ["Zeta", "Alpha", "Bare"]
        )
        # A product without any SKU sorts last in both directions.
        self.assertEqual(
            self.names(self.browse(order="-sku")), ["Alpha", "Zeta", "Bare"]
        )

    def test_the_sales_window_is_no_longer_accepted(self) -> None:
        """Products is a catalog; the date window belongs to the Sales tab."""
        self.product("Cookie")
        for params in ({"start": "2026-08-01"}, {"end": "2026-08-01"}):
            with self.subTest(params=params):
                response = self.get_internal("menu-items/", params)
                self.assertEqual(response.status_code, 400)
                self.assertIn(
                    "Invalid query parameter", response.json()["error"]
                )

    def test_price_and_category_order_run_both_ways(self) -> None:
        self.product("Bun", category="Pastry", sell_price_cents=300)
        self.product("Latte", category="drinks", sell_price_cents=450)
        self.product("Napkin", sell_price_cents=100)

        self.assertEqual(
            self.names(self.browse(order="price")), ["Napkin", "Bun", "Latte"]
        )
        self.assertEqual(
            self.names(self.browse(order="-price")), ["Latte", "Bun", "Napkin"]
        )
        # Categories sort case-insensitively, and an unfiled product sits last
        # either way rather than leading the reversed page.
        self.assertEqual(
            self.names(self.browse(order="category")),
            ["Latte", "Bun", "Napkin"],
        )
        self.assertEqual(
            self.names(self.browse(order="-category")),
            ["Bun", "Latte", "Napkin"],
        )

    def test_name_order_runs_both_ways(self) -> None:
        for name in ("banana bread", "Almond tart", "cherry pie"):
            self.product(name)

        self.assertEqual(
            self.names(self.browse(order="name")),
            ["Almond tart", "banana bread", "cherry pie"],
        )
        self.assertEqual(
            self.names(self.browse(order="-name")),
            ["cherry pie", "banana bread", "Almond tart"],
        )

    def test_another_tenants_products_are_never_paged_in(self) -> None:
        self.product("Mine")
        other = User.objects.create_user(
            email="browse-other@example.com",
            name="Other",
            password="a-strong-pass-2244",
        )
        SalesProduct.objects.create(user=other, name="Theirs", normalized_name="theirs")

        payload = self.browse()

        self.assertEqual(self.names(payload), ["Mine"])
        self.assertEqual(payload["meta"]["pagination"]["total"], 1)

    def test_unusable_browse_values_are_rejected(self) -> None:
        self.product("Cookie")
        for params in (
            {"order": "sales"},
            {"order": "units"},
            {"page": "0"},
            {"colour": "red"},
        ):
            with self.subTest(params=params):
                response = self.get_internal("menu-items/", params)
                self.assertEqual(response.status_code, 400)
        # Past the last page is an error, not a silent empty list, so the page
        # can redirect back to page one.
        self.assertEqual(
            self.get_internal("menu-items/", {"page": "2"}).status_code, 400
        )

    def test_page_scoped_stats_equal_the_catalog_wide_rollup(self) -> None:
        """Scoping the rollup to a page must not change a single figure.

        A bundle is only allocated correctly when every product inside it is
        read, so the page filter selects whole lines — including the boxes a
        page product sits in — and then discards the off-page products they
        also resolve.
        """
        first = self.product("Alpha")
        second = self.product("Beta")
        third = self.product("Gamma")
        self.line(self.variant("square:item:A", product=first, sku="A-1"), 700)
        self.line(self.variant("square:item:BOX", members=[second, third]), 401)

        whole = product_sales_stats(self.user)
        for product in (first, second, third):
            with self.subTest(product=product.name):
                self.assertEqual(
                    product_sales_stats(self.user, [product.id]),
                    {product.id: whole[product.id]},
                )

    def payload(self, **params) -> dict:
        """The view without the HTTP stack, so session lookups stay out of the
        query counts."""
        request = RequestFactory().get("/internal/v1/menu-items/", params)
        request.user = self.user
        response = menu_items(request)
        self.assertEqual(response.status_code, 200, response.content)
        return json.loads(response.content)

    def test_query_count_does_not_grow_with_the_catalog(self) -> None:
        message = (
            "the products browse must cost the same per page whatever the "
            "catalog holds: count, page, and the SKU, variant, recipe and "
            "component prefetches. It carries no sales rollup — Products is "
            "a catalog."
        )
        boxed = []
        for index in range(3):
            product = self.product(f"Cookie {index}")
            boxed.append(product)
            self.line(self.variant(f"square:item:C{index}", product=product), 100)
        self.line(self.variant("square:item:BOX", members=boxed), 300)
        # Name order, so both catalog sizes sample the same boxed rows.
        with self.assertNumQueries(5, msg=message):
            self.payload(limit="3", order="name")

        for index in range(3, 40):
            product = self.product(f"Cookie {index}")
            self.line(self.variant(f"square:item:C{index}", product=product), 100)
        with self.assertNumQueries(5, msg=message):
            self.payload(limit="3", order="name")
        # The new sorts move work into the page query, not into new ones.
        for order in ("price", "category"):
            with self.subTest(order=order):
                with self.assertNumQueries(5, msg=message):
                    self.payload(limit="3", order=order)


class MenuProductRowsTests(InternalApiTestCase):
    """The menu worksheet's picker: the catalog, priced over the menu's days.

    Products reports no sales, so a worksheet row that seeds `qty_sold` from
    "N units" needs its own read. What it must get right is the window: a
    menu that ran in March may not be told what April sold.
    """

    ZONE = ZoneInfo("UTC")

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="picker@example.com",
            name="Picker Tester",
            password="a-long-test-passphrase-9753",
        )
        self.client = Client()
        self.client.force_login(self.user)
        self.sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="picker.csv",
            channel="square",
            provider_account_id="M1",
            timezone="UTC",
        )
        self.position = 0

    def product(self, name: str, **fields) -> SalesProduct:
        return SalesProduct.objects.create(
            user=self.user,
            name=name,
            normalized_name=name.casefold(),
            **fields,
        )

    def variant(
        self,
        match_key: str,
        *,
        product: SalesProduct | None = None,
        sku: str = "",
        external_name: str = "",
        members: list[SalesProduct] | None = None,
    ) -> SalesProductVariant:
        if members:
            product = self.product(f"Box {match_key}")
            for position, member in enumerate(members):
                SalesProductComponent.objects.create(
                    product=product,
                    component_product=member,
                    quantity=Decimal("1"),
                    position=position,
                )
        return SalesProductVariant.objects.create(
            user=self.user,
            product=product,
            channel="square",
            provider_account_id="M1",
            match_key=match_key,
            sku=sku,
            external_name=external_name or match_key,
        )

    def line(
        self,
        variant: SalesProductVariant,
        *,
        day: int,
        month: int = 3,
        quantity: str = "1",
        net: int = 500,
    ) -> SalesLine:
        self.position += 1
        return SalesLine.objects.create(
            user=self.user,
            sales_import=self.sales_import,
            variant=variant,
            product=variant.product,
            channel="square",
            provider_account_id="M1",
            source_position=self.position,
            source_fingerprint=f"picker-{self.position}",
            external_order_id=str(self.position),
            sold_at=datetime(2026, month, day, 12, tzinfo=self.ZONE),
            item_name=variant.external_name,
            group_key=variant.match_key,
            quantity=Decimal(quantity),
            gross_cents=net,
            net_sales_cents=net,
        )

    def rows(self, **params) -> list[dict]:
        """The view without the HTTP stack, so sessions stay out of the counts."""
        request = RequestFactory().get("/internal/v1/menu-product-rows/", params)
        request.user = self.user
        response = menu_product_rows(request)
        self.assertEqual(response.status_code, 200, response.content)
        payload = json.loads(response.content)
        self.assertEqual(list(payload), ["items"], "the picker has no envelope")
        return payload["items"]

    def units(self, **params) -> dict[str, float]:
        return {row["name"]: row["sales"]["totalQuantity"] for row in self.rows(**params)}

    def test_only_the_windows_own_sales_are_counted(self) -> None:
        scone = self.product("Scone")
        variant = self.variant("square:item:S", product=scone)
        self.line(variant, month=2, day=10)
        self.line(variant, day=10)
        self.line(variant, day=20)
        self.line(variant, month=4, day=1)

        march = self.rows(start="2026-03-01", end="2026-03-31")[0]
        self.assertEqual(march["sales"]["totalQuantity"], 2.0)
        self.assertEqual(march["sales"]["attributedNetSalesCents"], 1000)
        # No window is every sale the product ever made.
        self.assertEqual(self.rows()[0]["sales"]["totalQuantity"], 4.0)
        # A single date is that whole local day, not an empty instant.
        self.assertEqual(
            self.rows(start="2026-03-10")[0]["sales"]["totalQuantity"], 1.0
        )

    def test_a_box_sold_in_the_window_pays_the_products_inside_it(self) -> None:
        scone = self.product("Scone")
        jam = self.product("Jam")
        box = self.variant("square:item:BOX", members=[scone, jam])
        self.line(box, day=10, net=900)
        self.line(box, month=4, day=10, net=900)

        window = {row["name"]: row["sales"] for row in self.rows(
            start="2026-03-01", end="2026-03-31"
        )}
        self.assertEqual(window["Scone"]["totalQuantity"], 1.0)
        self.assertEqual(window["Jam"]["totalQuantity"], 1.0)
        self.assertEqual(
            window["Scone"]["attributedNetSalesCents"]
            + window["Jam"]["attributedNetSalesCents"],
            900,
        )
        # The box itself is a row too, and its money has moved to its members.
        self.assertTrue(window["Box square:item:BOX"]["sharedToMembers"])

    def test_rows_lead_with_the_busiest_product_then_by_name(self) -> None:
        quiet = self.product("Almond bun")
        busy = self.product("Zeppole")
        never = self.product("Brioche")
        self.line(self.variant("square:item:Q", product=quiet), day=10)
        self.line(self.variant("square:item:Z", product=busy), day=10, quantity="7")

        self.assertEqual(
            [row["name"] for row in self.rows(start="2026-03-01", end="2026-03-31")],
            ["Zeppole", "Almond bun", "Brioche"],
        )
        self.assertEqual(never.name, "Brioche")

    def test_search_matches_the_name_and_the_variant_identities(self) -> None:
        scone = self.product("Scone")
        self.variant("square:item:S", product=scone, sku="SCN-1")
        other = self.product("Jam tart")
        self.variant("square:item:J", product=other, external_name="Confiture")

        self.assertEqual([row["name"] for row in self.rows(q="scn")], ["Scone"])
        self.assertEqual([row["name"] for row in self.rows(q="confit")], ["Jam tart"])
        self.assertEqual([row["name"] for row in self.rows(q="tart")], ["Jam tart"])
        self.assertEqual(self.rows(q="nothing here"), [])

    def test_an_inactive_product_is_not_offered(self) -> None:
        self.product("Retired", is_active=False)
        self.product("Current")

        self.assertEqual([row["name"] for row in self.rows()], ["Current"])

    def test_another_tenants_products_are_never_listed(self) -> None:
        self.product("Mine")
        other = User.objects.create_user(
            email="picker-other@example.com",
            name="Other",
            password="a-strong-pass-8642",
        )
        SalesProduct.objects.create(user=other, name="Theirs", normalized_name="theirs")

        self.assertEqual([row["name"] for row in self.rows()], ["Mine"])

    def test_an_unusable_window_or_search_is_rejected(self) -> None:
        self.product("Scone")
        for params in (
            {"start": "not-a-date"},
            {"end": "2026-03-31"},
            {"start": "2026-03-31", "end": "2026-03-01"},
            {"start": "2025-01-01", "end": "2026-06-01"},
            {"start": "9999-12-31"},
            {"q": "x" * 201},
        ):
            with self.subTest(params=params):
                response = self.get_internal("menu-product-rows/", params)
                self.assertEqual(response.status_code, 400, params)
        self.assertEqual(
            self.get_internal("menu-product-rows/", {"q": ["a", "b"]}).status_code, 400
        )

    def test_query_count_does_not_grow_with_the_catalog(self) -> None:
        message = (
            "the menu picker must cost the same whatever the catalog holds: "
            "the workspace zone, the product page with its SKU, variant, recipe "
            "and component prefetches, and the fixed bundle-aware sales "
            "rollup. A per-product stats call would grow with the catalog."
        )
        boxed = []
        for index in range(3):
            product = self.product(f"Cookie {index}")
            boxed.append(product)
            self.line(self.variant(f"square:item:C{index}", product=product), day=10)
        self.line(self.variant("square:item:BOX", members=boxed), day=10, net=900)
        window = {"start": "2026-03-01", "end": "2026-03-31"}
        with self.assertNumQueries(12, msg=message):
            self.rows(**window)

        for index in range(3, 40):
            product = self.product(f"Cookie {index}")
            self.line(self.variant(f"square:item:C{index}", product=product), day=10)
        with self.assertNumQueries(12, msg=message):
            self.rows(**window)

    def test_the_hundred_busiest_are_the_page(self) -> None:
        for index in range(102):
            product = self.product(f"Cookie {index:03d}")
            self.line(
                self.variant(f"square:item:C{index}", product=product),
                day=10,
                quantity=str(index + 1),
            )

        rows = self.rows(start="2026-03-01", end="2026-03-31")

        self.assertEqual(len(rows), 100)
        self.assertEqual(rows[0]["name"], "Cookie 101")
        self.assertEqual(rows[-1]["name"], "Cookie 002")


class UntrackSalesVariantTests(InternalApiTestCase):
    """Untracking sends a catalog identity back to review, whatever it sells."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="untrack@example.com",
            name="Untrack Tester",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)
        self.sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="untrack.csv",
            channel="square",
            provider_account_id="M1",
            timezone="UTC",
        )
        self.first = SalesProduct.objects.create(
            user=self.user, name="Jam tart", normalized_name="jam tart"
        )
        self.second = SalesProduct.objects.create(
            user=self.user, name="Scone", normalized_name="scone"
        )

    def variant(self, match_key: str, **fields) -> SalesProductVariant:
        return SalesProductVariant.objects.create(
            user=self.user,
            channel="square",
            provider_account_id="M1",
            match_key=match_key,
            external_name=match_key,
            **fields,
        )

    def boxed(self) -> SalesProductVariant:
        box = SalesProduct.objects.create(
            user=self.user, name="Cookie box", normalized_name="cookie box"
        )
        for position, product in enumerate((self.first, self.second)):
            SalesProductComponent.objects.create(
                product=box,
                component_product=product,
                quantity=Decimal("1"),
                position=position,
            )
        return self.variant(
            "square:item:BOX", product=box, quantity_multiplier=Decimal("2")
        )

    def line(self, variant: SalesProductVariant | None) -> SalesLine:
        return SalesLine.objects.create(
            user=self.user,
            sales_import=self.sales_import,
            variant=variant,
            channel="square",
            provider_account_id="M1",
            source_position=1,
            source_fingerprint="untrack-1",
            external_order_id="1",
            sold_at=timezone.now(),
            item_name="Cookie box",
            group_key="square:item:BOX",
            quantity=Decimal("1"),
            gross_cents=101,
            net_sales_cents=101,
        )

    def test_untracking_releases_the_lines_and_returns_the_identity_to_review(
        self,
    ) -> None:
        variant = self.boxed()
        line = self.line(variant)

        response = self.post_internal(
            "untrack-sales-variant", {"variantId": str(variant.id)}
        )

        self.assertEqual(response.status_code, 200, response.content)
        payload = response.json()
        self.assertEqual(payload["variantId"], str(variant.id))
        self.assertEqual(payload["parentLinesDetached"], 1)
        self.assertFalse(SalesProductVariant.objects.filter(id=variant.id).exists())
        line.refresh_from_db()
        self.assertIsNone(line.variant_id)
        self.assertIsNone(line.product_id)
        review = self.get_internal("menu-overview/", {"sections": "review"}).json()
        self.assertEqual(
            [row["matchKey"] for row in review["review"]["items"]],
            ["square:item:BOX"],
        )

    def test_untracking_a_variant_that_is_already_gone_succeeds(self) -> None:
        variant = self.boxed()
        self.line(variant)
        self.post_internal("untrack-sales-variant", {"variantId": str(variant.id)})

        response = self.post_internal(
            "untrack-sales-variant", {"variantId": str(variant.id)}
        )

        self.assertEqual(response.status_code, 200, response.content)
        payload = response.json()
        self.assertEqual(payload["variantId"], str(variant.id))
        self.assertEqual(payload["parentLinesDetached"], 0)

    def test_any_catalog_item_can_be_untracked(self) -> None:
        """A box listing is untracked the same way any other listing is."""
        variant = self.variant(
            "square:item:TART",
            product=self.first,
            quantity_multiplier=Decimal("3"),
        )

        response = self.post_internal(
            "untrack-sales-variant", {"variantId": str(variant.id)}
        )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertFalse(SalesProductVariant.objects.filter(id=variant.id).exists())

    def test_a_modifier_identity_is_not_untracked_here(self) -> None:
        variant = self.variant(
            "square:modifier:JAM",
            product=self.first,
            identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
        )

        response = self.post_internal(
            "untrack-sales-variant", {"variantId": str(variant.id)}
        )

        self.assertEqual(response.status_code, 400)
        self.assertTrue(SalesProductVariant.objects.filter(id=variant.id).exists())

    def test_a_box_is_a_product_row_carrying_what_is_inside_it(self) -> None:
        variant = self.boxed()
        SalesProduct.objects.create(
            user=self.user, name="Solo bun", normalized_name="solo bun"
        )

        items = self.get_internal("menu-items/").json()["items"]
        by_name = {item["name"]: item for item in items}

        self.assertEqual(
            [row["id"] for row in by_name["Cookie box"]["variants"]], [str(variant.id)]
        )
        self.assertEqual(
            sorted(
                row["productName"] for row in by_name["Cookie box"]["components"]
            ),
            ["Jam tart", "Scone"],
        )
        self.assertEqual(by_name["Jam tart"]["variants"], [])
        self.assertEqual(by_name["Solo bun"]["components"], [])
