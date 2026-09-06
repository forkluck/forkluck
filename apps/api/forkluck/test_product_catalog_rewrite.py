from decimal import Decimal

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone

from .domains.sales.bundles import BundleIndex
from .domains.sales.core import (
    action_delete_sales_product,
    action_save_sales_product,
    action_update_sales_variant_attribution,
    action_update_sales_variant_multiplier,
    allocate_cents_by_weight,
    interpret_line,
    product_cost,
    reinterpret_sales,
)
from .models import (
    Ingredient,
    SalesChannelConnection,
    SalesProductVariant,
    SalesImport,
    SalesLine,
    SalesProduct,
    SalesProductComponent,
    User,
)


class ProductCatalogRewriteTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="rewrite@example.com", password="test-password"
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

    def product(self, name: str) -> SalesProduct:
        return SalesProduct.objects.create(
            user=self.user, name=name, normalized_name=name.casefold()
        )

    def bundle_body(self, *, components: list | None = None, **variant_overrides) -> dict:
        """One save: a box product, what is inside it, and its channel listing."""
        variant = {
            "id": None,
            "channel": "square",
            "providerAccountId": "M1",
            "matchKey": "square:item:COOKIE_BOX",
            "externalName": "Cookie box",
            "quantityMultiplier": 1,
        }
        variant.update(variant_overrides)
        return {
            "id": None,
            "name": "Cookie box",
            "isActive": True,
            "components": (
                [
                    {"productId": str(self.first.id), "quantity": 3, "position": 0},
                    {"productId": str(self.second.id), "quantity": 3, "position": 1},
                ]
                if components is None
                else components
            ),
            "variants": [variant],
        }

    def saved_variant(self) -> SalesProductVariant:
        return SalesProductVariant.objects.get(
            user=self.user, match_key="square:item:COOKIE_BOX"
        )

    def expanded(self, line: SalesLine) -> list:
        return interpret_line(line, index=BundleIndex.for_user(self.user))

    def test_an_unconnected_provider_account_is_rejected(self) -> None:
        """A stale page must not file a variant under a dead account."""
        with self.assertRaisesMessage(ValueError, "Unknown provider account"):
            action_save_sales_product(
                self.user, self.bundle_body(providerAccountId="M-GONE")
            )
        self.assertFalse(
            SalesProductVariant.objects.filter(provider_account_id="M-GONE").exists()
        )

    def bundle_line(self, variant: SalesProductVariant, *, net: int) -> SalesLine:
        sales_import = SalesImport.objects.create(
            user=self.user, file_name="sales.csv", channel="square"
        )
        return SalesLine.objects.create(
            user=self.user,
            sales_import=sales_import,
            product=variant.product,
            variant=variant,
            channel="square",
            provider_account_id="M1",
            source_position=1,
            source_fingerprint=f"bundle-{variant.id}",
            external_order_id="one",
            sold_at=timezone.now(),
            item_name="Cookie box",
            group_key=variant.match_key,
            quantity=Decimal("1"),
            gross_cents=net,
            net_sales_cents=net,
        )

    def test_a_bundle_sale_splits_units_and_cents_including_refunds(self) -> None:
        action_save_sales_product(self.user, self.bundle_body())
        variant = self.saved_variant()
        line = self.bundle_line(variant, net=101)

        positive = self.expanded(line)
        box, *members = positive
        self.assertEqual(box.product.name, "Cookie box")
        self.assertEqual(box.quantity, Decimal("1"))
        self.assertEqual(box.net_sales_cents, 0, "the box hands its money on")
        self.assertEqual([entry.quantity for entry in members], [Decimal("3"), Decimal("3")])
        self.assertEqual(sum(entry.net_sales_cents for entry in positive), 101)
        self.assertTrue(all(entry.via_bundle for entry in members))

        line.quantity = Decimal("-1")
        line.net_sales_cents = -101
        line.gross_cents = -101
        line.save(update_fields=["quantity", "net_sales_cents", "gross_cents"])
        negative = self.expanded(line)
        self.assertEqual(
            [entry.quantity for entry in negative[1:]], [Decimal("-3"), Decimal("-3")]
        )
        self.assertEqual(sum(entry.net_sales_cents for entry in negative), -101)

    def test_the_old_assorted_payload_is_refused_loudly(self) -> None:
        """A client that has not shipped yet must fail, not save half a box."""
        for row in (
            {"kind": "assorted", "members": [str(self.first.id)]},
            {"members": [str(self.first.id), str(self.second.id)]},
        ):
            with self.subTest(row=row):
                body = self.bundle_body()
                body["variants"][0].update(row)
                with self.assertRaisesRegex(ValueError, "bundle products"):
                    action_save_sales_product(self.user, body)

    def test_a_product_can_only_appear_once_in_a_box(self) -> None:
        with self.assertRaisesRegex(ValueError, "each product once"):
            action_save_sales_product(
                self.user,
                self.bundle_body(
                    components=[
                        {"productId": str(self.first.id), "quantity": 1, "position": 0},
                        {"productId": str(self.first.id), "quantity": 1, "position": 1},
                    ]
                ),
            )

    def test_component_counts_set_the_units_and_the_money_split(self) -> None:
        """The counts the merchant typed are the counts each product gets.

        With nothing priced the split falls to count, and the attributed
        money follows the same weights rather than an even split.
        """
        action_save_sales_product(
            self.user,
            self.bundle_body(
                components=[
                    {"productId": str(self.first.id), "quantity": 4, "position": 0},
                    {"productId": str(self.second.id), "quantity": 6, "position": 1},
                ],
                attributionPercent=80,
            ),
        )
        variant = self.saved_variant()
        self.assertEqual(variant.attribution_percent, 80)

        line = self.bundle_line(variant, net=1000)
        by_name = {entry.product.name: entry for entry in self.expanded(line)}
        self.assertEqual(by_name["First cookie"].quantity, Decimal("4"))
        self.assertEqual(by_name["Second cookie"].quantity, Decimal("6"))
        # 80% of the sale is attributed, then split 4:6 — the other 20% is
        # the untracked half of the box and reaches no product at all.
        self.assertEqual(by_name["First cookie"].net_sales_cents, 320)
        self.assertEqual(by_name["Second cookie"].net_sales_cents, 480)

    def test_attribution_is_money_only_and_never_touches_units(self) -> None:
        action_save_sales_product(
            self.user,
            self.bundle_body(
                components=[
                    {"productId": str(self.first.id), "quantity": 1, "position": 0},
                    {"productId": str(self.second.id), "quantity": 1, "position": 1},
                ],
                attributionPercent=0,
            ),
        )
        line = self.bundle_line(self.saved_variant(), net=500)
        contributions = self.expanded(line)
        self.assertEqual(
            [entry.quantity for entry in contributions],
            [Decimal("1"), Decimal("1"), Decimal("1")],
        )
        self.assertEqual([entry.net_sales_cents for entry in contributions], [0, 0, 0])

    def test_a_component_count_must_be_a_positive_number(self) -> None:
        for quantity in (0, -1):
            with self.subTest(quantity=quantity):
                with self.assertRaisesRegex(ValueError, "quantity"):
                    action_save_sales_product(
                        self.user,
                        self.bundle_body(
                            components=[
                                {
                                    "productId": str(self.first.id),
                                    "quantity": quantity,
                                    "position": 0,
                                }
                            ]
                        ),
                    )

    def test_attribution_outside_zero_to_one_hundred_is_refused(self) -> None:
        for percent in (-1, 101, 12.5):
            with self.subTest(percent=percent):
                with self.assertRaisesRegex(ValueError, "Attribution"):
                    action_save_sales_product(
                        self.user, self.bundle_body(attributionPercent=percent)
                    )

    def test_an_omitted_attribution_key_leaves_a_saved_share_alone(self) -> None:
        """A client that predates the field must not silently reset it.

        Both processes deploy separately, so an older client saving an
        unrelated edit would otherwise hand a 50% variant's products the whole
        sale again, rewriting every historical figure they have.
        """
        created = action_save_sales_product(
            self.user, self.bundle_body(attributionPercent=50)
        )
        variant = self.saved_variant()
        # The default body carries no attributionPercent at all, which is
        # exactly the older client's request.
        body = self.bundle_body()
        body["id"] = created["id"]
        body["expectedEditVersion"] = created["editVersion"]
        body["variants"][0]["id"] = str(variant.id)
        self.assertNotIn("attributionPercent", body["variants"][0])

        action_save_sales_product(self.user, body)

        variant.refresh_from_db()
        self.assertEqual(variant.attribution_percent, 50)

    def test_an_explicit_null_attribution_clears_a_saved_share(self) -> None:
        created = action_save_sales_product(
            self.user, self.bundle_body(attributionPercent=50)
        )
        variant = self.saved_variant()
        body = self.bundle_body(attributionPercent=None)
        body["id"] = created["id"]
        body["expectedEditVersion"] = created["editVersion"]
        body["variants"][0]["id"] = str(variant.id)

        action_save_sales_product(self.user, body)

        variant.refresh_from_db()
        self.assertIsNone(variant.attribution_percent)

    def test_attribution_is_settable_on_a_variant_that_already_exists(self) -> None:
        """"Not answered yet" has to be a state the merchant can leave."""
        action_save_sales_product(self.user, self.bundle_body())
        variant = self.saved_variant()

        action_update_sales_variant_attribution(
            self.user, {"variantId": str(variant.id), "attributionPercent": 80}
        )

        variant.refresh_from_db()
        self.assertEqual(variant.attribution_percent, 80)
        line = self.bundle_line(variant, net=1000)
        self.assertEqual(sum(entry.net_sales_cents for entry in self.expanded(line)), 800)

    def test_a_bundles_units_per_sale_are_an_ordinary_multiplier_edit(self) -> None:
        """Two boxes per sale is the multiplier's answer, not the box's."""
        action_save_sales_product(self.user, self.bundle_body())
        variant = self.saved_variant()
        line = self.bundle_line(variant, net=1000)

        action_update_sales_variant_multiplier(
            self.user, {"variantId": str(variant.id), "quantityMultiplier": 2}
        )

        variant.refresh_from_db()
        self.assertEqual(variant.quantity_multiplier, Decimal("2"))
        line.refresh_from_db()
        self.assertEqual(
            [entry.quantity for entry in self.expanded(line)],
            [Decimal("2"), Decimal("6"), Decimal("6")],
        )

    def test_saving_components_replaces_what_is_in_the_box(self) -> None:
        created = action_save_sales_product(self.user, self.bundle_body())
        third = self.product("Third cookie")
        body = self.bundle_body(
            components=[{"productId": str(third.id), "quantity": 2, "position": 0}]
        )
        body["id"] = created["id"]
        body["expectedEditVersion"] = created["editVersion"]
        body["variants"][0]["id"] = str(self.saved_variant().id)

        action_save_sales_product(self.user, body)

        bundle = SalesProduct.objects.get(id=created["id"])
        self.assertEqual(
            list(
                bundle.components.values_list("component_product_id", flat=True)
            ),
            [third.id],
        )

    def test_a_product_inside_a_box_is_protected_and_names_the_box(self) -> None:
        action_save_sales_product(self.user, self.bundle_body())
        with self.assertRaisesRegex(ValueError, "Cookie box"):
            action_delete_sales_product(self.user, {"id": str(self.first.id)})

        direct = self.product("Direct cookie")
        variant = SalesProductVariant.objects.create(
            user=self.user,
            product=direct,
            channel="square",
            match_key="square:item:DIRECT",
            external_name="Direct cookie",
        )
        sales_import = SalesImport.objects.create(
            user=self.user, file_name="direct.csv", channel="square"
        )
        line = SalesLine.objects.create(
            user=self.user, sales_import=sales_import, product=direct, variant=variant,
            channel="square", source_position=2, source_fingerprint="direct",
            external_order_id="two", sold_at=timezone.now(), item_name="Direct cookie",
            group_key=variant.match_key, quantity=Decimal("1"),
        )
        action_delete_sales_product(self.user, {"id": str(direct.id)})
        line.refresh_from_db()
        self.assertIsNone(line.product_id)
        self.assertIsNone(line.variant_id)

    def test_an_empty_box_allocates_nothing_and_keeps_its_own_sale(self) -> None:
        """A box nobody has filled in yet is still a product that sold."""
        created = action_save_sales_product(
            self.user, self.bundle_body(components=[])
        )
        variant = self.saved_variant()
        line = self.bundle_line(variant, net=500)
        contributions = self.expanded(line)
        self.assertEqual(len(contributions), 1)
        self.assertEqual(str(contributions[0].product.id), created["id"])
        self.assertEqual(contributions[0].net_sales_cents, 500)

    def test_reinterpret_keeps_manual_variant_and_undoable_import_facts(self) -> None:
        action_save_sales_product(self.user, self.bundle_body())
        variant = self.saved_variant()
        receipt = reinterpret_sales(self.user)
        self.assertEqual(receipt["parentLinesDetached"], 0)
        self.assertTrue(SalesProductVariant.objects.filter(id=variant.id).exists())

    def direct_body(self, **variant_overrides: object) -> dict:
        variant = {
            "id": None,
            "channel": "square",
            "matchKey": "square:item:COOKIE",
            "externalName": "Cookie",
            "quantityMultiplier": 2,
        }
        variant.update(variant_overrides)
        return {
            "id": None,
            "name": "Cookie",
            "isActive": True,
            "recipeLinks": [],
            "variants": [variant],
        }

    def test_a_variant_saves_at_any_multiplier(self) -> None:
        action_save_sales_product(self.user, self.direct_body())
        variant = SalesProductVariant.objects.get(
            user=self.user, match_key="square:item:COOKIE"
        )
        self.assertEqual(variant.quantity_multiplier, Decimal("2"))

    def test_a_variant_without_a_percentage_counts_the_whole_sale(
        self,
    ) -> None:
        """No answer is the answer: attribution defaults to all of it.

        Nothing in a catalog has to be visited for its figures to be right,
        and a variant that is not the whole sale can still say so by hand.
        """
        variant = SalesProductVariant.objects.create(
            user=self.user,
            product=self.product("One unit"),
            channel="square",
            provider_account_id="M1",
            match_key="square:item:ONEUNIT",
            external_name="One unit",
            quantity_multiplier=Decimal("1"),
        )
        self.assertIsNone(variant.attribution_percent)
        line = self.bundle_line(variant, net=1000)
        self.assertEqual(
            [entry.net_sales_cents for entry in interpret_line(line)], [1000]
        )

        action_update_sales_variant_attribution(
            self.user,
            {"variantId": str(variant.id), "attributionPercent": 50},
        )
        self.assertEqual(
            [
                entry.net_sales_cents
                for entry in interpret_line(SalesLine.objects.get(id=line.id))
            ],
            [500],
        )


class BundleValueLadderTests(TestCase):
    """Which rung a level stands on, and that nesting conserves every cent."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="ladder@example.com", password="test-password"
        )
        self.sales_import = SalesImport.objects.create(
            user=self.user, file_name="sales.csv", channel="square"
        )

    def product(self, name: str, *, price: int = 0) -> SalesProduct:
        return SalesProduct.objects.create(
            user=self.user,
            name=name,
            normalized_name=name.casefold(),
            sell_price_cents=price,
        )

    def contains(self, bundle: SalesProduct, members: dict) -> None:
        for position, (member, count) in enumerate(members.items()):
            SalesProductComponent.objects.create(
                product=bundle,
                component_product=member,
                quantity=Decimal(str(count)),
                unit="",
                position=position,
            )

    def costed(self, product: SalesProduct, cents: int) -> None:
        ingredient = Ingredient.objects.create(
            user=self.user,
            name=f"{product.name} material",
            purchase_cost_cents=cents,
            purchase_size=Decimal("1"),
            purchase_unit="each",
        )
        SalesProductComponent.objects.create(
            product=product,
            ingredient=ingredient,
            quantity=Decimal("1"),
            unit="each",
        )

    def sale(self, product: SalesProduct, *, net: int, quantity: str = "1") -> SalesLine:
        variant = SalesProductVariant.objects.create(
            user=self.user,
            product=product,
            channel="square",
            match_key=f"square:item:{product.name}",
            external_name=product.name,
            quantity_multiplier=Decimal("1"),
        )
        return SalesLine.objects.create(
            user=self.user,
            sales_import=self.sales_import,
            product=product,
            variant=variant,
            channel="square",
            source_position=1,
            source_fingerprint=f"sale-{product.id}",
            external_order_id="one",
            sold_at=timezone.now(),
            item_name=product.name,
            quantity=Decimal(quantity),
            gross_cents=net,
            net_sales_cents=net,
        )

    def expanded(self, line: SalesLine) -> dict:
        return {
            entry.product.name: entry
            for entry in interpret_line(line, index=BundleIndex.for_user(self.user))
        }

    def test_every_member_priced_splits_by_price(self) -> None:
        cheap = self.product("Cheap", price=100)
        dear = self.product("Dear", price=300)
        box = self.product("Box")
        self.contains(box, {cheap: 1, dear: 1})

        rows = self.expanded(self.sale(box, net=400))

        self.assertEqual(rows["Cheap"].net_sales_cents, 100)
        self.assertEqual(rows["Dear"].net_sales_cents, 300)
        self.assertEqual(
            BundleIndex.for_user(self.user).split_basis(box.id), "price"
        )

    def test_one_unpriced_member_drops_the_level_to_cost(self) -> None:
        cheap = self.product("Cheap", price=100)
        dear = self.product("Dear")
        box = self.product("Box")
        self.contains(box, {cheap: 1, dear: 1})
        self.costed(cheap, 50)
        self.costed(dear, 150)

        rows = self.expanded(self.sale(box, net=400))

        self.assertEqual(rows["Cheap"].net_sales_cents, 100)
        self.assertEqual(rows["Dear"].net_sales_cents, 300)
        self.assertEqual(
            BundleIndex.for_user(self.user).split_basis(box.id), "cost"
        )

    def test_one_uncosted_member_drops_the_level_to_count(self) -> None:
        cheap = self.product("Cheap", price=100)
        dear = self.product("Dear")
        box = self.product("Box")
        self.contains(box, {cheap: 3, dear: 1})
        self.costed(cheap, 50)

        rows = self.expanded(self.sale(box, net=400))

        self.assertEqual(rows["Cheap"].net_sales_cents, 300)
        self.assertEqual(rows["Dear"].net_sales_cents, 100)
        self.assertEqual(
            BundleIndex.for_user(self.user).split_basis(box.id), "count"
        )

    def test_a_nested_box_conserves_every_cent_at_every_level(self) -> None:
        """Three levels on two different rungs, and nothing leaks."""
        lotus = self.product("Lotus", price=500)
        bean = self.product("Bean", price=300)
        inner = self.product("Inner box")
        self.contains(inner, {lotus: 2, bean: 1})
        tea = self.product("Tea")
        outer = self.product("Outer kit")
        self.contains(outer, {inner: 1, tea: 3})

        line = self.sale(outer, net=1001)
        rows = self.expanded(line)

        self.assertEqual(rows["Outer kit"].net_sales_cents, 0)
        self.assertEqual(rows["Inner box"].net_sales_cents, 0)
        self.assertEqual(
            rows["Inner box"].net_sales_cents + rows["Tea"].net_sales_cents
            + rows["Lotus"].net_sales_cents + rows["Bean"].net_sales_cents,
            1001,
            "the outer split's whole share reaches leaf products",
        )
        self.assertEqual(rows["Lotus"].quantity, Decimal("2"))
        self.assertEqual(rows["Bean"].quantity, Decimal("1"))
        self.assertEqual(rows["Tea"].quantity, Decimal("3"))
        self.assertEqual(rows["Inner box"].depth, 1)
        self.assertEqual(rows["Lotus"].depth, 2)
        index = BundleIndex.for_user(self.user)
        self.assertEqual(index.split_basis(outer.id), "count")
        self.assertEqual(index.split_basis(inner.id), "price")

    def test_a_fractional_count_still_allocates_exactly(self) -> None:
        half = self.product("Half cake")
        whole = self.product("Whole cake")
        box = self.product("Cake box")
        self.contains(box, {half: Decimal("0.5"), whole: 1})

        rows = self.expanded(self.sale(box, net=999))

        self.assertEqual(
            rows["Half cake"].net_sales_cents + rows["Whole cake"].net_sales_cents,
            999,
        )
        self.assertEqual(rows["Half cake"].quantity, Decimal("0.5"))


class BundleLifecycleTests(TestCase):
    """A product becomes a box and stops being one, with history attached."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="lifecycle@example.com", password="test-password"
        )
        SalesChannelConnection.objects.create(
            user=self.user,
            provider="square",
            provider_account_id="M1",
            access_token_encrypted="token",
            status=SalesChannelConnection.Status.ACTIVE,
        )
        self.member_a = self.product("Almond croissant")
        self.member_b = self.product("Butter croissant")
        self.sales_import = SalesImport.objects.create(
            user=self.user, file_name="sales.csv", channel="square"
        )

    def product(self, name: str) -> SalesProduct:
        return SalesProduct.objects.create(
            user=self.user, name=name, normalized_name=name.casefold()
        )

    def body(self, *, components: list, variant_id: str | None = None) -> dict:
        variant: dict[str, object] = {"quantityMultiplier": 1}
        if variant_id:
            variant["id"] = variant_id
        else:
            variant.update(
                {
                    "id": None,
                    "channel": "square",
                    "providerAccountId": "M1",
                    "matchKey": "square:item:BOX",
                    "externalName": "Croissant box",
                }
            )
        return {
            "id": None,
            "name": "Croissant box",
            "isActive": True,
            "components": components,
            "variants": [variant],
        }

    def line_for(self, variant: SalesProductVariant) -> SalesLine:
        return SalesLine.objects.create(
            user=self.user,
            sales_import=self.sales_import,
            product=variant.product,
            variant=variant,
            channel="square",
            provider_account_id="M1",
            source_position=1,
            source_fingerprint="box-sale",
            external_order_id="one",
            sold_at=timezone.now(),
            item_name="Croissant box",
            group_key=variant.match_key,
            match_key=variant.match_key,
            quantity=Decimal("1"),
            gross_cents=101,
            net_sales_cents=101,
        )

    def test_filling_a_product_with_products_splits_its_attached_history(self) -> None:
        created = action_save_sales_product(self.user, self.body(components=[]))
        variant = SalesProductVariant.objects.get(user=self.user, match_key="square:item:BOX")
        line = self.line_for(variant)
        self.assertEqual(str(line.product_id), created["id"])

        action_save_sales_product(
            self.user,
            {
                "id": created["id"],
                "expectedEditVersion": created["editVersion"],
                "components": [
                    {"productId": str(self.member_a.id), "quantity": 1, "position": 0},
                    {"productId": str(self.member_b.id), "quantity": 1, "position": 1},
                ],
            },
        )

        line.refresh_from_db()
        self.assertEqual(str(line.product_id), created["id"], "as sold never moves")
        contributions = interpret_line(line, index=BundleIndex.for_user(self.user))
        self.assertEqual(
            {entry.product.id for entry in contributions if entry.via_bundle},
            {self.member_a.id, self.member_b.id},
        )
        self.assertEqual(sum(entry.net_sales_cents for entry in contributions), 101)

    def test_emptying_a_box_makes_it_a_plain_product_again(self) -> None:
        created = action_save_sales_product(
            self.user,
            self.body(
                components=[
                    {"productId": str(self.member_a.id), "quantity": 1, "position": 0},
                    {"productId": str(self.member_b.id), "quantity": 1, "position": 1},
                ]
            ),
        )
        variant = SalesProductVariant.objects.get(user=self.user, match_key="square:item:BOX")
        line = self.line_for(variant)

        action_save_sales_product(
            self.user,
            {
                "id": created["id"],
                "expectedEditVersion": created["editVersion"],
                "components": [],
            },
        )

        line.refresh_from_db()
        contributions = interpret_line(line, index=BundleIndex.for_user(self.user))
        self.assertEqual(len(contributions), 1)
        self.assertEqual(contributions[0].net_sales_cents, 101)

    def test_deleting_a_product_still_releases_its_own_history(self) -> None:
        created = action_save_sales_product(self.user, self.body(components=[]))
        product = SalesProduct.objects.get(id=created["id"])
        variant = SalesProductVariant.objects.get(user=self.user, product=product)
        line = self.line_for(variant)
        legacy = SalesLine.objects.create(
            user=self.user,
            sales_import=self.sales_import,
            product=product,
            variant=None,
            channel="square",
            provider_account_id="M1",
            source_position=2,
            source_fingerprint="legacy-sale",
            external_order_id="two",
            sold_at=timezone.now(),
            item_name="Box",
            group_key=variant.match_key,
            match_key=variant.match_key,
            quantity=Decimal("1"),
        )

        action_delete_sales_product(self.user, {"id": str(product.id)})

        line.refresh_from_db()
        legacy.refresh_from_db()
        self.assertIsNone(line.product_id)
        self.assertIsNone(line.variant_id)
        self.assertIsNone(legacy.product_id)
        self.assertIsNone(legacy.variant_id)


class AllocateCentsByWeightTests(TestCase):
    """The one place a sale's money becomes several products' money.

    Every rollup reconciles only because these shares sum to what went in, so
    the property matters more than any particular split.
    """

    def test_shares_always_sum_to_the_total(self) -> None:
        cases = [
            (101, [1, 1]),
            (1001, [4, 6]),
            (700, [1, 1, 1]),
            (1, [5, 3, 1]),
            (0, [4, 6]),
            (-101, [1, 1]),
            (-1001, [4, 6]),
            (999_999, [7, 11, 13]),
        ]
        for total, weights in cases:
            with self.subTest(total=total, weights=weights):
                shares = allocate_cents_by_weight(total, weights)
                self.assertEqual(sum(shares), total)
                self.assertEqual(len(shares), len(weights))

    def test_uneven_weights_split_in_proportion(self) -> None:
        self.assertEqual(allocate_cents_by_weight(1000, [4, 6]), [400, 600])
        self.assertEqual(allocate_cents_by_weight(800, [4, 6]), [320, 480])
        self.assertEqual(allocate_cents_by_weight(100, [1, 3]), [25, 75])

    def test_a_refund_mirrors_its_sale(self) -> None:
        """A refund must undo exactly what the sale attributed."""
        for weights in ([1, 1], [4, 6], [5, 3, 1]):
            with self.subTest(weights=weights):
                sale = allocate_cents_by_weight(1001, weights)
                refund = allocate_cents_by_weight(-1001, weights)
                self.assertEqual(refund, [-share for share in sale])

    def test_an_indivisible_remainder_lands_on_one_member(self) -> None:
        shares = allocate_cents_by_weight(101, [1, 1])
        self.assertEqual(sorted(shares), [50, 51])

    def test_an_empty_member_set_allocates_nothing(self) -> None:
        self.assertEqual(allocate_cents_by_weight(500, []), [])

    def test_a_non_positive_weight_is_refused(self) -> None:
        with self.assertRaisesMessage(ValueError, "above zero"):
            allocate_cents_by_weight(100, [1, 0])


class BundleComponentTests(TestCase):
    """A product whose components are products: the R1 shape, no sales yet."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="bundle@example.com", password="test-password"
        )
        self.box = self.product("Gift box")
        self.cookie = self.product("Cookie")
        self.brownie = self.product("Brownie")
        self.butter = Ingredient.objects.create(
            user=self.user,
            name="Butter",
            normalized_name="butter",
            purchase_cost_cents=500,
            purchase_size=1000,
            purchase_unit="g",
        )

    def product(self, name: str) -> SalesProduct:
        return SalesProduct.objects.create(
            user=self.user, name=name, normalized_name=name.casefold()
        )

    def link(
        self, product: SalesProduct, member: SalesProduct, quantity: int = 1
    ) -> SalesProductComponent:
        return SalesProductComponent.objects.create(
            product=product, component_product=member, quantity=quantity
        )

    def ingredient_component(self, product: SalesProduct, grams: int) -> None:
        SalesProductComponent.objects.create(
            product=product, ingredient=self.butter, quantity=grams, unit="g"
        )

    def save_components(self, product: SalesProduct, components: list[dict]) -> None:
        action_save_sales_product(
            self.user,
            {
                "id": str(product.id),
                "expectedEditVersion": product.edit_version,
                "components": components,
            },
        )

    def member_row(self, member: SalesProduct, quantity: int = 1) -> dict:
        return {
            "recipeId": None,
            "ingredientId": None,
            "productId": str(member.id),
            "quantity": quantity,
            "unit": "",
            "position": 0,
        }

    # --- constraints -------------------------------------------------------

    def test_the_database_refuses_a_component_with_two_targets(self) -> None:
        with self.assertRaises(IntegrityError), transaction.atomic():
            SalesProductComponent.objects.create(
                product=self.box,
                ingredient=self.butter,
                component_product=self.cookie,
                quantity=1,
                unit="g",
            )

    def test_the_database_refuses_a_unit_on_a_product_component(self) -> None:
        with self.assertRaises(IntegrityError), transaction.atomic():
            SalesProductComponent.objects.create(
                product=self.box,
                component_product=self.cookie,
                quantity=1,
                unit="each",
            )

    def test_the_database_refuses_a_component_with_no_target(self) -> None:
        with self.assertRaises(IntegrityError), transaction.atomic():
            SalesProductComponent.objects.create(product=self.box, quantity=1)

    def test_the_database_refuses_the_same_member_twice(self) -> None:
        self.link(self.box, self.cookie)
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.link(self.box, self.cookie, quantity=2)

    def test_the_database_refuses_a_product_inside_itself(self) -> None:
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.link(self.box, self.box)

    # --- validation --------------------------------------------------------

    def test_clean_refuses_a_product_inside_itself(self) -> None:
        component = SalesProductComponent(
            product=self.box, component_product=self.box, quantity=1
        )
        with self.assertRaisesMessage(
            ValidationError, "A product cannot contain itself"
        ):
            component.clean()

    def test_clean_refuses_a_two_step_cycle(self) -> None:
        self.link(self.box, self.cookie)
        component = SalesProductComponent(
            product=self.cookie, component_product=self.box, quantity=1
        )
        with self.assertRaisesMessage(
            ValidationError, "Bundles cannot contain a cycle"
        ):
            component.clean()

    def test_clean_refuses_a_four_deep_cycle(self) -> None:
        hamper = self.product("Hamper")
        crate = self.product("Crate")
        self.link(self.box, self.cookie)
        self.link(self.cookie, hamper)
        self.link(hamper, crate)
        component = SalesProductComponent(
            product=crate, component_product=self.box, quantity=1
        )
        with self.assertRaisesMessage(
            ValidationError, "Bundles cannot contain a cycle"
        ):
            component.clean()

    def test_clean_refuses_a_member_from_another_workspace(self) -> None:
        stranger = User.objects.create_user(
            email="stranger@example.com", password="test-password"
        )
        theirs = SalesProduct.objects.create(
            user=stranger, name="Theirs", normalized_name="theirs"
        )
        component = SalesProductComponent(
            product=self.box, component_product=theirs, quantity=1
        )
        with self.assertRaisesMessage(ValidationError, "another workspace"):
            component.clean()

    # --- the save path -----------------------------------------------------

    def test_a_save_links_a_product_as_a_component(self) -> None:
        self.save_components(
            self.box, [self.member_row(self.cookie, 3)]
        )
        component = self.box.components.get()
        self.assertEqual(component.component_product_id, self.cookie.id)
        self.assertEqual(component.quantity, Decimal("3.000"))
        self.assertEqual(component.unit, "")

    def test_a_save_refuses_two_targets_on_one_component(self) -> None:
        row = self.member_row(self.cookie)
        row["ingredientId"] = str(self.butter.id)
        with self.assertRaisesMessage(
            ValueError, "A component needs exactly one recipe, ingredient or product"
        ):
            self.save_components(self.box, [row])

    def test_a_save_refuses_a_unit_on_a_product_component(self) -> None:
        row = self.member_row(self.cookie)
        row["unit"] = "each"
        with self.assertRaisesMessage(
            ValueError, "Product components do not use a unit"
        ):
            self.save_components(self.box, [row])

    def test_a_save_refuses_the_same_member_twice(self) -> None:
        with self.assertRaisesMessage(
            ValueError, "A product can only include each product once"
        ):
            self.save_components(
                self.box, [self.member_row(self.cookie), self.member_row(self.cookie)]
            )

    def test_a_save_refuses_a_product_inside_itself(self) -> None:
        with self.assertRaisesMessage(
            ValueError, "A product cannot contain itself"
        ):
            self.save_components(self.box, [self.member_row(self.box)])

    def test_a_save_refuses_a_two_step_cycle(self) -> None:
        self.link(self.box, self.cookie)
        with self.assertRaisesMessage(
            ValueError, "Bundles cannot contain a cycle"
        ):
            self.save_components(self.cookie, [self.member_row(self.box)])

    def test_a_save_refuses_a_four_deep_cycle(self) -> None:
        hamper = self.product("Hamper")
        crate = self.product("Crate")
        self.link(self.box, self.cookie)
        self.link(self.cookie, hamper)
        self.link(hamper, crate)
        with self.assertRaisesMessage(
            ValueError, "Bundles cannot contain a cycle"
        ):
            self.save_components(crate, [self.member_row(self.box)])

    def test_a_save_refuses_another_workspaces_product(self) -> None:
        stranger = User.objects.create_user(
            email="stranger-save@example.com", password="test-password"
        )
        theirs = SalesProduct.objects.create(
            user=stranger, name="Theirs", normalized_name="theirs"
        )
        with self.assertRaisesMessage(ValueError, "Product not found"):
            self.save_components(self.box, [self.member_row(theirs)])

    def test_a_save_refuses_a_new_link_to_an_inactive_product(self) -> None:
        self.cookie.is_active = False
        self.cookie.save(update_fields=["is_active", "updated_at"])
        with self.assertRaisesMessage(ValueError, "That product is not active"):
            self.save_components(self.box, [self.member_row(self.cookie)])

    def test_a_save_keeps_an_existing_link_to_an_inactive_product(self) -> None:
        """Deactivating a member must not lock its bundle out of editing."""
        self.link(self.box, self.cookie)
        self.cookie.is_active = False
        self.cookie.save(update_fields=["is_active", "updated_at"])
        self.save_components(
            self.box, [self.member_row(self.cookie, 2)]
        )
        self.assertEqual(self.box.components.get().quantity, Decimal("2.000"))

    def test_a_member_cannot_be_deleted_while_a_bundle_holds_it(self) -> None:
        self.link(self.box, self.cookie)
        with self.assertRaisesMessage(
            ValueError, "Remove this item from Gift box before deleting it"
        ):
            action_delete_sales_product(self.user, {"id": str(self.cookie.id)})
        self.assertTrue(SalesProduct.objects.filter(id=self.cookie.id).exists())

    # --- cost --------------------------------------------------------------

    def test_a_bundle_costs_the_sum_of_its_members(self) -> None:
        self.ingredient_component(self.cookie, 100)
        self.ingredient_component(self.brownie, 20)
        self.link(self.box, self.cookie, quantity=2)
        self.link(self.box, self.brownie)
        self.assertEqual(product_cost(self.box).cents, 110)

    def test_a_bundle_of_bundles_costs_three_levels_deep(self) -> None:
        hamper = self.product("Hamper")
        self.ingredient_component(self.cookie, 100)
        self.link(self.box, self.cookie, quantity=2)
        self.link(hamper, self.box, quantity=3)
        self.assertEqual(product_cost(hamper).cents, 300)

    def test_a_bundle_adds_its_own_supplies_to_its_members(self) -> None:
        self.ingredient_component(self.cookie, 100)
        self.link(self.box, self.cookie, quantity=2)
        self.ingredient_component(self.box, 10)
        self.assertEqual(product_cost(self.box).cents, 105)

    def test_a_bundles_cost_reads_the_graph_once_however_deep_it_is(self) -> None:
        self.ingredient_component(self.cookie, 100)
        self.ingredient_component(self.brownie, 20)
        self.link(self.box, self.cookie)
        self.link(self.box, self.brownie)
        message = (
            "a bundle's cost must load the component graph and the recipe graph "
            "once; a query per member or per level would make a nested bundle "
            "O(depth)"
        )
        box = SalesProduct.objects.select_related("user").get(id=self.box.id)
        with self.assertNumQueries(3, msg=message):
            product_cost(box)

        hamper = self.product("Hamper")
        self.link(hamper, self.box, quantity=2)
        for index in range(3):
            member = self.product(f"Extra {index}")
            self.ingredient_component(member, 10)
            self.link(hamper, member)
        hamper = SalesProduct.objects.select_related("user").get(id=hamper.id)
        with self.assertNumQueries(3, msg=message):
            self.assertEqual(product_cost(hamper).cents, 135)

    def test_an_uncosted_member_surfaces_under_its_own_name(self) -> None:
        self.link(self.box, self.cookie)
        cost = product_cost(self.box)
        self.assertIsNone(cost.cents)
        self.assertEqual(
            [(issue.code, issue.path) for issue in cost.issues],
            [("no-composition", ("Cookie",))],
        )

    def test_a_cycle_written_around_validation_is_reported_not_walked(self) -> None:
        """The guard is at every write; the cost still refuses to spin."""
        self.link(self.box, self.cookie)
        SalesProductComponent.objects.create(
            product=self.cookie, component_product=self.box, quantity=1
        )
        cost = product_cost(self.box)
        self.assertIsNone(cost.cents)
        self.assertEqual(
            [(issue.code, issue.path) for issue in cost.issues],
            [("product-cycle", ("Gift box", "Cookie", "Gift box"))],
        )
