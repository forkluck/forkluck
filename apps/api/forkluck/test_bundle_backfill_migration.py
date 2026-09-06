import importlib
from datetime import date, datetime, timezone
from decimal import Decimal

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class BundleBackfillMigrationTests(TransactionTestCase):
    """0013 turns assorted variants into bundle products without moving money."""

    migrate_from = ("forkluck", "0012_sales_product_component_product")
    migrate_to = ("forkluck", "0013_backfill_bundle_products")

    def setUp(self) -> None:
        super().setUp()
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_from])
        apps = executor.loader.project_state([self.migrate_from]).apps
        User = apps.get_model("forkluck", "User")
        SalesProduct = apps.get_model("forkluck", "SalesProduct")
        SalesImport = apps.get_model("forkluck", "SalesImport")
        SalesProductVariant = apps.get_model("forkluck", "SalesProductVariant")
        SalesVariantMember = apps.get_model("forkluck", "SalesVariantMember")
        SalesLine = apps.get_model("forkluck", "SalesLine")

        self.user = User.objects.create(
            email="bundles@example.com",
            name="Bundles",
            password="!",
            first_name="",
            last_name="",
        )
        self.sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="ledger.csv",
            source="csv",
            channel="square",
            period_start=date(2026, 8, 1),
        )
        self.products = {}
        for index, name in enumerate(
            ("Lotus", "Red Bean", "Custard", "Jujube", "Button A", "Button B")
        ):
            self.products[name] = SalesProduct.objects.create(
                user=self.user,
                name=name,
                normalized_name=name.casefold(),
                sku=f"SKU-{index}",
                normalized_sku=f"sku-{index}",
            )
        self.position = 0
        self.variant_model = SalesProductVariant
        self.member_model = SalesVariantMember
        self.line_model = SalesLine
        self.product_model = SalesProduct

        # One mooncake box on four listings across two channels: two carry
        # weights of 2, two carry weights of 1, all with a multiplier of 12.
        # Both spellings mean three of each, so all four collapse.
        self.mooncake_variants = [
            self._variant(
                channel="square",
                key="square:mooncake:ship",
                name="Assorted Mooncake Box - Ships Monday",
                sku="MOON-12",
                multiplier=Decimal("12"),
                members={"Lotus": 2, "Red Bean": 2, "Custard": 2, "Jujube": 2},
            ),
            self._variant(
                channel="square",
                key="square:mooncake:pickup",
                name="Assorted Mooncake Box - Pickup",
                sku="MOON-12",
                multiplier=Decimal("12"),
                members={"Lotus": 2, "Red Bean": 2, "Custard": 2, "Jujube": 2},
            ),
            self._variant(
                channel="shopify",
                key="shopify:mooncake",
                name="Assorted Mooncake Box",
                sku="MOON-12",
                multiplier=Decimal("12"),
                members={"Lotus": 1, "Red Bean": 1, "Custard": 1, "Jujube": 1},
            ),
            self._variant(
                channel="shopify",
                key="shopify:mooncake:preorder",
                name="Assorted Mooncake Box - Pre-order",
                sku="",
                multiplier=Decimal("12"),
                members={"Lotus": 1, "Red Bean": 1, "Custard": 1, "Jujube": 1},
            ),
        ]
        # A button bag with the same counts written two ways on two channels.
        self.button_variants = [
            self._variant(
                channel="square",
                key="square:buttons",
                name="Button Bag 12",
                sku="SKU-4",
                multiplier=Decimal("12"),
                members={"Button A": 3, "Button B": 3, "Lotus": 3, "Custard": 3},
            ),
            self._variant(
                channel="shopify",
                key="shopify:buttons",
                name="Button Bag 12 - Shipping",
                sku="SKU-4",
                multiplier=Decimal("12"),
                members={"Button A": 1, "Button B": 1, "Lotus": 1, "Custard": 1},
            ),
        ]
        # Two 18-count sets over the same members but different counts.
        self.teatime = self._variant(
            channel="square",
            key="square:teatime",
            name="Teatime Spectacular",
            sku="TEA-18",
            multiplier=Decimal("18"),
            members={"Lotus": 12, "Red Bean": 6},
            attribution=30,
        )
        self.cookies = self._variant(
            channel="square",
            key="square:cookies",
            name="Superior Quality Cookies",
            sku="COOK-18",
            multiplier=Decimal("18"),
            members={"Lotus": 6, "Red Bean": 12},
        )
        for variant in (
            *self.mooncake_variants,
            *self.button_variants,
            self.teatime,
            self.cookies,
        ):
            self._line(variant, quantity=Decimal("1"), net_cents=10_007)

    def _variant(
        self, *, channel, key, name, sku, multiplier, members, attribution=None
    ):
        variant = self.variant_model.objects.create(
            user=self.user,
            product=None,
            kind="assorted",
            channel=channel,
            provider_account_id="",
            match_key=key,
            sku=sku,
            external_name=name,
            identity_kind="item",
            quantity_multiplier=multiplier,
            attribution_percent=attribution,
        )
        for product_name, quantity in members.items():
            self.member_model.objects.create(
                variant=variant,
                product=self.products[product_name],
                quantity=quantity,
            )
        return variant

    def _line(self, variant, *, quantity, net_cents):
        self.position += 1
        return self.line_model.objects.create(
            user=self.user,
            sales_import=self.sales_import,
            product=None,
            variant=variant,
            channel=variant.channel,
            source_position=self.position,
            source_fingerprint=f"fp-{self.position}",
            external_order_id=f"order-{self.position}",
            sold_at=datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc),
            sold_on=date(2026, 8, 10),
            item_name=variant.external_name,
            quantity=quantity,
            gross_cents=net_cents,
            net_sales_cents=net_cents,
        )

    def tearDown(self) -> None:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def _apply(self):
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_to])
        return executor.loader.project_state([self.migrate_to]).apps

    def test_listings_of_one_box_collapse_into_one_bundle_product(self) -> None:
        apps = self._apply()
        SalesProduct = apps.get_model("forkluck", "SalesProduct")
        SalesProductVariant = apps.get_model("forkluck", "SalesProductVariant")

        bundles = list(
            SalesProduct.objects.filter(
                user_id=self.user.pk, components__component_product__isnull=False
            ).distinct()
        )
        self.assertEqual(
            len(bundles),
            4,
            "eight listings are four boxes; a listing is not a product",
        )
        by_name = {row.name: row for row in bundles}
        self.assertEqual(
            sorted(by_name),
            ["Assorted Mooncake Box", "Button Bag 12", "Superior Quality Cookies", "Teatime Spectacular"],
        )
        mooncake = by_name["Assorted Mooncake Box"]
        self.assertEqual(
            SalesProductVariant.objects.filter(product_id=mooncake.pk).count(),
            4,
            "differently weighted listings of one box normalize to one product",
        )
        self.assertEqual(
            SalesProductVariant.objects.filter(
                product_id=by_name["Button Bag 12"].pk
            ).count(),
            2,
        )
        self.assertEqual(
            sorted(
                (row.component_product.name, str(row.quantity))
                for row in mooncake.components.all()
            ),
            [
                ("Custard", "3.000"),
                ("Jujube", "3.000"),
                ("Lotus", "3.000"),
                ("Red Bean", "3.000"),
            ],
        )

    def test_every_variant_becomes_direct_and_keeps_its_attribution(self) -> None:
        apps = self._apply()
        SalesProductVariant = apps.get_model("forkluck", "SalesProductVariant")
        SalesLine = apps.get_model("forkluck", "SalesLine")

        for variant in SalesProductVariant.objects.filter(user_id=self.user.pk):
            self.assertEqual(variant.kind, "direct")
            self.assertIsNotNone(variant.product_id)
            self.assertEqual(variant.quantity_multiplier, Decimal("1.000"))
        teatime = SalesProductVariant.objects.get(pk=self.teatime.pk)
        self.assertEqual(teatime.attribution_percent, 30)
        self.assertFalse(
            SalesLine.objects.filter(user_id=self.user.pk, product__isnull=True).exists(),
            "a bundle line now names the product it sold",
        )

    def test_a_colliding_sku_is_left_blank(self) -> None:
        apps = self._apply()
        SalesProduct = apps.get_model("forkluck", "SalesProduct")
        buttons = SalesProduct.objects.get(user_id=self.user.pk, name="Button Bag 12")
        self.assertEqual(
            buttons.sku,
            "",
            "SKU-4 already belongs to a member, and the unique index would refuse it",
        )
        mooncake = SalesProduct.objects.get(
            user_id=self.user.pk, name="Assorted Mooncake Box"
        )
        self.assertEqual(mooncake.sku, "MOON-12")

    def test_attributed_net_per_member_product_does_not_move(self) -> None:
        before = self._member_totals()
        self._apply()
        from .domains.sales.bundles import BundleIndex
        from .domains.sales.core import _variant_contributions
        from .models import SalesLine, User

        user = User.objects.get(pk=self.user.pk)
        index = BundleIndex.for_user(user)
        after: dict[str, int] = {}
        for line in SalesLine.objects.filter(user=user).select_related(
            "variant", "variant__product"
        ):
            for contribution in _variant_contributions(
                line.variant,
                line.quantity,
                source="base",
                index=index,
                net_sales_cents=line.net_sales_cents,
            ):
                if not contribution.via_bundle:
                    continue
                after[contribution.product.name] = (
                    after.get(contribution.product.name, 0)
                    + contribution.net_sales_cents
                )
        self.assertEqual(after, before)

    def test_rerunning_the_backfill_changes_nothing(self) -> None:
        apps = self._apply()
        SalesProduct = apps.get_model("forkluck", "SalesProduct")
        SalesProductComponent = apps.get_model("forkluck", "SalesProductComponent")
        before = (
            SalesProduct.objects.filter(user_id=self.user.pk).count(),
            SalesProductComponent.objects.count(),
        )
        module = importlib.import_module(
            ".migrations.0013_backfill_bundle_products", package=__package__
        )
        module.backfill_bundle_products(apps, None)
        self.assertEqual(
            (
                SalesProduct.objects.filter(user_id=self.user.pk).count(),
                SalesProductComponent.objects.count(),
            ),
            before,
            "a second run finds no assorted variants and must create nothing",
        )

    def _member_totals(self) -> dict[str, int]:
        """Attributed net per member under the member split, before the move."""
        from .domains.sales.bundles import allocate_cents_by_weight

        totals: dict[str, int] = {}
        for line in self.line_model.objects.filter(
            user_id=self.user.pk
        ).select_related("variant"):
            variant = line.variant
            members = sorted(
                variant.members.select_related("product"),
                key=lambda member: member.product_id,
            )
            percent = variant.attribution_percent
            net = line.net_sales_cents
            if percent is not None and percent != 100:
                net = (
                    0
                    if percent == 0
                    else allocate_cents_by_weight(net, [percent, 100 - percent])[0]
                )
            shares = allocate_cents_by_weight(
                net, [member.quantity for member in members]
            )
            for member, share in zip(members, shares):
                totals[member.product.name] = (
                    totals.get(member.product.name, 0) + share
                )
        return totals
