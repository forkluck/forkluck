from decimal import Decimal
from unittest import mock

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.test import Client, TestCase
from django.utils import timezone

from .models import (
    Recipe,
    SalesProductVariant,
    SalesImport,
    SalesLine,
    SalesLineModifier,
    SalesProduct,
    SalesProductComponent,
    SalesSkuIgnore,
    User,
)
from .testing import InternalApiTestCase
from .domains.sales import core
from .domains.sales.bundles import BundleIndex
from .domains.sales.core import (
    attach_lines_to_variant,
    attach_modifiers_to_variant,
    canonical_name,
    detach_lines_from_variant,
    detach_modifiers_from_variant,
    interpreted_recipe_totals,
    item_object_match_key,
    variant_index,
    menu_overview_payload,
    modifier_candidate_keys,
    modifier_name_match_key,
    modifier_object_match_key,
    product_variant_match_key,
    reinterpret_sales,
    resolve_item_variant,
    sales_group_key,
)


class SalesInterpretationModelTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="interpretation@example.com",
            name="Interpretation Tester",
            password="a-long-test-passphrase-2468",
        )
        self.other_user = User.objects.create_user(
            email="other-interpretation@example.com",
            name="Other Tester",
            password="a-long-test-passphrase-1357",
        )
        self.burger = SalesProduct.objects.create(
            user=self.user, name="Burger", normalized_name="burger"
        )
        self.cheese = SalesProduct.objects.create(
            user=self.user, name="Cheese", normalized_name="cheese"
        )
        self.sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="sales.csv",
            channel=SalesImport.Channel.SQUARE,
        )
        self.position = 0

    # helpers -----------------------------------------------------------

    def make_variant(self, **overrides) -> SalesProductVariant:
        fields = {
            "user": self.user,
            "product": self.burger,
            "channel": SalesImport.Channel.SQUARE,
            "match_key": "square:item:VAR_BURGER",
            "external_name": "Burger",
        }
        fields.update(overrides)
        return SalesProductVariant.objects.create(**fields)

    def make_line(self, **overrides) -> SalesLine:
        self.position += 1
        fields = {
            "user": self.user,
            "sales_import": self.sales_import,
            "channel": SalesImport.Channel.SQUARE,
            "source_position": self.position,
            "source_fingerprint": f"fp-line-{self.position}",
            "external_order_id": f"order-{self.position}",
            "sold_at": timezone.now(),
            "item_name": "Burger",
            "quantity": Decimal("2"),
            "gross_cents": 2000,
            "net_sales_cents": 1800,
            "tax_cents": 200,
        }
        fields.update(overrides)
        return SalesLine.objects.create(**fields)

    def make_modifier(self, line: SalesLine, **overrides) -> SalesLineModifier:
        fields = {
            "user": self.user,
            "sales_line": line,
            "source_uid": "uid-1",
            "source_fingerprint": "fp-mod-1",
            "name": "Extra Cheese",
            "match_key": "square:modifier:*:MOD_CHEESE",
            "quantity": Decimal("2"),
        }
        fields.update(overrides)
        modifier = SalesLineModifier(**fields)
        modifier.full_clean()
        modifier.save()
        return modifier

    # 1-6: variant defaults and validation -------------------------------

    def test_existing_item_variant_defaults_to_one_unit(self) -> None:
        variant = self.make_variant()
        variant.refresh_from_db()
        self.assertEqual(
            variant.identity_kind, SalesProductVariant.IdentityKind.ITEM
        )
        self.assertEqual(variant.quantity_multiplier, Decimal("1"))
        self.assertEqual(variant.external_object_id, "")

    def test_variant_rejects_zero_or_negative_multiplier(self) -> None:
        for bad in (Decimal("0"), Decimal("-1")):
            variant = SalesProductVariant(
                user=self.user,
                product=self.burger,
                channel=SalesImport.Channel.SQUARE,
                match_key=f"square:item:BAD_{bad}",
                external_name="Burger",
                quantity_multiplier=bad,
            )
            with self.assertRaises(ValidationError):
                variant.full_clean()
            with self.assertRaises(IntegrityError):
                with transaction.atomic():
                    variant.save()

    def test_variant_rejects_multiplier_above_cap(self) -> None:
        variant = SalesProductVariant(
            user=self.user,
            product=self.burger,
            channel=SalesImport.Channel.SQUARE,
            match_key="square:item:HUGE",
            external_name="Burger",
            quantity_multiplier=Decimal("1000001"),
        )
        with self.assertRaises(ValidationError):
            variant.full_clean()

    def test_variant_identity_cannot_cross_users(self) -> None:
        self.make_variant()
        other_product = SalesProduct.objects.create(
            user=self.other_user, name="Burger", normalized_name="burger"
        )
        # The same external identity is allowed once per user.
        SalesProductVariant.objects.create(
            user=self.other_user,
            product=other_product,
            channel=SalesImport.Channel.SQUARE,
            match_key="square:item:VAR_BURGER",
            external_name="Burger",
        )
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                SalesProductVariant.objects.create(
                    user=self.user,
                    product=self.burger,
                    channel=SalesImport.Channel.SQUARE,
                    match_key="square:item:VAR_BURGER",
                    external_name="Burger",
                )
        # A modifier occurrence may not borrow another account's identity.
        other_variant = SalesProductVariant.objects.create(
            user=self.other_user,
            product=other_product,
            channel=SalesImport.Channel.SQUARE,
            match_key="square:modifier:*:MOD_CHEESE",
            external_name="Extra Cheese",
            identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
            external_object_id="MOD_CHEESE",
        )
        line = self.make_line()
        modifier = SalesLineModifier(
            user=self.user,
            sales_line=line,
            variant=other_variant,
            source_fingerprint="fp-mod-cross",
            name="Extra Cheese",
            match_key="square:modifier:*:MOD_CHEESE",
            quantity=Decimal("1"),
        )
        with self.assertRaises(ValidationError):
            modifier.full_clean()

    def test_modifier_occurrence_rejects_item_variant(self) -> None:
        item_variant = self.make_variant()
        line = self.make_line()
        modifier = SalesLineModifier(
            user=self.user,
            sales_line=line,
            variant=item_variant,
            source_fingerprint="fp-mod-item",
            name="Extra Cheese",
            match_key="square:modifier:*:MOD_CHEESE",
            quantity=Decimal("1"),
        )
        with self.assertRaises(ValidationError):
            modifier.full_clean()

    # 7-11: modifier occurrence persistence ------------------------------

    def test_modifier_occurrence_belongs_to_financial_line_without_revenue(
        self,
    ) -> None:
        line = self.make_line()
        modifier = self.make_modifier(
            line,
            base_price_cents=150,
            total_price_cents=300,
            source_payload={"uid": "uid-1", "name": "Extra Cheese"},
        )
        line.refresh_from_db()
        self.assertEqual(list(line.modifiers.all()), [modifier])
        self.assertEqual(line.gross_cents, 2000)
        self.assertEqual(line.net_sales_cents, 1800)
        self.assertEqual(SalesLine.objects.count(), 1)
        self.assertFalse(
            hasattr(modifier, "net_sales_cents"),
            "modifier occurrences must not own revenue",
        )
        self.assertEqual(modifier.base_price_cents, 150)
        self.assertEqual(modifier.total_price_cents, 300)
        self.assertEqual(modifier.source_payload["uid"], "uid-1")

    def test_modifier_occurrence_fingerprint_is_unique_per_line(self) -> None:
        first = self.make_line()
        second = self.make_line()
        self.make_modifier(first, source_fingerprint="fp-shared")
        # The same fingerprint on a different line is a different occurrence.
        self.make_modifier(second, source_fingerprint="fp-shared")
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                SalesLineModifier.objects.create(
                    user=self.user,
                    sales_line=first,
                    source_fingerprint="fp-shared",
                    name="Extra Cheese",
                    match_key="square:modifier:*:MOD_CHEESE",
                    quantity=Decimal("1"),
                )

    def test_deleting_sales_line_cascades_modifiers(self) -> None:
        line = self.make_line()
        self.make_modifier(line)
        self.assertEqual(SalesLineModifier.objects.count(), 1)
        line.delete()
        self.assertEqual(SalesLineModifier.objects.count(), 0)

    def test_deleting_variant_detaches_modifier_occurrences(self) -> None:
        variant = self.make_variant(
            product=self.cheese,
            match_key="square:modifier:*:MOD_CHEESE",
            external_name="Extra Cheese",
            identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
            external_object_id="MOD_CHEESE",
        )
        line = self.make_line()
        modifier = self.make_modifier(line, variant=variant)
        variant.delete()
        modifier.refresh_from_db()
        self.assertIsNone(modifier.variant_id)
        self.assertEqual(modifier.match_key, "square:modifier:*:MOD_CHEESE")
        self.assertEqual(modifier.quantity, Decimal("2.000"))

    def test_modifier_quantity_zero_is_preserved_and_consumes_nothing(
        self,
    ) -> None:
        variant = self.make_variant(
            product=self.cheese,
            match_key="square:modifier:*:MOD_CHEESE",
            external_name="Extra Cheese",
            identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
            external_object_id="MOD_CHEESE",
        )
        line = self.make_line()
        modifier = self.make_modifier(
            line, variant=variant, quantity=Decimal("0")
        )
        modifier.refresh_from_db()
        self.assertEqual(modifier.quantity, Decimal("0.000"))
        consumed = (
            line.quantity * modifier.quantity * variant.quantity_multiplier
        )
        self.assertEqual(consumed, Decimal("0"))

    def test_modifier_quantity_cannot_be_negative(self) -> None:
        line = self.make_line()
        modifier = SalesLineModifier(
            user=self.user,
            sales_line=line,
            source_fingerprint="fp-negative",
            name="Extra Cheese",
            match_key="square:modifier:*:MOD_CHEESE",
            quantity=Decimal("-1"),
        )
        with self.assertRaises(ValidationError):
            modifier.full_clean()
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                modifier.save()


class MatchingTests(TestCase):
    """Spec tests 39-48: match keys, resolution priority, and reattachment."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="matching@example.com",
            name="Matching Tester",
            password="a-long-test-passphrase-2468",
        )
        self.sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="sales.csv",
            channel=SalesImport.Channel.SQUARE,
        )
        self.position = 0
        self.burger = self.make_product("Burger")
        self.cheese = self.make_product("Cheese")
        self.cookie = self.make_product("Cookie")

    # helpers -----------------------------------------------------------

    def make_product(self, name: str, normalized: str | None = None) -> SalesProduct:
        return SalesProduct.objects.create(
            user=self.user,
            name=name,
            normalized_name=normalized if normalized is not None else name.casefold(),
        )

    def make_variant(self, product: SalesProduct, match_key: str, **overrides):
        fields = {
            "user": self.user,
            "product": product,
            "channel": SalesImport.Channel.SQUARE,
            "match_key": match_key,
            "external_name": product.name,
        }
        fields.update(overrides)
        return SalesProductVariant.objects.create(**fields)

    def make_line(self, **overrides) -> SalesLine:
        self.position += 1
        fields = {
            "user": self.user,
            "sales_import": self.sales_import,
            "channel": SalesImport.Channel.SQUARE,
            "source_position": self.position,
            "source_fingerprint": f"fp-line-{self.position}",
            "external_order_id": f"order-{self.position}",
            "sold_at": timezone.now(),
            "item_name": "Cookie Box",
            "group_key": sales_group_key("", "Cookie Box", ""),
            "quantity": Decimal("1"),
        }
        fields.update(overrides)
        return SalesLine.objects.create(**fields)

    def make_occurrence(self, line: SalesLine, **overrides) -> SalesLineModifier:
        self.position += 1
        fields = {
            "user": self.user,
            "sales_line": line,
            "source_fingerprint": f"fp-mod-{self.position}",
            "name": "Extra Cheese",
            "external_object_id": "MOD_CHEESE",
            "match_key": "square:modifier:VAR_BURGER:MOD_CHEESE",
            "quantity": Decimal("1"),
        }
        fields.update(overrides)
        return SalesLineModifier.objects.create(**fields)

    # match-key formats --------------------------------------------------

    def test_match_key_formats_are_namespaced(self) -> None:
        self.assertEqual(
            item_object_match_key("square", "VAR_BURGER"), "square:item:VAR_BURGER"
        )
        self.assertEqual(
            modifier_object_match_key("square", "MOD_CHEESE"),
            "square:modifier:*:MOD_CHEESE",
        )
        self.assertEqual(
            modifier_name_match_key("square", " Extra  Cheese "),
            "square:modifier:*:name:extra cheese",
        )
        # Legacy keys are unchanged.
        self.assertEqual(sales_group_key("SKU-1", "Burger", ""), "sku:sku-1")
        self.assertEqual(sales_group_key("", "Burger", "Large"), "name:burger|large")
        self.assertEqual(
            modifier_candidate_keys(
                "square",
                external_object_id="MOD_CHEESE",
                name="Extra Cheese",
            ),
            [
                "square:modifier:*:MOD_CHEESE",
                "square:modifier:*:name:extra cheese",
            ],
        )

    # 39-41: parent item priority ----------------------------------------

    def test_provider_object_id_beats_sku_and_name(self) -> None:
        self.make_variant(
            self.burger,
            item_object_match_key("square", "VAR_BURGER"),
            external_object_id="VAR_BURGER",
        )
        self.make_variant(self.cookie, "sku:sku-1", sku="SKU-1")
        self.make_variant(self.cheese, "name:burger|")
        match = resolve_item_variant(
            self.user,
            channel="square",
            external_object_id="VAR_BURGER",
            group_key="sku:sku-1",
            sku="SKU-1",
            item_name="Burger",
        )
        self.assertEqual(match.status, "matched")
        self.assertEqual(match.reason, "object_id")
        self.assertEqual(match.product, self.burger)

    def test_exact_approved_variant_beats_suggestion(self) -> None:
        latte = self.make_product("Latte")
        self.make_variant(self.cookie, "name:latte|")
        match = resolve_item_variant(
            self.user,
            channel="square",
            group_key="name:latte|",
            item_name="Latte",
        )
        self.assertEqual(match.status, "matched")
        self.assertEqual(match.reason, "match_key")
        # The identically named menu item stays a suggestion, never a match.
        self.assertEqual(match.product, self.cookie)
        self.assertNotEqual(match.product, latte)

    def test_unique_exact_sku_only_suggests_existing_product(self) -> None:
        self.make_variant(
            self.cookie,
            item_object_match_key("square", "VAR_COOKIE"),
            sku="SKU-COOKIE",
            external_object_id="VAR_COOKIE",
        )
        match = resolve_item_variant(
            self.user,
            channel="square",
            group_key="sku:sku-cookie",
            sku="SKU-COOKIE",
            item_name="Cookie Box",
        )
        self.assertEqual(match.status, "suggested")
        self.assertEqual(match.reason, "sku")
        self.assertEqual(match.product, self.cookie)
        # An ambiguous SKU never auto-attaches.
        self.make_variant(
            self.burger,
            item_object_match_key("square", "VAR_OTHER"),
            sku="SKU-COOKIE",
            external_object_id="VAR_OTHER",
        )
        ambiguous = resolve_item_variant(
            self.user,
            channel="square",
            group_key="sku:sku-cookie",
            sku="SKU-COOKIE",
            item_name="Cookie Box",
        )
        self.assertEqual(ambiguous.status, "pending")

    def test_two_provider_identities_with_same_sku_map_independently(self) -> None:
        square = self.make_variant(
            self.cookie,
            item_object_match_key("square", "SQ-VAR-2200"),
            provider_account_id="square-merchant",
            sku="2200",
            external_object_id="SQ-VAR-2200",
        )
        shopify = SalesProductVariant.objects.create(
            user=self.user,
            product=self.cookie,
            channel=SalesImport.Channel.SHOPIFY,
            provider_account_id="shop.myshopify.com",
            match_key=item_object_match_key(
                "shopify", "gid://shopify/ProductVariant/2200"
            ),
            sku="2200",
            external_name="Cookie",
            external_object_id="gid://shopify/ProductVariant/2200",
        )
        self.assertEqual(
            resolve_item_variant(
                self.user,
                channel="square",
                provider_account_id="square-merchant",
                external_object_id="SQ-VAR-2200",
            ).variant,
            square,
        )
        self.assertEqual(
            resolve_item_variant(
                self.user,
                channel="shopify",
                provider_account_id="shop.myshopify.com",
                external_object_id="gid://shopify/ProductVariant/2200",
            ).variant,
            shopify,
        )

    def test_second_provider_same_sku_requires_confirmation(self) -> None:
        self.make_variant(
            self.cookie,
            item_object_match_key("square", "SQ-VAR-2200"),
            provider_account_id="square-merchant",
            sku="2200",
            external_object_id="SQ-VAR-2200",
        )
        match = resolve_item_variant(
            self.user,
            channel="shopify",
            provider_account_id="shop.myshopify.com",
            external_object_id="gid://shopify/ProductVariant/other",
            group_key="sku:2200",
            sku="2200",
            item_name="Cookie",
        )
        self.assertEqual(match.status, "suggested")
        self.assertEqual(match.product, self.cookie)
        self.assertIsNone(match.variant)

    # 42-43: modifier priority -------------------------------------------

    def test_canonical_ampersand_match_is_suggestion_only(self) -> None:
        product = self.make_product("Cookie & Cream", normalized="cookie & cream")
        match = resolve_item_variant(
            self.user, channel="square", item_name="Cookie and Cream"
        )
        self.assertEqual(match.status, "suggested")
        self.assertIsNone(match.variant)
        self.assertEqual(match.reason, "canonical")
        self.assertEqual(match.candidates, (product,))
        self.assertEqual(SalesProductVariant.objects.count(), 0)

    def test_canonical_with_abbreviation_match_is_suggestion_only(self) -> None:
        product = self.make_product("Latte with Oat", normalized="latte with oat")
        self.assertEqual(canonical_name("Latte w/ Oat"), "latte with oat")
        match = resolve_item_variant(
            self.user, channel="square", item_name="Latte w/ Oat"
        )
        self.assertEqual(match.status, "suggested")
        self.assertIsNone(match.variant)
        self.assertEqual(match.product, product)

    def test_ambiguous_canonical_name_has_no_preselected_product(self) -> None:
        first = self.make_product("Gift Box & Ribbon", normalized="gift box & ribbon")
        second = self.make_product(
            "Gift Box and Ribbon", normalized="gift box and ribbon"
        )
        match = resolve_item_variant(
            self.user, channel="square", item_name="Gift Box, and Ribbon"
        )
        self.assertEqual(match.status, "suggested")
        self.assertIsNone(match.product)
        self.assertEqual(set(match.candidates), {first, second})

    # 47-48: approving and removing an alias ------------------------------

    def test_approved_alias_attaches_matching_historical_lines(self) -> None:
        line = self.make_line()
        self.assertIsNone(line.product_id)
        variant = self.make_variant(
            self.cookie, sales_group_key("", "Cookie Box", "")
        )
        self.assertEqual(attach_lines_to_variant(self.user, variant), 1)
        line.refresh_from_db()
        self.assertEqual(line.product, self.cookie)
        self.assertEqual(line.variant, variant)

        occurrence = self.make_occurrence(line)
        self.assertIsNone(occurrence.variant_id)
        global_modifier = self.make_variant(
            self.cheese,
            "square:modifier:*:MOD_CHEESE",
            identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
            external_object_id="MOD_CHEESE",
        )
        self.assertEqual(
            attach_modifiers_to_variant(self.user, global_modifier), 1
        )
        occurrence.refresh_from_db()
        self.assertEqual(occurrence.variant, global_modifier)
        # Re-running claims nothing new.
        self.assertEqual(
            attach_modifiers_to_variant(self.user, global_modifier), 0
        )


    def test_removed_alias_returns_lines_to_review(self) -> None:
        variant = self.make_variant(
            self.cookie, sales_group_key("", "Cookie Box", "")
        )
        line = self.make_line(product=self.cookie, variant=variant)
        modifier_variant = self.make_variant(
            self.cheese,
            "square:modifier:*:MOD_CHEESE",
            identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
            external_object_id="MOD_CHEESE",
        )
        occurrence = self.make_occurrence(line, variant=modifier_variant)

        self.assertEqual(detach_modifiers_from_variant(modifier_variant), 1)
        occurrence.refresh_from_db()
        self.assertIsNone(occurrence.variant_id)
        # Source facts survive so the row can be reviewed again.
        self.assertEqual(occurrence.match_key, "square:modifier:VAR_BURGER:MOD_CHEESE")
        self.assertEqual(occurrence.quantity, Decimal("1.000"))

        self.assertEqual(detach_lines_from_variant(variant), 1)
        line.refresh_from_db()
        self.assertIsNone(line.product_id)
        self.assertIsNone(line.variant_id)


class ReinterpretationTests(TestCase):
    """Spec tests 49-54: mapping changes replayed over stored history."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="reinterpret@example.com",
            name="Reinterpret Tester",
            password="a-long-test-passphrase-2468",
        )
        self.other_user = User.objects.create_user(
            email="other-reinterpret@example.com",
            name="Other Tester",
            password="a-long-test-passphrase-1357",
        )
        self.sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="sales.csv",
            channel=SalesImport.Channel.SQUARE,
        )
        self.position = 0
        self.burger = SalesProduct.objects.create(
            user=self.user, name="Burger", normalized_name="burger"
        )
        self.cheese = SalesProduct.objects.create(
            user=self.user, name="Cheese", normalized_name="cheese"
        )

    # helpers -----------------------------------------------------------

    def make_variant(self, product: SalesProduct, match_key: str, **overrides):
        fields = {
            "user": self.user,
            "product": product,
            "channel": SalesImport.Channel.SQUARE,
            "match_key": match_key,
            "external_name": product.name,
        }
        fields.update(overrides)
        return SalesProductVariant.objects.create(**fields)

    def make_line(self, **overrides) -> SalesLine:
        self.position += 1
        fields = {
            "user": self.user,
            "sales_import": self.sales_import,
            "channel": SalesImport.Channel.SQUARE,
            "source_position": self.position,
            "source_fingerprint": f"fp-line-{self.position}",
            "external_order_id": f"order-{self.position}",
            "sold_at": timezone.now(),
            "item_name": "Burger",
            "group_key": sales_group_key("", "Burger", ""),
            "quantity": Decimal("2"),
            "gross_cents": 2000,
            "net_sales_cents": 1800,
        }
        fields.update(overrides)
        return SalesLine.objects.create(**fields)

    def make_occurrence(self, line: SalesLine, **overrides) -> SalesLineModifier:
        self.position += 1
        fields = {
            "user": self.user,
            "sales_line": line,
            "source_fingerprint": f"fp-mod-{self.position}",
            "name": "Extra Cheese",
            "external_object_id": "MOD_CHEESE",
            "match_key": "square:modifier:VAR_BURGER:MOD_CHEESE",
            "quantity": Decimal("2"),
        }
        fields.update(overrides)
        return SalesLineModifier.objects.create(**fields)

    def tracked_burger_line(self) -> SalesLine:
        variant = self.make_variant(
            self.burger,
            sales_group_key("", "Burger", ""),
            identity_kind=SalesProductVariant.IdentityKind.ITEM,
        )
        return self.make_line(product=self.burger, variant=variant)

    # 49-54 --------------------------------------------------------------

    def test_reinterpretation_is_idempotent(self) -> None:
        line = self.make_line()
        self.make_occurrence(line)
        self.make_variant(self.burger, sales_group_key("", "Burger", ""))
        self.make_variant(
            self.cheese,
            "square:modifier:*:MOD_CHEESE",
            identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
            external_object_id="MOD_CHEESE",
        )

        first = reinterpret_sales(self.user)
        second = reinterpret_sales(self.user)

        self.assertEqual(first["parentLinesAttached"], 1)
        self.assertEqual(first["modifierOccurrencesAttached"], 1)
        for key in (
            "parentLinesAttached",
            "parentLinesDetached",
            "modifierOccurrencesAttached",
            "modifierOccurrencesDetached",
            "linesReinterpreted",
        ):
            self.assertEqual(second[key], 0, key)

    def test_reinterpretation_is_user_scoped(self) -> None:
        other_import = SalesImport.objects.create(
            user=self.other_user,
            file_name="sales.csv",
            channel=SalesImport.Channel.SQUARE,
        )
        other_product = SalesProduct.objects.create(
            user=self.other_user, name="Burger", normalized_name="burger"
        )
        SalesProductVariant.objects.create(
            user=self.other_user,
            product=other_product,
            channel=SalesImport.Channel.SQUARE,
            match_key=sales_group_key("", "Burger", ""),
            external_name="Burger",
        )
        other_line = SalesLine.objects.create(
            user=self.other_user,
            sales_import=other_import,
            channel=SalesImport.Channel.SQUARE,
            source_position=1,
            source_fingerprint="fp-other-1",
            external_order_id="order-other",
            sold_at=timezone.now(),
            item_name="Burger",
            group_key=sales_group_key("", "Burger", ""),
            quantity=Decimal("1"),
        )
        line = self.make_line()
        self.make_variant(self.burger, sales_group_key("", "Burger", ""))

        receipt = reinterpret_sales(self.user)

        self.assertEqual(receipt["parentLinesAttached"], 1)
        line.refresh_from_db()
        other_line.refresh_from_db()
        self.assertEqual(line.product_id, self.burger.id)
        self.assertIsNone(other_line.product_id)

    def test_a_multi_rung_pass_attaches_the_same_lines_and_receipt(self) -> None:
        """Every resolution rung, replayed in one batched pass.

        `reinterpret_sales` resolves line by line but writes one `UPDATE` per
        distinct (product, variant) target, so the receipt is now arithmetic
        over grouped writes rather than a counter bumped per line. This pins
        the whole receipt and every line's landing place across all five
        matching rungs, and extends the idempotence property above to the
        multi-rung case: a second pass over unchanged mappings moves nothing.
        """
        object_variant = self.make_variant(
            self.burger,
            item_object_match_key(SalesImport.Channel.SQUARE, "VAR_OBJECT"),
            external_object_id="VAR_OBJECT",
        )
        group_variant = self.make_variant(
            self.burger, sales_group_key("", "Burger", "")
        )
        sku_variant = self.make_variant(
            self.cheese,
            sales_group_key("SKU-COLD", "Cold Brew", ""),
            sku="SKU-COLD",
        )
        title_variant = self.make_variant(
            self.cheese,
            product_variant_match_key(
                SalesImport.Channel.SQUARE, "PROD_TEA", "Large"
            ),
            product_external_object_id="PROD_TEA",
        )
        name_variant = self.make_variant(
            self.burger, sales_group_key("", "Fries", "")
        )

        object_line = self.make_line(
            item_name="Object Box", group_key="", external_object_id="VAR_OBJECT"
        )
        group_line = self.make_line()
        sku_line = self.make_line(
            item_name="Cold Brew", group_key="", sku="SKU-COLD"
        )
        variant_line = self.make_line(
            item_name="Tea",
            group_key="",
            product_external_object_id="PROD_TEA",
            external_variant_title="Large",
        )
        name_line = self.make_line(item_name="Fries", group_key="")
        unmatched_line = self.make_line(item_name="Unmapped Special", group_key="")

        first = reinterpret_sales(self.user)

        self.assertEqual(
            first,
            {
                "parentLinesAttached": 5,
                "parentLinesDetached": 0,
                "modifierOccurrencesAttached": 0,
                "modifierOccurrencesDetached": 0,
                "conflicts": [],
                "linesReinterpreted": 5,
            },
        )
        for line, variant, product in (
            (object_line, object_variant, self.burger),
            (group_line, group_variant, self.burger),
            (sku_line, sku_variant, self.cheese),
            (variant_line, title_variant, self.cheese),
            (name_line, name_variant, self.burger),
        ):
            line.refresh_from_db()
            self.assertEqual(line.variant_id, variant.id, line.item_name)
            self.assertEqual(line.product_id, product.id, line.item_name)
        unmatched_line.refresh_from_db()
        self.assertIsNone(unmatched_line.variant_id)
        self.assertIsNone(unmatched_line.product_id)

        second = reinterpret_sales(self.user)

        self.assertEqual(
            second,
            {
                "parentLinesAttached": 0,
                "parentLinesDetached": 0,
                "modifierOccurrencesAttached": 0,
                "modifierOccurrencesDetached": 0,
                "conflicts": [],
                "linesReinterpreted": 0,
            },
        )

    def test_lines_sharing_one_identity_all_attach(self) -> None:
        """The receipt counts attached lines, not distinct targets.

        Claims are grouped by (product, variant) and written one `UPDATE` per
        group, so a count taken per group instead of per row would report 2
        here where five lines moved. Every line of a repeated identity must
        also land on its variant, not just the first of the group.
        """
        burger_variant = self.make_variant(
            self.burger, sales_group_key("", "Burger", "")
        )
        fries_variant = self.make_variant(
            self.cheese, sales_group_key("", "Fries", "")
        )
        burger_lines = [self.make_line() for _ in range(3)]
        fries_lines = [
            self.make_line(item_name="Fries", group_key="") for _ in range(2)
        ]

        receipt = reinterpret_sales(self.user)

        self.assertEqual(
            receipt,
            {
                "parentLinesAttached": 5,
                "parentLinesDetached": 0,
                "modifierOccurrencesAttached": 0,
                "modifierOccurrencesDetached": 0,
                "conflicts": [],
                "linesReinterpreted": 5,
            },
        )
        for line in burger_lines:
            line.refresh_from_db()
            self.assertEqual(line.variant_id, burger_variant.id)
            self.assertEqual(line.product_id, self.burger.id)
        for line in fries_lines:
            line.refresh_from_db()
            self.assertEqual(line.variant_id, fries_variant.id)
            self.assertEqual(line.product_id, self.cheese.id)

    def test_payload_product_id_fallback_resolves_and_stays_guarded(self) -> None:
        """The product fallback still reads a line's raw payload, safely.

        Lines stored before `product_external_object_id` had its own column
        carry the catalog parent only in `source_payload["productObjectId"]`,
        and the product + variant rung is the only way those ever attach. The
        pass now hands the payload to `line_product_object_id` as a value
        rather than reading it off a model, so the guards have to travel with
        it: a payload missing the key, or holding something that is not a
        string, still resolves to no id rather than raising or inventing one.
        """
        variant = self.make_variant(
            self.burger,
            product_variant_match_key(
                SalesImport.Channel.SQUARE, "PROD_LEGACY", "Large"
            ),
            product_external_object_id="PROD_LEGACY",
        )
        payload_line = self.make_line(
            item_name="Legacy Tea",
            group_key="",
            external_variant_title="Large",
            product_external_object_id="",
            source_payload={"productObjectId": "PROD_LEGACY"},
        )
        missing_key_line = self.make_line(
            item_name="Keyless Tea",
            group_key="",
            external_variant_title="Large",
            product_external_object_id="",
            source_payload={"itemObjectId": "PROD_LEGACY"},
        )
        non_string_line = self.make_line(
            item_name="Numeric Tea",
            group_key="",
            external_variant_title="Large",
            product_external_object_id="",
            source_payload={"productObjectId": 123},
        )

        receipt = reinterpret_sales(self.user)

        self.assertEqual(
            receipt,
            {
                "parentLinesAttached": 1,
                "parentLinesDetached": 0,
                "modifierOccurrencesAttached": 0,
                "modifierOccurrencesDetached": 0,
                "conflicts": [],
                "linesReinterpreted": 1,
            },
        )
        payload_line.refresh_from_db()
        self.assertEqual(payload_line.variant_id, variant.id)
        self.assertEqual(payload_line.product_id, self.burger.id)
        for line in (missing_key_line, non_string_line):
            line.refresh_from_db()
            self.assertIsNone(line.variant_id, line.item_name)
            self.assertIsNone(line.product_id, line.item_name)


class SalesInterpretationApiTests(InternalApiTestCase):
    """Spec tests 63-69: variant payloads, overviews, and review actions."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="interpretation-api@example.com",
            name="Interpretation Api Tester",
            password="a-long-test-passphrase-2468",
        )
        self.other_user = User.objects.create_user(
            email="other-interpretation-api@example.com",
            name="Other Api Tester",
            password="a-long-test-passphrase-1357",
        )
        self.client = Client()
        self.client.force_login(self.user)
        self.sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="sales.csv",
            channel=SalesImport.Channel.SQUARE,
        )
        self.position = 0
        self.cookie = SalesProduct.objects.create(
            user=self.user, name="Cookie", normalized_name="cookie"
        )
        self.cheese = SalesProduct.objects.create(
            user=self.user, name="Cheese", normalized_name="cheese"
        )

    # helpers -----------------------------------------------------------

    def get_payload(self, path: str) -> dict:
        response = self.get_internal(path)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def save_menu_item(self, name: str, variants: list[dict], **extra):
        body = {"name": name, "isActive": True, "recipeLinks": [], "variants": variants}
        body.update(extra)
        return self.post_internal("save-sales-product", body)

    def make_line(self, **overrides) -> SalesLine:
        self.position += 1
        fields = {
            "user": self.user,
            "sales_import": self.sales_import,
            "channel": SalesImport.Channel.SQUARE,
            "source_position": self.position,
            "source_fingerprint": f"fp-line-{self.position}",
            "external_order_id": f"order-{self.position}",
            "sold_at": timezone.now(),
            "item_name": "Sampler",
            "group_key": sales_group_key("", "Sampler", ""),
            "quantity": Decimal("2"),
            "gross_cents": 2000,
            "discount_cents": 100,
            "net_sales_cents": 1900,
            "tax_cents": 150,
            "refund_cents": 0,
        }
        fields.update(overrides)
        return SalesLine.objects.create(**fields)

    def make_occurrence(self, line: SalesLine, **overrides) -> SalesLineModifier:
        self.position += 1
        fields = {
            "user": self.user,
            "sales_line": line,
            "source_fingerprint": f"fp-mod-{self.position}",
            "name": "Chocolate Cookie",
            "external_object_id": "MOD_COOKIE",
            "match_key": "square:modifier:VAR_SAMPLER:MOD_COOKIE",
            "quantity": Decimal("1"),
        }
        fields.update(overrides)
        return SalesLineModifier.objects.create(**fields)

    # 63-65: variant payloads --------------------------------------------

    def test_menu_overview_includes_pending_modifier_count(self) -> None:
        line = self.make_line()
        self.make_occurrence(line)
        self.make_occurrence(line, source_fingerprint="fp-mod-b")

        payload = self.get_payload("/internal/v1/menu-overview/")
        review = payload["review"]
        self.assertTrue(review["items"][0]["hasModifiers"])
        self.assertEqual(review["modifierReviewCount"], 1)
        row = review["modifiers"][0]
        self.assertEqual(row["matchKey"], "square:modifier:VAR_SAMPLER:MOD_COOKIE")
        self.assertEqual(row["contextLabel"], "Sampler > Chocolate Cookie")
        self.assertEqual(row["usageCount"], 2)
        self.assertIsNotNone(row["lastSeenAt"])

    def test_pending_modifier_count_survives_a_narrow_section_list(self) -> None:
        """The Products toolbar names the queue without ever drawing its rows."""
        line = self.make_line()
        self.make_occurrence(line)

        payload = self.get_payload("/internal/v1/menu-overview/?sections=items")

        self.assertEqual(payload["review"]["modifiers"], [])
        self.assertEqual(payload["review"]["modifierReviewCount"], 1)

    def test_sales_overview_revenue_totals_ignore_modifier_components(self) -> None:
        variant = SalesProductVariant.objects.create(
            user=self.user,
            product=self.cookie,
            channel=SalesImport.Channel.SQUARE,
            match_key=sales_group_key("", "Sampler", ""),
            external_name="Sampler",
        )
        line = self.make_line(product=self.cookie, variant=variant)
        modifier_variant = SalesProductVariant.objects.create(
            user=self.user,
            product=self.cheese,
            channel=SalesImport.Channel.SQUARE,
            match_key="square:modifier:VAR_SAMPLER:MOD_COOKIE",
            external_name="Chocolate Cookie",
            identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
            external_object_id="MOD_COOKIE",
        )
        self.make_occurrence(line, variant=modifier_variant)

        summary = self.get_payload("/internal/v1/sales-overview/")["summary"]
        self.assertEqual(
            summary,
            {
                "currencyCode": "USD",
                "lineCount": 1,
                "quantity": 2.0,
                "grossCents": 2000,
                "discountCents": 100,
                "netSalesCents": 1900,
                "taxCents": 150,
                "refundCents": 0,
                "orderCount": 1,
                "excludedLineCount": 0,
            },
        )

    # 69: review actions --------------------------------------------------

    def test_tracking_modifier_returns_attached_occurrence_count(self) -> None:
        line = self.make_line()
        self.make_occurrence(line)
        self.make_occurrence(line, source_fingerprint="fp-mod-b")

        response = self.post_internal(
            "track-sales-modifiers",
            {
                "items": [
                    {
                        "matchKey": "square:modifier:VAR_SAMPLER:MOD_COOKIE",
                        "productId": str(self.cookie.id),
                        "externalName": "Chocolate Cookie",
                        "scope": "parent",
                        "quantityMultiplier": 2,
                    }
                ]
            },
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["modifierOccurrencesAttached"], 2)
        self.assertEqual(body["linesReinterpreted"], 1)
        self.assertEqual(body["conflicts"], [])
        self.assertEqual(len(body["variantIds"]), 1)

        variant = SalesProductVariant.objects.get(
            user=self.user, match_key="square:modifier:*:MOD_COOKIE"
        )
        self.assertEqual(variant.identity_kind, "modifier")
        self.assertEqual(variant.quantity_multiplier, Decimal("2.000"))
        self.assertEqual(
            SalesLineModifier.objects.filter(variant=variant).count(), 2
        )

        # Repeating the approval attaches nothing new.
        again = self.post_internal(
            "track-sales-modifiers",
            {
                "items": [
                    {
                        "matchKey": "square:modifier:VAR_SAMPLER:MOD_COOKIE",
                        "productId": str(self.cookie.id),
                        "externalName": "Chocolate Cookie",
                    }
                ]
            },
        )
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.json()["modifierOccurrencesAttached"], 0)

    def test_reinterpret_action_is_idempotent(self) -> None:
        line = self.make_line()
        self.make_occurrence(line)
        SalesProductVariant.objects.create(
            user=self.user,
            product=self.cookie,
            channel=SalesImport.Channel.SQUARE,
            match_key=sales_group_key("", "Sampler", ""),
            external_name="Sampler",
        )

        first = self.post_internal("reinterpret-sales", {})
        second = self.post_internal("reinterpret-sales", {})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["parentLinesAttached"], 1)
        self.assertEqual(second.json()["parentLinesAttached"], 0)

    def test_ignoring_a_modifier_clears_it_from_review(self) -> None:
        line = self.make_line()
        self.make_occurrence(line)

        response = self.post_internal(
            "ignore-sales-modifiers",
            {
                "items": [
                    {
                        "channel": "square",
                        "matchKey": "square:modifier:VAR_SAMPLER:MOD_COOKIE",
                        "externalName": "Chocolate Cookie",
                        "externalVariantTitle": "Sampler",
                    }
                ]
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["ignored"], 1)
        payload = self.get_payload("/internal/v1/menu-overview/")
        review = payload["review"]
        self.assertEqual(review["modifierReviewCount"], 0)
        self.assertEqual(review["ignoredItemCount"], 0)
        self.assertEqual(review["ignoredModifierCount"], 1)
        self.assertEqual(review["ignoredItems"], [])
        ignored = review["ignoredModifiers"][0]
        self.assertEqual(ignored["identityKind"], "modifier")
        self.assertEqual(ignored["externalName"], "Chocolate Cookie")

        restored = self.post_internal(
            "unignore-sales-modifiers",
            {
                "items": [
                    {
                        "channel": "square",
                        "matchKey": "square:modifier:VAR_SAMPLER:MOD_COOKIE",
                    }
                ]
            },
        )
        self.assertEqual(restored.status_code, 200)
        payload = self.get_payload("/internal/v1/menu-overview/")
        self.assertEqual(payload["review"]["modifierReviewCount"], 1)
        self.assertEqual(payload["review"]["ignoredModifierCount"], 0)
        self.assertEqual(payload["review"]["ignoredModifiers"], [])



class CategoryTriageTests(InternalApiTestCase):
    """Category-scoped review triage: category on pending rows, bulk ignore by
    category, and the modifier cascade under an ignored parent."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="triage@example.com",
            name="Triage Tester",
            password="a-long-test-passphrase-2468",
        )
        self.other_user = User.objects.create_user(
            email="other-triage@example.com",
            name="Other Triage Tester",
            password="a-long-test-passphrase-1357",
        )
        self.client = Client()
        self.client.force_login(self.user)
        self.position = 0

    # helpers -----------------------------------------------------------

    def make_line(self, user=None, **overrides) -> SalesLine:
        user = user or self.user
        self.position += 1
        sales_import = SalesImport.objects.create(
            user=user, file_name="sales.csv", channel=SalesImport.Channel.SQUARE
        )
        fields = {
            "user": user,
            "sales_import": sales_import,
            "channel": SalesImport.Channel.SQUARE,
            "source_position": 1,
            "source_fingerprint": f"fp-{self.position}",
            "external_order_id": f"order-{self.position}",
            "sold_at": timezone.now(),
            "item_name": "Tea Flight",
            "external_variant_title": "",
            "sku": "TEA-01",
            "group_key": sales_group_key("TEA-01", "Tea Flight", ""),
            "external_category": "Tea",
            "quantity": Decimal("1"),
            "gross_cents": 1200,
            "net_sales_cents": 1200,
        }
        fields.update(overrides)
        return SalesLine.objects.create(**fields)

    def make_occurrence(self, line: SalesLine, **overrides) -> SalesLineModifier:
        self.position += 1
        fields = {
            "user": line.user,
            "sales_line": line,
            "source_fingerprint": f"fp-mod-{self.position}",
            "name": "Honey",
            "external_object_id": "MOD_HONEY",
            "match_key": "square:modifier:*:MOD_HONEY",
            "quantity": Decimal("1"),
        }
        fields.update(overrides)
        return SalesLineModifier.objects.create(**fields)

    def review(self) -> dict:
        return menu_overview_payload(self.user)["review"]

    # category on the pending payload ------------------------------------

    def test_review_rows_order_by_revenue_and_cap_keeps_the_top(self) -> None:
        # The per-category render cap keeps a prefix of the payload order, so
        # that order must be revenue, not whatever the database returns —
        # collation cannot decide which identities the merchant gets to act on.
        for sku, cents in (("MID-01", 200), ("LOW-01", 100), ("TOP-01", 300)):
            self.make_line(
                sku=sku,
                item_name=f"Item {sku}",
                group_key=sales_group_key(sku, f"Item {sku}", ""),
                net_sales_cents=cents,
            )

        # Zero-revenue ties order by match key in Python codepoint order —
        # inserted reversed so database order cannot pass by accident.
        for sku in ("ZERO-B", "ZERO-A"):
            self.make_line(
                sku=sku,
                item_name=f"Item {sku}",
                group_key=sales_group_key(sku, f"Item {sku}", ""),
                net_sales_cents=0,
            )

        items = self.review()["items"]
        self.assertEqual(
            [row["sku"] for row in items],
            ["TOP-01", "MID-01", "LOW-01", "ZERO-A", "ZERO-B"],
        )

        with mock.patch.object(core, "REVIEW_RENDER_CAP", 2):
            capped = self.review()
        self.assertEqual(
            [row["sku"] for row in capped["items"]], ["TOP-01", "MID-01"]
        )
        self.assertEqual(capped["reviewCount"], 5)

    def test_pending_item_rows_carry_the_provider_category(self) -> None:
        self.make_line()
        self.make_line(
            sku="TOTE-01",
            item_name="Tote Bag",
            group_key=sales_group_key("TOTE-01", "Tote Bag", ""),
            external_category="",
        )
        review = self.review()
        by_sku = {row["sku"]: row for row in review["items"]}
        self.assertEqual(by_sku["TEA-01"]["category"], "Tea")
        # Uncategorized is a bucket, not a missing field.
        self.assertEqual(by_sku["TOTE-01"]["category"], "")

    def test_pending_categories_roll_up_over_every_pending_group(self) -> None:
        self.make_line()
        self.make_line(external_order_id="second")
        self.make_line(
            sku="TOTE-01",
            item_name="Tote Bag",
            group_key=sales_group_key("TOTE-01", "Tote Bag", ""),
            external_category="",
        )
        rollup = {row["category"]: row for row in self.review()["categories"]}
        self.assertEqual(rollup["Tea"]["keyCount"], 1)
        self.assertEqual(rollup["Tea"]["lineCount"], 2)
        self.assertEqual(rollup["Tea"]["netSalesCents"], 2400)
        self.assertEqual(rollup[""]["keyCount"], 1)
        self.assertEqual(rollup["Tea"]["channel"], "square")

    def test_review_search_runs_before_the_display_cap(self) -> None:
        sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="large-review.csv",
            channel=SalesImport.Channel.SQUARE,
        )
        sold_at = timezone.now()
        lines = []
        for index in range(201):
            is_target = index == 200
            name = "Straße" if is_target else f"Popular item {index:03d}"
            sku = "HIDDEN-201" if is_target else f"POPULAR-{index:03d}"
            net_sales_cents = 1 if is_target else 10_000 - index
            match_key = f"square:item:review-{index}"
            lines.append(
                SalesLine(
                    user=self.user,
                    sales_import=sales_import,
                    channel=SalesImport.Channel.SQUARE,
                    source_position=index + 1,
                    source_fingerprint=f"large-review-{index}",
                    external_order_id=f"large-review-order-{index}",
                    sold_at=sold_at,
                    item_name=name,
                    sku=sku,
                    group_key=match_key,
                    match_key=match_key,
                    quantity=Decimal("1"),
                    gross_cents=net_sales_cents,
                    net_sales_cents=net_sales_cents,
                )
            )
        SalesLine.objects.bulk_create(lines)

        unfiltered = menu_overview_payload(self.user, {"review"})["review"]
        self.assertEqual(unfiltered["reviewCount"], 201)
        self.assertEqual(len(unfiltered["items"]), 200)
        self.assertNotIn(
            "HIDDEN-201", {item["sku"] for item in unfiltered["items"]}
        )

        searched = menu_overview_payload(
            self.user,
            {"review"},
            review_query="STRASSE",
        )["review"]
        self.assertEqual(searched["reviewCount"], 201)
        self.assertEqual(searched["reviewMatchCount"], 1)
        self.assertEqual(
            [item["sku"] for item in searched["items"]], ["HIDDEN-201"]
        )

    # ignore by category --------------------------------------------------

    def test_ignore_by_category_ignores_only_that_category(self) -> None:
        tea = self.make_line()
        tote = self.make_line(
            sku="TOTE-01",
            item_name="Tote Bag",
            group_key=sales_group_key("TOTE-01", "Tote Bag", ""),
            external_category="Retail",
        )
        response = self.post_internal(
            "ignore-sales-category", {"channel": "square", "category": "Tea"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {"ignoredKeys": 1, "ignoredLines": 1, "skippedTracked": 0},
        )
        keys = set(
            SalesSkuIgnore.objects.filter(user=self.user).values_list(
                "match_key", flat=True
            )
        )
        self.assertEqual(keys, {tea.group_key})
        self.assertNotIn(tote.group_key, keys)

        row = SalesSkuIgnore.objects.get(user=self.user)
        self.assertEqual(row.channel, "square")
        self.assertEqual(row.sku, "TEA-01")
        self.assertEqual(row.external_name, "Tea Flight")

    def test_ignore_by_category_covers_the_uncategorized_bucket(self) -> None:
        line = self.make_line(external_category="")
        self.make_line(
            sku="TOTE-01",
            item_name="Tote Bag",
            group_key=sales_group_key("TOTE-01", "Tote Bag", ""),
            external_category="Retail",
        )
        response = self.post_internal(
            "ignore-sales-category", {"channel": "square", "category": ""}
        )
        self.assertEqual(response.json()["ignoredKeys"], 1)
        self.assertEqual(
            list(
                SalesSkuIgnore.objects.filter(user=self.user).values_list(
                    "match_key", flat=True
                )
            ),
            [line.group_key],
        )

    def test_ignore_by_category_counts_every_line_behind_a_key(self) -> None:
        self.make_line()
        self.make_line(external_order_id="second")
        response = self.post_internal(
            "ignore-sales-category", {"channel": "square", "category": "Tea"}
        )
        self.assertEqual(response.json()["ignoredKeys"], 1)
        self.assertEqual(response.json()["ignoredLines"], 2)

    def test_ignore_by_category_covers_every_named_provider_account(self) -> None:
        first = self.make_line(
            provider_account_id="shop-one.myshopify.com",
            channel=SalesImport.Channel.SHOPIFY,
            group_key="shopify:item:first",
            sku="GIFT-1",
            item_name="Gift One",
            external_category="Gift",
        )
        second = self.make_line(
            provider_account_id="shop-two.myshopify.com",
            channel=SalesImport.Channel.SHOPIFY,
            group_key="shopify:item:second",
            sku="GIFT-2",
            item_name="Gift Two",
            external_category="Gift",
        )
        untouched = self.make_line(
            provider_account_id="shop-three.myshopify.com",
            channel=SalesImport.Channel.SHOPIFY,
            group_key="shopify:item:third",
            sku="GIFT-3",
            item_name="Gift Three",
            external_category="Gift",
        )
        response = self.post_internal(
            "ignore-sales-category",
            {
                "channel": "shopify",
                "category": "Gift",
                "providerAccountIds": [
                    "shop-one.myshopify.com",
                    "shop-two.myshopify.com",
                ],
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["ignoredKeys"], 2)
        ignored = set(
            SalesSkuIgnore.objects.filter(user=self.user).values_list(
                "provider_account_id", "match_key"
            )
        )
        self.assertEqual(
            ignored,
            {
                ("shop-one.myshopify.com", first.group_key),
                ("shop-two.myshopify.com", second.group_key),
            },
        )
        self.assertNotIn(
            ("shop-three.myshopify.com", untouched.group_key), ignored
        )

    def test_ignore_by_category_never_touches_a_tracked_key(self) -> None:
        tracked = self.make_line()
        pending = self.make_line(
            sku="TEA-02",
            item_name="Tea Flight Large",
            group_key=sales_group_key("TEA-02", "Tea Flight Large", ""),
        )
        product = SalesProduct.objects.create(
            user=self.user, name="Tea Flight", normalized_name="tea flight"
        )
        SalesProductVariant.objects.create(
            user=self.user,
            product=product,
            channel="square",
            match_key=tracked.group_key,
            sku="TEA-01",
            external_name="Tea Flight",
        )
        response = self.post_internal(
            "ignore-sales-category", {"channel": "square", "category": "Tea"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {"ignoredKeys": 1, "ignoredLines": 1, "skippedTracked": 1},
        )
        self.assertEqual(
            list(
                SalesSkuIgnore.objects.filter(user=self.user).values_list(
                    "match_key", flat=True
                )
            ),
            [pending.group_key],
        )

    def test_ignore_by_category_skips_a_key_that_is_already_ignored(self) -> None:
        line = self.make_line()
        SalesSkuIgnore.objects.create(
            user=self.user,
            channel="square",
            match_key=line.group_key,
            external_name="Tea Flight",
        )
        response = self.post_internal(
            "ignore-sales-category", {"channel": "square", "category": "Tea"}
        )
        self.assertEqual(response.json()["ignoredKeys"], 0)
        self.assertEqual(SalesSkuIgnore.objects.filter(user=self.user).count(), 1)

    def test_ignore_by_category_is_scoped_to_the_caller(self) -> None:
        self.make_line(self.other_user)
        response = self.post_internal(
            "ignore-sales-category", {"channel": "square", "category": "Tea"}
        )
        self.assertEqual(response.json()["ignoredKeys"], 0)
        self.assertEqual(SalesSkuIgnore.objects.count(), 0)

    def test_ignore_by_category_ignores_only_the_named_channel(self) -> None:
        self.make_line(channel=SalesImport.Channel.SHOPIFY)
        response = self.post_internal(
            "ignore-sales-category", {"channel": "square", "category": "Tea"}
        )
        self.assertEqual(response.json()["ignoredKeys"], 0)

    def test_ignore_by_category_leaves_matched_lines_alone(self) -> None:
        product = SalesProduct.objects.create(
            user=self.user, name="Tea Flight", normalized_name="tea flight"
        )
        self.make_line(product=product)
        response = self.post_internal(
            "ignore-sales-category", {"channel": "square", "category": "Tea"}
        )
        self.assertEqual(response.json()["ignoredKeys"], 0)

    def test_ignore_by_category_rejects_bad_input(self) -> None:
        self.assertEqual(
            self.post_internal(
                "ignore-sales-category", {"channel": "clover", "category": "Tea"}
            ).status_code,
            400,
        )
        self.assertEqual(
            self.post_internal(
                "ignore-sales-category", {"channel": "square", "category": "x" * 121}
            ).status_code,
            400,
        )
        self.assertEqual(
            self.post_internal(
                "ignore-sales-category", {"channel": "square", "category": 7}
            ).status_code,
            400,
        )
        self.assertEqual(
            self.post_internal(
                "ignore-sales-category",
                {
                    "channel": "square",
                    "category": "Tea",
                    "providerAccountIds": [],
                },
            ).status_code,
            400,
        )

    def test_ignoring_a_category_empties_the_review_queue_of_it(self) -> None:
        self.make_line()
        self.assertEqual(self.review()["reviewCount"], 1)
        self.post_internal(
            "ignore-sales-category", {"channel": "square", "category": "Tea"}
        )
        self.assertEqual(self.review()["reviewCount"], 0)

    # modifier cascade ----------------------------------------------------

class InterpretationRegressionTests(TestCase):
    """Review findings: stored object identity, modifier takeover, and the
    setup-needed candidate filter."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="regression@example.com",
            name="Regression Tester",
            password="a-long-test-passphrase-2468",
        )
        self.sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="sales.csv",
            channel=SalesImport.Channel.SQUARE,
        )
        self.position = 0
        self.cookie = SalesProduct.objects.create(
            user=self.user, name="Cookie", normalized_name="cookie"
        )
        self.cheese = SalesProduct.objects.create(
            user=self.user, name="Cheese", normalized_name="cheese"
        )

    def make_line(self, **overrides) -> SalesLine:
        self.position += 1
        fields = {
            "user": self.user,
            "sales_import": self.sales_import,
            "channel": SalesImport.Channel.SQUARE,
            "source_position": self.position,
            "source_fingerprint": f"fp-line-{self.position}",
            "external_order_id": f"order-{self.position}",
            "sold_at": timezone.now(),
            "item_name": "Cookie Box",
            "group_key": sales_group_key("", "Cookie Box", ""),
            "external_object_id": "VAR_COOKIE_BOX",
            "quantity": Decimal("1"),
            "gross_cents": 1000,
            "net_sales_cents": 1000,
        }
        fields.update(overrides)
        return SalesLine.objects.create(**fields)

    def test_object_id_variant_claims_stored_pending_lines(self) -> None:
        first = self.make_line()
        second = self.make_line()
        variant = SalesProductVariant.objects.create(
            user=self.user,
            product=self.cookie,
            channel=SalesImport.Channel.SQUARE,
            match_key=item_object_match_key("square", "VAR_COOKIE_BOX"),
            external_name="Cookie Box",
            external_object_id="VAR_COOKIE_BOX",
        )
        self.assertEqual(attach_lines_to_variant(self.user, variant), 2)
        first.refresh_from_db()
        self.assertEqual(first.variant, variant)

        # A later pass over stored history resolves the same way.
        second.variant = None
        second.product = None
        second.save(update_fields=["variant", "product", "updated_at"])
        receipt = reinterpret_sales(self.user)
        self.assertEqual(receipt["parentLinesAttached"], 1)
        second.refresh_from_db()
        self.assertEqual(second.product, self.cookie)

    def test_resolution_without_suggestions_runs_no_extra_query(self) -> None:
        variants = variant_index(self.user)
        with self.assertNumQueries(0):
            for _ in range(5):
                match = resolve_item_variant(
                    self.user,
                    channel="square",
                    item_name="Cookie Box",
                    variants=variants,
                    suggest=False,
                )
                self.assertEqual(match.status, "pending")

    def test_product_variant_index_is_built_once_per_mapping(self) -> None:
        """The compatibility rung reads a derived form of the mapping, and a
        reinterpretation walks every stored line against one mapping: the form
        belongs to the mapping, not to the call."""
        SalesProductVariant.objects.create(
            user=self.user,
            product=self.cookie,
            channel=SalesImport.Channel.SQUARE,
            match_key=item_object_match_key("square", "VAR_COOKIE_LARGE"),
            external_name="Cookie Box",
            external_variant_title="Large",
            external_object_id="PROD_COOKIE",
        )
        variants = variant_index(self.user)
        with mock.patch.object(
            core,
            "product_variant_title_index",
            wraps=core.product_variant_title_index,
        ) as build:
            for _ in range(5):
                match = resolve_item_variant(
                    self.user,
                    channel="square",
                    product_external_object_id="PROD_COOKIE",
                    external_variant_title="Large",
                    variants=variants,
                )
                self.assertEqual(match.reason, "product_variant")
        self.assertEqual(
            build.call_count,
            1,
            msg=(
                "a 31k-line reinterpretation rebuilt this index once per line "
                "and spent 18.9s doing it; the mapping is frozen once built, "
                "so one pass over the variants serves every line"
            ),
        )

    def test_suggestion_indexes_stay_unbuilt_without_suggestions(self) -> None:
        """A caller that acts on "matched" alone throws every suggestion away,
        so the two suggestion-only rungs must not walk the variants for it."""
        SalesProductVariant.objects.create(
            user=self.user,
            product=self.cookie,
            channel=SalesImport.Channel.SQUARE,
            match_key=item_object_match_key("square", "VAR_COOKIE_BOX"),
            external_name="Cookie Box",
            sku="COOKIE-12",
        )
        variants = variant_index(self.user)
        with (
            mock.patch.object(
                core, "sku_variant_index", wraps=core.sku_variant_index
            ) as sku_build,
            mock.patch.object(
                core, "name_variant_index", wraps=core.name_variant_index
            ) as name_build,
        ):
            for _ in range(5):
                match = resolve_item_variant(
                    self.user,
                    channel="square",
                    sku="UNKNOWN-99",
                    item_name="Mystery Box",
                    variants=variants,
                    suggest=False,
                )
                self.assertEqual(match.status, "pending")
        self.assertEqual(
            sku_build.call_count,
            0,
            msg=(
                "a first backfill asks for matches only, and paying a full "
                "pass over every variant to compute a suggestion it discards "
                "is the whole cost this flag exists to avoid"
            ),
        )
        self.assertEqual(
            name_build.call_count,
            0,
            msg=(
                "same for the name rung: suggest=False must stop before it, "
                "not build its index and then decline to use it"
            ),
        )

    def test_sku_suggestion_still_builds_its_index_when_asked(self) -> None:
        """The counterpart to the suggest=False guard: skipping the work when
        nobody wants a suggestion must not turn into never suggesting."""
        SalesProductVariant.objects.create(
            user=self.user,
            product=self.cookie,
            channel=SalesImport.Channel.SQUARE,
            match_key=item_object_match_key("square", "VAR_COOKIE_BOX"),
            external_name="Cookie Box",
            sku="COOKIE-12",
        )
        variants = variant_index(self.user)
        with mock.patch.object(
            core, "sku_variant_index", wraps=core.sku_variant_index
        ) as sku_build:
            match = resolve_item_variant(
                self.user,
                channel="square",
                sku="COOKIE-12",
                item_name="Cookie Box",
                variants=variants,
            )
        self.assertEqual(match.status, "suggested")
        self.assertEqual(match.reason, "sku")
        self.assertEqual(
            sku_build.call_count,
            1,
            msg=(
                "an unbuilt index is only cheap because nothing needed it: a "
                "suggesting caller still gets exactly one pass, and zero here "
                "would mean the rung had been deleted rather than deferred"
            ),
        )

    def test_cached_forms_match_their_builders(self) -> None:
        """The cached forms are the same lookups the resolver used to build
        inline, so there is one definition of each, not a second that drifts."""
        SalesProductVariant.objects.create(
            user=self.user,
            product=self.cookie,
            channel=SalesImport.Channel.SQUARE,
            match_key=sales_group_key("", "Cookie Box", ""),
            external_name="Cookie Box",
            sku="COOKIE-12",
        )
        SalesProductVariant.objects.create(
            user=self.user,
            product=self.cheese,
            channel=SalesImport.Channel.SQUARE,
            match_key=item_object_match_key("square", "VAR_CHEESE_LARGE"),
            external_name="Cheese Board",
            external_variant_title="Large",
            external_object_id="PROD_CHEESE",
        )
        variants = variant_index(self.user)
        plain = dict(variants)
        self.assertEqual(variants.by_sku, core.sku_variant_index(plain))
        self.assertEqual(variants.by_name, core.name_variant_index(plain))
        self.assertEqual(
            variants.by_product_title, core.product_variant_title_index(plain)
        )
        self.assertIs(variants.by_sku, variants.by_sku)
        self.assertIs(variants.by_name, variants.by_name)
        self.assertIs(variants.by_product_title, variants.by_product_title)


class CrossPathIdentityKeyTests(TestCase):
    """External review: one external identity minted two name keys.

    The CSV path leaves the variant part of a SKU-less product empty while the
    API path fills it in (Square variation_name / Shopify variantTitle), so
    keys built on either side never met.
    """

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="crosspath@example.com",
            name="Cross Path Tester",
            password="a-long-test-passphrase-2468",
        )
        self.product = SalesProduct.objects.create(
            user=self.user, name="Gift Box", normalized_name="gift box"
        )

    def variant(self, variant: str) -> SalesProductVariant:
        return SalesProductVariant.objects.create(
            user=self.user,
            product=self.product,
            channel=SalesImport.Channel.SHOPIFY,
            match_key=sales_group_key("", "Gift Box", variant),
            external_name="Gift Box",
            external_variant_title=variant,
        )

    def resolve(self, variant: str):
        return resolve_item_variant(
            self.user,
            channel=SalesImport.Channel.SHOPIFY,
            item_name="Gift Box",
            external_variant_title=variant,
            suggest=False,
        )

    def test_csv_variant_does_not_claim_api_sale_carrying_a_variant(self) -> None:
        self.variant("")
        match = self.resolve("Large")
        self.assertEqual(match.status, "pending")
        self.assertIsNone(match.variant)

    def test_api_variant_does_not_claim_csv_sale_with_no_variant(self) -> None:
        self.variant("Large")
        match = self.resolve("")
        self.assertEqual(match.status, "pending")
        self.assertIsNone(match.variant)

    def test_exact_variant_key_still_wins(self) -> None:
        other = SalesProduct.objects.create(
            user=self.user, name="Gift Box Large", normalized_name="gift box large"
        )
        self.variant("")
        large = SalesProductVariant.objects.create(
            user=self.user,
            product=other,
            channel=SalesImport.Channel.SHOPIFY,
            match_key=sales_group_key("", "Gift Box", "Large"),
            external_name="Gift Box",
            external_variant_title="Large",
        )
        self.assertEqual(self.resolve("Large").variant, large)

    def test_two_products_under_one_name_stay_pending(self) -> None:
        other = SalesProduct.objects.create(
            user=self.user, name="Gift Box Large", normalized_name="gift box large"
        )
        self.variant("Small")
        SalesProductVariant.objects.create(
            user=self.user,
            product=other,
            channel=SalesImport.Channel.SHOPIFY,
            match_key=sales_group_key("", "Gift Box", "Large"),
            external_name="Gift Box",
            external_variant_title="Large",
        )
        # Ambiguous: the merchant must choose, nothing may auto-attach.
        self.assertEqual(self.resolve("Jumbo").status, "pending")

    def test_variant_claims_stored_lines_keyed_with_another_variant(self) -> None:
        sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="sales.csv",
            channel=SalesImport.Channel.SHOPIFY,
        )
        line = SalesLine.objects.create(
            user=self.user,
            sales_import=sales_import,
            channel=SalesImport.Channel.SHOPIFY,
            source_position=1,
            source_fingerprint="fp-cross-1",
            external_order_id="order-1",
            sold_at=timezone.now(),
            item_name="Gift Box",
            external_variant_title="Large",
            group_key=sales_group_key("", "Gift Box", "Large"),
            quantity=Decimal("1"),
            gross_cents=1000,
            net_sales_cents=1000,
        )
        variant = self.variant("")
        self.assertEqual(attach_lines_to_variant(self.user, variant), 1)
        line.refresh_from_db()
        self.assertEqual(line.variant_id, variant.id)
        self.assertEqual(line.product_id, self.product.id)


class ShopifyKitchenScopeTests(TestCase):
    """Spec tests 80, 81, 89, 90: Shopify sales run through the same
    composition engine, with kitchen scope decided by recipe links alone."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="kitchen@example.com",
            name="Kitchen Tester",
            password="a-long-test-passphrase-2468",
        )
        self.sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="shopify sync",
            channel=SalesImport.Channel.SHOPIFY,
        )
        self.position = 0
        self.cookie = SalesProduct.objects.create(
            user=self.user, name="Cookie", normalized_name="cookie"
        )
        self.gift_box = SalesProduct.objects.create(
            user=self.user, name="Gift Box", normalized_name="gift box"
        )
        # A revenue-only product: no kitchen recipe links at all.
        self.latte = SalesProduct.objects.create(
            user=self.user, name="Latte", normalized_name="latte"
        )
        self.dough = Recipe.objects.create(
            user=self.user, title="Cookie Dough", body=""
        )
        SalesProductComponent.objects.create(
            product=self.cookie, recipe=self.dough, quantity=Decimal("1")
        )
        SalesProductComponent.objects.create(
            product=self.gift_box, recipe=self.dough, quantity=Decimal("2")
        )

    # helpers -----------------------------------------------------------

    def make_variant(self, product: SalesProduct, object_id: str, **overrides):
        fields = {
            "user": self.user,
            "product": product,
            "channel": SalesImport.Channel.SHOPIFY,
            "match_key": f"shopify:item:{object_id}",
            "external_name": product.name,
            "external_object_id": object_id,
        }
        fields.update(overrides)
        return SalesProductVariant.objects.create(**fields)

    def make_line(self, variant, **overrides) -> SalesLine:
        self.position += 1
        fields = {
            "user": self.user,
            "sales_import": self.sales_import,
            "product": variant.product,
            "variant": variant,
            "channel": SalesImport.Channel.SHOPIFY,
            "source_position": self.position,
            "source_fingerprint": f"fp-shop-{self.position}",
            "external_order_id": f"#100{self.position}",
            "sold_at": timezone.now(),
            "item_name": variant.external_name,
            "group_key": variant.match_key,
            "external_object_id": variant.external_object_id,
            "quantity": Decimal("1"),
            "gross_cents": 1000,
            "net_sales_cents": 1000,
        }
        fields.update(overrides)
        return SalesLine.objects.create(**fields)

    # 80 -----------------------------------------------------------------

    def test_shopify_variant_multiplier_expands_snack_box_quantity(self) -> None:
        box = self.make_variant(
            self.cookie,
            "gid://shopify/ProductVariant/12",
            quantity_multiplier=Decimal("6"),
        )
        line = self.make_line(box, quantity=Decimal("2"))
        self.assertEqual(
            interpreted_recipe_totals(line), {self.dough.id: Decimal("12.000")}
        )
        # Revenue is untouched by the multiplier.
        self.assertEqual(line.net_sales_cents, 1000)

    # 81 -----------------------------------------------------------------

    def test_shopify_composite_product_expands_only_kitchen_recipes(self) -> None:
        gift = self.make_variant(self.gift_box, "gid://shopify/ProductVariant/21")
        tea = self.make_variant(self.latte, "gid://shopify/ProductVariant/22")
        gift_line = self.make_line(gift, quantity=Decimal("3"))
        tea_line = self.make_line(tea, quantity=Decimal("3"))
        # The gift set's tea half is tracked for revenue but links to no
        # recipe, so it creates no kitchen consumption at all.
        self.assertEqual(
            interpreted_recipe_totals(gift_line), {self.dough.id: Decimal("6.000")}
        )
        self.assertEqual(interpreted_recipe_totals(tea_line), {})

    # 89 -----------------------------------------------------------------

    def test_shopify_return_reverses_composite_kitchen_consumption(self) -> None:
        gift = self.make_variant(self.gift_box, "gid://shopify/ProductVariant/21")
        sale = self.make_line(gift, quantity=Decimal("2"))
        refund = self.make_line(
            gift,
            quantity=Decimal("-2"),
            gross_cents=-1000,
            net_sales_cents=-1000,
        )
        self.assertEqual(
            interpreted_recipe_totals(refund), {self.dough.id: Decimal("-4.000")}
        )
        net = (
            interpreted_recipe_totals(sale)[self.dough.id]
            + interpreted_recipe_totals(refund)[self.dough.id]
        )
        self.assertEqual(net, Decimal("0"))


class SuggestFlagRungTests(TestCase):
    """Every resolution rung, under `suggest=True` and `suggest=False`.

    Only two rungs may read the flag: the unique-SKU compat rung and the
    variant-insensitive name compat rung, both of which can only ever return
    "suggested". Every other rung — object id, exact match key, exact SKU,
    product + variant (exact AND compat), exact name — decides identity, so it
    must return byte-identical outcomes with suggestions switched off. A guard
    that crept one rung too far would silently stop lines attaching on the
    reinterpretation and POS sync paths, which both resolve with
    `suggest=False`.
    """

    CHANNEL = SalesImport.Channel.SHOPIFY
    ACCOUNT = "shop-1"

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="suggest-flag@example.com",
            name="Suggest Flag Tester",
            password="a-long-test-passphrase-2468",
        )

        self.object_product = self.make_product("Object Box")
        self.object_variant = self.make_variant(
            self.object_product,
            item_object_match_key(self.CHANNEL, "VAR_OBJECT"),
            external_object_id="VAR_OBJECT",
        )

        self.group_product = self.make_product("Group Box")
        self.group_key = sales_group_key("", "Group Box", "")
        self.group_variant = self.make_variant(self.group_product, self.group_key)

        self.sku_exact_product = self.make_product("Sku Exact Box")
        self.sku_exact_variant = self.make_variant(
            self.sku_exact_product,
            sales_group_key("SKU-EXACT", "Sku Exact Box", ""),
            sku="SKU-EXACT",
        )

        # Stored under its object id, so the exact `sku:` key is absent and
        # only the unique-SKU compat rung can reach it.
        self.sku_compat_product = self.make_product("Sku Compat Box")
        self.sku_compat_variant = self.make_variant(
            self.sku_compat_product,
            item_object_match_key(self.CHANNEL, "VAR_SKU_COMPAT"),
            external_object_id="VAR_SKU_COMPAT",
            sku="SKU-COMPAT",
        )

        self.pv_exact_product = self.make_product("Pv Exact Box")
        self.pv_exact_variant = self.make_variant(
            self.pv_exact_product,
            product_variant_match_key(self.CHANNEL, "PROD_EXACT", "Large"),
            product_external_object_id="PROD_EXACT",
            external_variant_title="Large",
        )

        # An approval saved before product fallback ids had their own key:
        # the identity lives in the columns, and the stored key is an
        # unrelated name key that no line in this fixture builds.
        self.pv_compat_product = self.make_product("Pv Compat Box")
        self.pv_compat_variant = self.make_variant(
            self.pv_compat_product,
            sales_group_key("", "Legacy Pv Compat", "Large"),
            external_name="Legacy Pv Compat",
            external_object_id="PROD_COMPAT",
            external_variant_title="Large",
        )

        self.name_exact_product = self.make_product("Name Exact Box")
        self.name_exact_variant = self.make_variant(
            self.name_exact_product,
            sales_group_key("", "Name Exact Box", "Regular"),
            external_variant_title="Regular",
        )

        # Only the title-insensitive compat rung joins a line carrying no
        # variant title to a variant stored with one.
        self.name_compat_product = self.make_product("Name Compat Box")
        self.name_compat_variant = self.make_variant(
            self.name_compat_product,
            sales_group_key("", "Name Compat Box", "Large"),
            external_variant_title="Large",
        )

        # No variant at all: reachable only through canonical suggestion.
        self.canonical_product = self.make_product("Tea & Cake", "tea & cake")

        self.rungs = {
            "object_id": {
                "external_object_id": "VAR_OBJECT",
                "item_name": "Object Box",
            },
            "match_key": {"group_key": self.group_key, "item_name": "Group Box"},
            "sku_exact": {"sku": "SKU-EXACT", "item_name": "Sku Exact Box"},
            "sku_compat": {"sku": "SKU-COMPAT", "item_name": "Sku Compat Box"},
            "product_variant_exact": {
                "product_external_object_id": "PROD_EXACT",
                "external_variant_title": "Large",
                "item_name": "Pv Exact Box",
            },
            "product_variant_compat": {
                "product_external_object_id": "PROD_COMPAT",
                "external_variant_title": "Large",
                "item_name": "Pv Compat Box",
            },
            "name_exact": {"item_name": "Name Exact Box", "external_variant_title": "Regular"},
            "name_compat": {"item_name": "Name Compat Box"},
            "canonical": {"item_name": "Tea and Cake"},
        }

    # helpers -----------------------------------------------------------

    def make_product(self, name: str, normalized: str | None = None) -> SalesProduct:
        return SalesProduct.objects.create(
            user=self.user,
            name=name,
            normalized_name=normalized if normalized is not None else name.casefold(),
        )

    def make_variant(
        self, product: SalesProduct, match_key: str, **overrides
    ) -> SalesProductVariant:
        fields = {
            "user": self.user,
            "product": product,
            "channel": self.CHANNEL,
            "provider_account_id": self.ACCOUNT,
            "match_key": match_key,
            "external_name": product.name,
        }
        fields.update(overrides)
        return SalesProductVariant.objects.create(**fields)

    def resolve(self, *, suggest: bool = True, variants=None, **line):
        return resolve_item_variant(
            self.user,
            channel=self.CHANNEL,
            provider_account_id=self.ACCOUNT,
            variants=variants,
            suggest=suggest,
            **line,
        )

    def outcome(self, match) -> tuple:
        """The whole decision, so a failure prints the whole picture."""
        return (
            match.status,
            match.reason,
            match.variant.id if match.variant else None,
            match.product.id if match.product else None,
        )

    # the cross-product --------------------------------------------------

    def test_every_rung_under_both_suggest_flags(self) -> None:
        """The full rung x flag grid, asserted as whole outcome tuples."""
        pending = ("pending", None, None, None)

        def matched(reason: str, variant, product) -> tuple:
            return ("matched", reason, variant.id, product.id)

        unchanged = {
            "object_id": matched(
                "object_id", self.object_variant, self.object_product
            ),
            "match_key": matched(
                "match_key", self.group_variant, self.group_product
            ),
            "sku_exact": matched(
                "sku", self.sku_exact_variant, self.sku_exact_product
            ),
            "product_variant_exact": matched(
                "product_variant", self.pv_exact_variant, self.pv_exact_product
            ),
            "product_variant_compat": matched(
                "product_variant", self.pv_compat_variant, self.pv_compat_product
            ),
            "name_exact": matched(
                "name", self.name_exact_variant, self.name_exact_product
            ),
        }
        expectations = {
            rung: {True: outcome, False: outcome}
            for rung, outcome in unchanged.items()
        }
        expectations["sku_compat"] = {
            True: ("suggested", "sku", None, self.sku_compat_product.id),
            False: pending,
        }
        expectations["name_compat"] = {
            True: ("suggested", "name", None, self.name_compat_product.id),
            False: pending,
        }
        expectations["canonical"] = {
            True: ("suggested", "canonical", None, self.canonical_product.id),
            False: pending,
        }

        for rung, line in self.rungs.items():
            for suggest in (True, False):
                with self.subTest(rung=rung, suggest=suggest):
                    match = self.resolve(suggest=suggest, **line)
                    self.assertEqual(
                        self.outcome(match), expectations[rung][suggest]
                    )

    # the rung with no other coverage ------------------------------------

    def test_product_and_variant_compat_matches_without_suggestions(self) -> None:
        """The rung an over-eager `if suggest:` guard would silently kill.

        A variant approved before product fallback ids had their own key
        carries the identity only in `external_object_id` + `external_variant_title`,
        so the compat index is the only way to reach it. It returns "matched",
        not "suggested", and both callers that resolve stored history —
        `reinterpret_sales` and the POS sync path — pass `suggest=False`. Guard
        this rung and every Shopify line carrying a product id and a variant
        title stops attaching, with nothing in the review queue to explain it.
        """
        line = self.rungs["product_variant_compat"]
        expected = (
            "matched",
            "product_variant",
            self.pv_compat_variant.id,
            self.pv_compat_product.id,
        )
        self.assertEqual(self.outcome(self.resolve(suggest=True, **line)), expected)
        self.assertEqual(self.outcome(self.resolve(suggest=False, **line)), expected)

        # It really is the compat rung: no line builds the stored key, and the
        # exact fallback key was never written.
        self.assertNotIn(
            product_variant_match_key(self.CHANNEL, "PROD_COMPAT", "Large"),
            {row.match_key for row in SalesProductVariant.objects.all()},
        )

    def test_product_variant_compat_needs_the_same_provider_account(self) -> None:
        """The compat index is scoped, not a global product-id lookup."""
        match = resolve_item_variant(
            self.user,
            channel=self.CHANNEL,
            provider_account_id="another-shop",
            product_external_object_id="PROD_COMPAT",
            external_variant_title="Large",
            item_name="Pv Compat Box",
            suggest=False,
        )
        self.assertEqual(self.outcome(match), ("pending", None, None, None))

    # index reuse --------------------------------------------------------

    def test_shared_variant_index_resolves_like_a_fresh_one(self) -> None:
        """One `VariantIndex` now serves many calls, so it must stay pure.

        The derived compat lookups are cached on the mapping and shared across
        every line of a reinterpretation. If resolving one line could grow or
        reorder a cached lookup — a `defaultdict` miss inserting a key, say —
        the second line would resolve differently from the first. Each compat
        rung is therefore resolved twice: once behind an earlier line through
        one shared index, and once alone through a fresh index.
        """
        pairs = [
            ("sku_compat", "sku_exact"),
            ("product_variant_compat", "product_variant_exact"),
            ("name_compat", "name_exact"),
        ]
        for target, first in pairs:
            for suggest in (True, False):
                with self.subTest(rung=target, after=first, suggest=suggest):
                    shared = variant_index(self.user)
                    self.resolve(
                        suggest=suggest, variants=shared, **self.rungs[first]
                    )
                    reused = self.resolve(
                        suggest=suggest, variants=shared, **self.rungs[target]
                    )
                    fresh = self.resolve(
                        suggest=suggest,
                        variants=variant_index(self.user),
                        **self.rungs[target],
                    )
                    self.assertEqual(self.outcome(reused), self.outcome(fresh))


class BundleInterpretationTests(TestCase):
    """The same line, read as sold and read including what is inside it."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="bundle-interpretation@example.com", password="test-password"
        )
        self.sales_import = SalesImport.objects.create(
            user=self.user, file_name="sales.csv", channel="square"
        )
        self.lotus = self.product("Lotus")
        self.bean = self.product("Bean")
        self.box = self.product("Mooncake box")
        self.contains(self.box, {self.lotus: 3, self.bean: 1})

    def product(self, name: str) -> SalesProduct:
        return SalesProduct.objects.create(
            user=self.user, name=name, normalized_name=name.casefold()
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

    def variant(self, product, *, key, identity="item", multiplier="1"):
        return SalesProductVariant.objects.create(
            user=self.user,
            product=product,
            channel="square",
            match_key=key,
            external_name=key,
            identity_kind=identity,
            quantity_multiplier=Decimal(multiplier),
        )

    def line(self, variant, *, net=1000, quantity="1"):
        return SalesLine.objects.create(
            user=self.user,
            sales_import=self.sales_import,
            product=variant.product,
            variant=variant,
            channel="square",
            source_position=1,
            source_fingerprint="bundle-line",
            external_order_id="1",
            sold_at=timezone.now(),
            item_name="Mooncake box",
            quantity=Decimal(quantity),
            gross_cents=net,
            net_sales_cents=net,
        )

    def test_as_sold_and_expanded_read_the_same_line_two_ways(self) -> None:
        line = self.line(self.variant(self.box, key="square:item:BOX"))

        as_sold = core.interpret_line(line)
        expanded = core.interpret_line(line, index=BundleIndex.for_user(self.user))

        self.assertEqual(
            [(row.product.name, row.quantity, row.net_sales_cents) for row in as_sold],
            [("Mooncake box", Decimal("1"), 1000)],
        )
        self.assertEqual(expanded[0].product.name, "Mooncake box")
        self.assertEqual(expanded[0].net_sales_cents, 0)
        self.assertEqual(
            sorted(
                (row.product.name, row.quantity, row.net_sales_cents)
                for row in expanded[1:]
            ),
            [("Bean", Decimal("1"), 250), ("Lotus", Decimal("3"), 750)],
        )
        self.assertEqual([row.via_bundle for row in expanded], [False, True, True])
        self.assertEqual([row.depth for row in expanded], [0, 1, 1])
        self.assertEqual(
            sum(row.net_sales_cents for row in expanded),
            sum(row.net_sales_cents for row in as_sold),
            "expanding a box must not create or lose money",
        )

    def test_asking_for_expansion_without_an_index_stays_as_sold(self) -> None:
        """Every caller that has no index gets the immutable view, not a guess."""
        line = self.line(self.variant(self.box, key="square:item:BOX"))

        self.assertEqual(len(core.interpret_line(line, expand_bundles=True)), 1)

    def test_a_modifier_pointing_at_a_bundle_expands_units_and_no_money(self) -> None:
        parent = self.variant(self.product("Coffee"), key="square:item:COFFEE")
        line = self.line(parent)
        SalesLineModifier.objects.create(
            user=self.user,
            sales_line=line,
            variant=self.variant(
                self.box, key="square:modifier:BOX", identity="modifier"
            ),
            source_fingerprint="modifier-box",
            name="Box",
            quantity=Decimal("2"),
        )

        rows = {
            row.product.name: row
            for row in core.interpret_line(line, index=BundleIndex.for_user(self.user))
        }

        self.assertEqual(rows["Mooncake box"].quantity, Decimal("2"))
        self.assertEqual(rows["Lotus"].quantity, Decimal("6"))
        self.assertEqual(rows["Bean"].quantity, Decimal("2"))
        self.assertEqual(rows["Lotus"].net_sales_cents, 0)
        self.assertEqual(rows["Coffee"].net_sales_cents, 1000)

    def test_a_bundle_variants_multiplier_multiplies_everything_inside(self) -> None:
        line = self.line(
            self.variant(self.box, key="square:item:BOX", multiplier="2"), quantity="3"
        )

        rows = {
            row.product.name: row
            for row in core.interpret_line(line, index=BundleIndex.for_user(self.user))
        }

        self.assertEqual(rows["Mooncake box"].quantity, Decimal("6"))
        self.assertEqual(rows["Lotus"].quantity, Decimal("18"))
        self.assertEqual(rows["Bean"].quantity, Decimal("6"))

    def test_a_box_that_contains_itself_stops_rather_than_spins(self) -> None:
        """Writes refuse cycles; a row written around them must still terminate."""
        SalesProductComponent.objects.create(
            product=self.lotus,
            component_product=self.box,
            quantity=Decimal("1"),
            unit="",
            position=0,
        )
        line = self.line(self.variant(self.box, key="square:item:BOX"))

        rows = core.interpret_line(line, index=BundleIndex.for_user(self.user))

        self.assertEqual(
            sum(row.net_sales_cents for row in rows),
            1000,
            "a cycle must not lose the line's money either",
        )
