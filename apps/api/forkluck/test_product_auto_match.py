"""The predicate behind mirroring SKU decisions across channels.

Syncing never invents products: everything lands in review until a person
tracks it. What mirroring adds is that one tracked SKU covers both channels —
and a wrong mirror merges two products' revenue into one, which is harder to
notice and harder to undo than an unlinked row. So most of what follows is
refusals: each case is one way a SKU can look like a match without being one.
"""

from decimal import Decimal
from unittest import mock

from django.test import TestCase
from django.utils import timezone

from .domains.sales import core
from .domains.sales.auto_match import (
    mirror_existing_links,
    mirror_pending,
    withdraw_auto_matches,
)
from .domains.sales.core import (
    action_save_sales_product,
    action_update_sales_variant_multiplier,
    apply_sku_ignores,
)
from .domains.sales.pos_sync import sync_connection, sync_product_catalog
from .integrations.token_crypto import encrypt_token
from .models import (
    BenchCostSettings,
    SalesCatalogItem,
    SalesChannelConnection,
    SalesProductVariant,
    SalesImport,
    SalesLine,
    SalesProductComponent,
    SalesProduct,
    SalesSkuIgnore,
    User,
)


class AutoMatchTestCase(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="match@example.com",
            name="Matcher",
            password="a-long-test-passphrase-2468",
        )
        self.connect("shopify", "shop-1")
        self.connect("square", "M1")

    def connect(self, provider: str, account: str, status=None, synced=True) -> None:
        SalesChannelConnection.objects.create(
            user=self.user,
            provider=provider,
            provider_account_id=account,
            status=status or SalesChannelConnection.Status.ACTIVE,
            product_catalog_synced_at=timezone.now() if synced else None,
        )

    def catalog(self, channel: str, account: str, sku: str, name="Linzer cookie"):
        return SalesCatalogItem.objects.create(
            user=self.user,
            channel=channel,
            provider_account_id=account,
            match_key=f"{channel}:item:{account}:{sku}:{name}",
            sku=sku,
            item_name=name,
            external_variant_title="",
            external_object_id=f"ext-{channel}-{account}-{sku}-{name}",
            is_active=True,
            last_seen_at=timezone.now(),
        )

    def sales_import(self, channel: str, account: str) -> SalesImport:
        return SalesImport.objects.create(
            user=self.user,
            channel=channel,
            provider_account_id=account,
            file_name="sales.csv",
            timezone="UTC",
        )

    def line(self, channel: str, account: str, sku: str, name="Linzer cookie", **kw):
        return SalesLine.objects.create(
            user=self.user,
            sales_import=kw.pop("sales_import", None) or self.sales_import(channel, account),
            channel=channel,
            provider_account_id=account,
            match_key=kw.pop("match_key", f"{channel}:sku:{sku.lower()}"),
            sku=sku,
            item_name=name,
            external_variant_title="",
            source_position=kw.pop("position", 0),
            source_fingerprint=kw.pop("fingerprint", f"{channel}-{sku}-{name}"),
            external_order_id="1",
            sold_at=timezone.now(),
            group_key=f"sku:{sku.lower()}",
            quantity=Decimal("1"),
            gross_cents=500,
            net_sales_cents=500,
            **kw,
        )

    def track(
        self,
        channel: str,
        account: str,
        sku: str,
        *,
        name="Linzer cookie",
        multiplier=1,
        product_id=None,
        attribution=None,
    ):
        """Track one identity through the real save action, like the dialog."""
        return action_save_sales_product(
            self.user,
            {
                "id": product_id,
                "name": name,
                "isActive": True,
                "recipeLinks": [],
                "variants": [
                    {
                        "channel": channel,
                        "providerAccountId": account,
                        "matchKey": f"{channel}:item:{account}:{sku}:{name}",
                        "sku": sku,
                        "externalName": name,
                        "quantityMultiplier": multiplier,
                        "attributionPercent": attribution,
                    }
                ],
            },
        )

    def mirrored(self):
        return SalesProductVariant.objects.filter(
            user=self.user, link_source=SalesProductVariant.LinkSource.AUTO_SKU
        )


class TrackingMirrorsTheDecision(AutoMatchTestCase):
    def test_tracking_one_side_links_the_other(self) -> None:
        self.catalog("square", "M1", "LZ-100")

        self.track("shopify", "shop-1", "LZ-100")

        product = SalesProduct.objects.get(user=self.user)
        self.assertEqual(product.link_source, "manual")
        variants = SalesProductVariant.objects.filter(user=self.user)
        self.assertEqual(variants.count(), 2)
        self.assertEqual({row.channel for row in variants}, {"shopify", "square"})
        mirror = variants.get(channel="square")
        self.assertEqual(mirror.product_id, product.id)
        self.assertEqual(mirror.link_source, SalesProductVariant.LinkSource.AUTO_SKU)

    def test_the_mirror_carries_the_multiplier(self) -> None:
        # "SKU 201202 is one product with 6 items" is one decision, applied to
        # both catalogs.
        self.catalog("square", "M1", "PK-6")

        self.track("shopify", "shop-1", "PK-6", multiplier=6)

        mirror = self.mirrored().get()
        self.assertEqual(mirror.quantity_multiplier, Decimal("6"))

    def test_the_mirror_carries_attribution(self) -> None:
        # "Half of SKU TB-1 is someone else's tea" is the same one decision,
        # so the mirror must not quietly claim the whole sale instead.
        self.catalog("square", "M1", "TB-1")

        self.track(
            "shopify",
            "shop-1",
            "TB-1",
            multiplier=6,
            attribution=50,
        )

        self.assertEqual(self.mirrored().get().attribution_percent, 50)

    def test_case_and_surrounding_space_do_not_split_a_pair(self) -> None:
        self.catalog("square", "M1", "LZ-100")

        self.track("shopify", "shop-1", "  lz-100 ")

        self.assertEqual(self.mirrored().count(), 1)

    def test_an_item_both_sold_and_in_the_catalog_mirrors_once(self) -> None:
        # The normal API-sync case: the same identity arrives as a sold line
        # and as a catalog row, deriving the same match_key. Counted twice it
        # would look like two identities and refuse its own mirror.
        shared = "square:item:LZ-100"
        self.line("square", "M1", "LZ-100", match_key=shared)
        SalesCatalogItem.objects.create(
            user=self.user,
            channel="square",
            provider_account_id="M1",
            match_key=shared,
            sku="LZ-100",
            item_name="Linzer cookie",
            external_variant_title="",
            external_object_id="ext-square-LZ-100",
            is_active=True,
            last_seen_at=timezone.now(),
        )

        self.track("shopify", "shop-1", "LZ-100")

        self.assertEqual(self.mirrored().count(), 1)

    def test_a_sold_only_identity_receives_the_mirror(self) -> None:
        self.line("square", "M1", "LZ-100")

        self.track("shopify", "shop-1", "LZ-100")

        self.assertEqual(self.mirrored().count(), 1)

    def test_the_mirror_attaches_the_pending_sales_history(self) -> None:
        line = self.line("square", "M1", "LZ-100")

        self.track("shopify", "shop-1", "LZ-100")

        line.refresh_from_db()
        self.assertIsNotNone(line.variant_id)

    def test_mirroring_again_links_nothing_further(self) -> None:
        self.catalog("square", "M1", "LZ-100")

        self.track("shopify", "shop-1", "LZ-100")

        self.assertEqual(mirror_existing_links(self.user), 0)
        self.assertEqual(SalesProduct.objects.filter(user=self.user).count(), 1)
        self.assertEqual(
            SalesProductVariant.objects.filter(user=self.user).count(), 2
        )

    def test_tracking_never_creates_a_second_product(self) -> None:
        # The whole point of the rework: only the merchant makes products, one
        # per save, and the mirror joins it instead of inventing another.
        self.catalog("square", "M1", "LZ-100")

        self.track("shopify", "shop-1", "LZ-100")

        self.assertEqual(SalesProduct.objects.filter(user=self.user).count(), 1)


class SkuKeyedLeftoversRideAlong(AutoMatchTestCase):
    """A `sku:` match_key is history minted before the object ID was known,
    not a rival item — it must neither veto a mirror nor be stranded by one."""

    def test_a_sku_keyed_leftover_does_not_block_the_mirror(self) -> None:
        self.catalog("shopify", "shop-1", "LZ-100")
        leftover = self.line(
            "shopify", "shop-1", "LZ-100", match_key="sku:lz-100"
        )

        self.track("square", "M1", "LZ-100")

        mirror = self.mirrored().get()
        self.assertEqual(mirror.channel, "shopify")
        leftover.refresh_from_db()
        self.assertEqual(leftover.variant_id, mirror.id)

    def test_every_real_identity_links_and_the_leftover_attaches(self) -> None:
        self.catalog("shopify", "shop-1", "LZ-100", name="Linzer")
        self.catalog("shopify", "shop-1", "LZ-100", name="Linzer large")
        leftover = self.line("shopify", "shop-1", "LZ-100", match_key="sku:lz-100")

        self.track("square", "M1", "LZ-100")

        self.assertEqual(self.mirrored().count(), 2)
        leftover.refresh_from_db()
        self.assertIsNotNone(leftover.variant_id)

    def test_a_leftover_whose_lines_disagree_cannot_be_linked_directly(self) -> None:
        # The disagreeing leftover is never a link target itself, but it does
        # not veto the real holder either.
        real = self.catalog("shopify", "shop-1", "LZ-100")
        shared = self.sales_import("shopify", "shop-1")
        self.line(
            "shopify", "shop-1", "LZ-100", match_key="sku:lz-100",
            sales_import=shared, position=0, fingerprint="a",
        )
        self.line(
            "shopify", "shop-1", "LZ-200", match_key="sku:lz-100",
            sales_import=shared, position=1, fingerprint="b",
        )

        self.track("square", "M1", "LZ-100")

        self.assertEqual(self.mirrored().get().match_key, real.match_key)

    def test_tracking_directly_claims_the_leftover_lines(self) -> None:
        leftover = self.line(
            "shopify", "shop-1", "LZ-100", match_key="sku:lz-100"
        )

        self.track("shopify", "shop-1", "LZ-100")

        leftover.refresh_from_db()
        self.assertIsNotNone(leftover.variant_id)

    def test_leftovers_stay_free_when_two_variants_share_the_sku(self) -> None:
        other = SalesProduct.objects.create(
            user=self.user, name="Rival", normalized_name="rival"
        )
        SalesProductVariant.objects.create(
            user=self.user,
            product=other,
            channel="shopify",
            provider_account_id="shop-1",
            match_key="shopify:item:RIVAL",
            sku="LZ-100",
            external_name="Rival",
        )
        leftover = self.line(
            "shopify", "shop-1", "LZ-100", match_key="sku:lz-100"
        )

        self.track("shopify", "shop-1", "LZ-100")

        leftover.refresh_from_db()
        self.assertIsNone(leftover.variant_id)


class AmbiguousMirrorsAreRefused(AutoMatchTestCase):
    def test_a_sku_absent_on_the_other_channel_is_not_mirrored(self) -> None:
        self.track("shopify", "shop-1", "LZ-100")

        self.assertEqual(self.mirrored().count(), 0)

    def test_a_blank_sku_is_never_a_match(self) -> None:
        self.catalog("square", "M1", "", name="Mystery box")

        self.track("shopify", "shop-1", "", name="Mystery box")

        self.assertEqual(self.mirrored().count(), 0)

    def test_a_sku_duplicated_on_the_other_channel_links_every_holder(self) -> None:
        # Providers allow one SKU on several items; the merchant's decision
        # names the SKU, so every holder inherits it.
        self.catalog("square", "M1", "LZ-100", name="Linzer")
        self.catalog("square", "M1", "LZ-100", name="Linzer large")

        self.track("shopify", "shop-1", "LZ-100")

        mirrors = self.mirrored()
        self.assertEqual(mirrors.count(), 2)
        self.assertEqual(
            {variant.product_id for variant in mirrors},
            {SalesProduct.objects.get(user=self.user).id},
        )

    def test_a_same_channel_duplicate_inherits_the_decision(self) -> None:
        # Two Shopify items carry the SKU; tracking one as x10 covers the
        # other too — the merchant never tags the same SKU twice.
        self.catalog("shopify", "shop-1", "AB-10", name="Almond second")

        self.track("shopify", "shop-1", "AB-10", multiplier=10)

        mirror = self.mirrored().get()
        self.assertEqual(mirror.channel, "shopify")
        self.assertEqual(mirror.quantity_multiplier, Decimal("10"))

    def test_a_row_on_an_unconnected_account_is_refused(self) -> None:
        # A workspace holds one connection per channel
        # (`sales_connection_user_provider_unique`), so a second account on the
        # same channel can never be active and its rows never qualify. That is
        # what makes "globally unique per channel" reachable at all.
        self.catalog("square", "M2", "LZ-100")

        self.track("shopify", "shop-1", "LZ-100")

        self.assertEqual(self.mirrored().count(), 0)

    def test_punctuation_and_leading_zeros_are_not_near_matched(self) -> None:
        self.catalog("square", "M1", "sku001")

        self.track("shopify", "shop-1", "SKU-001")

        self.assertEqual(self.mirrored().count(), 0)

    def test_an_identity_whose_lines_disagree_on_sku_is_refused(self) -> None:
        # Both lines share a match_key, so an aggregate would pick one SKU.
        shared = "square:item:BUNDLE"
        first = self.sales_import("square", "M1")
        self.line(
            "square", "M1", "LZ-100", match_key=shared, sales_import=first,
            position=0, fingerprint="a",
        )
        self.line(
            "square", "M1", "LZ-200", match_key=shared, sales_import=first,
            position=1, fingerprint="b",
        )

        self.track("shopify", "shop-1", "LZ-100")

        self.assertEqual(self.mirrored().count(), 0)

    def test_a_conflicted_identity_sits_out_without_blocking_the_rest(self) -> None:
        # The identity whose records disagree cannot be linked on a SKU it
        # only half-claims, but the unambiguous holder still inherits.
        shared = "square:item:BUNDLE"
        first = self.sales_import("square", "M1")
        self.line(
            "square", "M1", "LZ-100", match_key=shared, sales_import=first,
            position=0, fingerprint="a",
        )
        self.line(
            "square", "M1", "LZ-200", match_key=shared, sales_import=first,
            position=1, fingerprint="b",
        )
        clean = self.catalog("square", "M1", "LZ-100", name="Linzer second")

        self.track("shopify", "shop-1", "LZ-100")

        mirror = self.mirrored().get()
        self.assertEqual(mirror.match_key, clean.match_key)

    def test_an_ignored_identity_is_never_mirrored(self) -> None:
        item = self.catalog("square", "M1", "LZ-100")
        SalesSkuIgnore.objects.create(
            user=self.user,
            channel=item.channel,
            provider_account_id=item.provider_account_id,
            match_key=item.match_key,
            sku=item.sku,
            external_name=item.item_name,
        )

        self.track("shopify", "shop-1", "LZ-100")

        self.assertEqual(self.mirrored().count(), 0)

    def test_an_ignored_holder_sits_out_without_blocking_the_rest(self) -> None:
        # Two Square items share SKU X and one is ignored: the ignored one
        # keeps its verdict, the other still inherits the decision.
        ignored_item = self.catalog("square", "M1", "LZ-100", name="Linzer old")
        kept = self.catalog("square", "M1", "LZ-100", name="Linzer new")
        SalesSkuIgnore.objects.create(
            user=self.user,
            channel=ignored_item.channel,
            provider_account_id=ignored_item.provider_account_id,
            match_key=ignored_item.match_key,
            sku=ignored_item.sku,
            external_name=ignored_item.item_name,
        )

        self.track("shopify", "shop-1", "LZ-100")

        mirror = self.mirrored().get()
        self.assertEqual(mirror.match_key, kept.match_key)

    def test_a_connection_needing_reconnect_is_never_mirrored(self) -> None:
        SalesChannelConnection.objects.filter(
            user=self.user, provider="square"
        ).update(status=SalesChannelConnection.Status.NEEDS_RECONNECT)
        self.catalog("square", "M1", "LZ-900")

        self.track("shopify", "shop-1", "LZ-900")

        self.assertEqual(self.mirrored().count(), 0)

    def test_a_sku_already_claimed_by_another_product_is_refused(self) -> None:
        other = SalesProduct.objects.create(
            user=self.user, name="Linzer", normalized_name="linzer"
        )
        SalesProductVariant.objects.create(
            user=self.user,
            product=other,
            channel="square",
            provider_account_id="M1",
            match_key="square:item:OTHER",
            sku="LZ-100",
            external_name="Linzer",
        )
        self.catalog("square", "M1", "LZ-100", name="Second linzer")

        self.track("shopify", "shop-1", "LZ-100")

        self.assertEqual(self.mirrored().count(), 0)

    def test_an_already_linked_identity_is_not_relinked(self) -> None:
        item = self.catalog("square", "M1", "LZ-100")
        other = SalesProduct.objects.create(
            user=self.user, name="Linzer", normalized_name="linzer"
        )
        SalesProductVariant.objects.create(
            user=self.user,
            product=other,
            channel=item.channel,
            provider_account_id=item.provider_account_id,
            match_key=item.match_key,
            sku="",
            external_name=item.item_name,
        )

        self.track("shopify", "shop-1", "LZ-100")

        self.assertEqual(self.mirrored().count(), 0)

    def test_a_sku_carried_by_a_linked_catalog_row_is_claimed(self) -> None:
        # The identity was linked before the provider assigned this SKU, so its
        # variant carries none and it has no sale under the new SKU. Skipping
        # its catalog row would make the SKU look free and let a second
        # identity take the mirror — merging two products' revenue.
        other = SalesProduct.objects.create(
            user=self.user, name="Linzer", normalized_name="linzer"
        )
        linked = self.catalog("square", "M1", "LZ-100", name="Linzer original")
        SalesProductVariant.objects.create(
            user=self.user,
            product=other,
            channel=linked.channel,
            provider_account_id=linked.provider_account_id,
            match_key=linked.match_key,
            sku="",
            external_name=linked.item_name,
        )
        self.catalog("square", "M1", "LZ-100", name="Linzer second")

        self.track("shopify", "shop-1", "LZ-100")

        self.assertEqual(self.mirrored().count(), 0)

    def test_an_item_without_a_name_is_refused(self) -> None:
        self.catalog("square", "M1", "LZ-100", name="   ")

        self.track("shopify", "shop-1", "LZ-100")

        self.assertEqual(self.mirrored().count(), 0)

    def test_another_workspace_is_never_a_candidate(self) -> None:
        other = User.objects.create_user(
            email="other@example.com",
            name="Other",
            password="a-long-test-passphrase-2468",
        )
        SalesChannelConnection.objects.create(
            user=other,
            provider="square",
            provider_account_id="M9",
            status=SalesChannelConnection.Status.ACTIVE,
        )
        SalesCatalogItem.objects.create(
            user=other,
            channel="square",
            provider_account_id="M9",
            match_key="square:item:LZ-100",
            sku="LZ-100",
            item_name="Linzer cookie",
            external_object_id="ext-other",
            is_active=True,
            last_seen_at=timezone.now(),
        )

        self.track("shopify", "shop-1", "LZ-100")

        self.assertEqual(self.mirrored().count(), 0)
        self.assertEqual(SalesProductVariant.objects.filter(user=other).count(), 0)


class TheSettingGovernsMirroring(AutoMatchTestCase):
    def test_a_workspace_without_settings_is_opted_in(self) -> None:
        self.catalog("square", "M1", "LZ-100")

        self.track("shopify", "shop-1", "LZ-100")

        self.assertEqual(self.mirrored().count(), 1)

    def test_a_currency_conversion_does_not_revert_the_setting(self) -> None:
        # convert_workspace_currency rewrites BenchCostSettings with its own
        # update_fields list. Leaving this field off that list is what keeps it
        # intact; adding it there would silently revert the merchant's choice.
        BenchCostSettings.objects.create(
            user=self.user, product_auto_match_enabled=False
        )

        BenchCostSettings.objects.filter(user=self.user).update(currency_code="EUR")
        row = BenchCostSettings.objects.get(user=self.user)
        row.wage_per_hour_cents = 2600
        row.save(
            update_fields=[
                "wage_per_hour_cents",
                "measurement_system",
                "currency_code",
                "food_cost_target_bps",
                "overtime_weekly_minutes",
            ]
        )

        row.refresh_from_db()
        self.assertFalse(row.product_auto_match_enabled)

    def test_turning_it_off_stops_mirroring(self) -> None:
        BenchCostSettings.objects.create(
            user=self.user, product_auto_match_enabled=False
        )
        self.catalog("square", "M1", "LZ-100")

        self.track("shopify", "shop-1", "LZ-100")

        self.assertEqual(self.mirrored().count(), 0)
        self.assertEqual(SalesProductVariant.objects.filter(user=self.user).count(), 1)

    def test_turning_it_on_mirrors_the_existing_links(self) -> None:
        # A workspace that tracked everything single-sided before opting in is
        # not left to re-track it all just to reach the other channel.
        settings = BenchCostSettings.objects.create(
            user=self.user, product_auto_match_enabled=False
        )
        self.catalog("square", "M1", "LZ-100")
        self.track("shopify", "shop-1", "LZ-100")
        self.assertEqual(self.mirrored().count(), 0)

        settings.product_auto_match_enabled = True
        settings.save(update_fields=["product_auto_match_enabled"])

        self.assertEqual(mirror_existing_links(self.user), 1)
        self.assertEqual(self.mirrored().count(), 1)


class DeclaredSkusLinkOnArrival(AutoMatchTestCase):
    """A product's own SKU list, with units per sale, is a decision too."""

    def declare(self, *skus: tuple[str, int], variants=()) -> str:
        return action_save_sales_product(
            self.user,
            {
                "name": "Banana cookie",
                "isActive": True,
                "recipeLinks": [],
                "skus": [
                    {"sku": sku, "quantityMultiplier": multiplier}
                    for sku, multiplier in skus
                ],
                "variants": [
                    {
                        "channel": channel,
                        "providerAccountId": account,
                        "matchKey": f"{channel}:item:{account}:{sku}:Banana cookie",
                        "sku": sku,
                        "externalName": "Banana cookie",
                        "quantityMultiplier": 1,
                        "attributionPercent": None,
                    }
                    for channel, account, sku in variants
                ],
            },
        )["id"]

    def test_a_pack_sku_links_the_pending_box_as_six(self) -> None:
        box = self.catalog("square", "M1", "102201", name="Banana cookie box")

        self.declare(("102200", 1), ("102201", 6), variants=[("shopify", "shop-1", "102200")])

        mirrored = self.mirrored().get()
        self.assertEqual(mirrored.match_key, box.match_key)
        self.assertEqual(mirrored.quantity_multiplier, Decimal("6"))

    def test_a_declared_sku_links_without_any_variant(self) -> None:
        self.catalog("square", "M1", "102201", name="Banana cookie box")
        product_id = self.declare(("102200", 1), ("102201", 6))
        self.assertEqual(self.mirrored().count(), 0)

        self.assertEqual(mirror_pending(self.user), (1, 0))

        mirrored = self.mirrored().get()
        self.assertEqual(str(mirrored.product_id), product_id)
        self.assertEqual(mirrored.quantity_multiplier, Decimal("6"))
        self.assertEqual(mirror_pending(self.user), (0, 0))

    def test_a_catalog_sync_links_on_arrival(self) -> None:
        self.declare(("102200", 1), ("102201", 6))
        connection = SalesChannelConnection.objects.get(
            user=self.user, provider="square"
        )

        class Adapter:
            def product_catalog_items(self, *, deadline=None):
                return [
                    {
                        "external_object_id": "VAR6",
                        "sku": "102201",
                        "item_name": "Banana cookie box",
                        "variant_name": "",
                        "is_active": True,
                    }
                ]

        sync_product_catalog(connection, adapter=Adapter())

        self.assertEqual(self.mirrored().get().quantity_multiplier, Decimal("6"))

    def test_a_sales_sync_links_on_arrival(self) -> None:
        self.declare(("102200", 1), ("102201", 6))
        connection = SalesChannelConnection.objects.get(
            user=self.user, provider="square"
        )
        connection.access_token_encrypted = encrypt_token("tok")
        connection.merchant_id = "M1"
        connection.location_ids = ["L1"]
        connection.provider_timezone = "UTC"
        connection.currency_code = "USD"
        connection.save()
        order = {
            "id": "sqo_box",
            "closed_at": "2026-08-01T12:00:00Z",
            "updated_at": "2026-08-01T12:00:05Z",
            "location_id": "L1",
            "line_items": [
                {
                    "uid": "u1",
                    "catalog_object_id": "VAR6",
                    "quantity": "1",
                    "name": "Banana cookie box",
                    "item_type": "ITEM",
                    "gross_sales_money": {"amount": 1800, "currency": "USD"},
                    "total_money": {"amount": 1800, "currency": "USD"},
                }
            ],
        }
        with (
            mock.patch(
                "forkluck.integrations.square.search_orders_page",
                return_value=([order], None),
            ),
            mock.patch(
                "forkluck.integrations.square.list_locations",
                return_value=[{"id": "L1", "timezone": "UTC", "currency": "USD"}],
            ),
            mock.patch(
                "forkluck.integrations.square.batch_retrieve_catalog",
                return_value={
                    "VAR6": {
                        "sku": "102201",
                        "item_name": "Banana cookie box",
                        "variant_name": "",
                    }
                },
            ),
            mock.patch(
                "forkluck.integrations.square.list_catalog_items", return_value=[]
            ),
        ):
            sync_connection(connection)

        mirrored = self.mirrored().get()
        self.assertEqual(mirrored.quantity_multiplier, Decimal("6"))
        self.assertEqual(SalesLine.objects.get(user=self.user).variant_id, mirrored.id)

    def test_a_pack_sku_declared_by_another_product_is_refused(self) -> None:
        self.declare(("102200", 1), ("102201", 6))
        self.catalog("square", "M1", "102201", name="Box")

        self.track("shopify", "shop-1", "102201", name="Rival box")

        self.assertEqual(self.mirrored().count(), 0)


class WithdrawingReleasesOnlyUntouchedLinks(AutoMatchTestCase):
    def track_with_mirror(self) -> None:
        self.catalog("square", "M1", "LZ-100")
        self.track("shopify", "shop-1", "LZ-100")

    def test_withdrawing_removes_the_mirrors_but_not_the_product(self) -> None:
        self.track_with_mirror()

        self.assertEqual(withdraw_auto_matches(self.user), 1)
        remaining = SalesProductVariant.objects.filter(user=self.user)
        self.assertEqual(
            list(remaining.values_list("channel", flat=True)), ["shopify"]
        )
        # The product is the merchant's own decision; only its mirror goes.
        self.assertEqual(SalesProduct.objects.filter(user=self.user).count(), 1)

    def test_a_legacy_auto_product_is_swept_with_its_links(self) -> None:
        # Products stamped auto_sku date from when syncing invented them; once
        # nothing manual points at one, withdrawing clears it out entirely.
        product = SalesProduct.objects.create(
            user=self.user,
            name="Linzer",
            normalized_name="linzer",
            link_source="auto_sku",
        )
        for channel, account, key in (
            ("shopify", "shop-1", "shopify:item:LZ"),
            ("square", "M1", "square:item:LZ"),
        ):
            SalesProductVariant.objects.create(
                user=self.user,
                product=product,
                channel=channel,
                provider_account_id=account,
                match_key=key,
                sku="LZ-100",
                external_name="Linzer",
                link_source=SalesProductVariant.LinkSource.AUTO_SKU,
            )

        self.assertEqual(withdraw_auto_matches(self.user), 2)
        self.assertEqual(SalesProductVariant.objects.filter(user=self.user).count(), 0)
        self.assertEqual(SalesProduct.objects.filter(user=self.user).count(), 0)

    def test_withdrawing_releases_attributed_sales_history(self) -> None:
        line = self.line("square", "M1", "LZ-100")
        self.track("shopify", "shop-1", "LZ-100")
        line.refresh_from_db()
        self.assertIsNotNone(line.variant_id)

        withdraw_auto_matches(self.user)

        line.refresh_from_db()
        self.assertIsNone(line.variant_id)
        self.assertIsNone(line.product_id)

    def test_a_link_promoted_to_manual_survives_withdrawal(self) -> None:
        self.track_with_mirror()
        kept = SalesProductVariant.objects.filter(user=self.user, channel="square").get()
        kept.link_source = SalesProductVariant.LinkSource.MANUAL
        kept.save(update_fields=["link_source"])

        self.assertEqual(withdraw_auto_matches(self.user), 0)
        self.assertEqual(
            SalesProductVariant.objects.filter(user=self.user).count(), 2
        )

    def test_changing_a_multiplier_protects_that_variant(self) -> None:
        self.track_with_mirror()
        variant = SalesProductVariant.objects.get(user=self.user, channel="square")

        action_update_sales_variant_multiplier(
            self.user,
            {"variantId": str(variant.id), "quantityMultiplier": 6},
        )

        variant.refresh_from_db()
        self.assertEqual(
            variant.link_source, SalesProductVariant.LinkSource.MANUAL
        )
        withdraw_auto_matches(self.user)
        self.assertTrue(
            SalesProductVariant.objects.filter(pk=variant.pk).exists()
        )

    def test_filling_a_product_with_products_protects_that_variant(self) -> None:
        self.track_with_mirror()
        variant = SalesProductVariant.objects.get(user=self.user, channel="square")
        first = SalesProduct.objects.create(
            user=self.user, name="Half one", normalized_name="half one"
        )
        second = SalesProduct.objects.create(
            user=self.user, name="Half two", normalized_name="half two"
        )

        action_save_sales_product(
            self.user,
            {
                "id": str(variant.product_id),
                "expectedEditVersion": variant.product.edit_version,
                "components": [
                    {"productId": str(first.id), "quantity": 1, "position": 0},
                    {"productId": str(second.id), "quantity": 1, "position": 1},
                ],
                "variants": [
                    {
                        "id": str(variant.id),
                        "channel": variant.channel,
                        "providerAccountId": variant.provider_account_id,
                        "matchKey": variant.match_key,
                        "externalName": variant.external_name,
                        "quantityMultiplier": 2,
                    }
                ],
            },
        )

        variant.refresh_from_db()
        self.assertEqual(
            variant.link_source, SalesProductVariant.LinkSource.MANUAL
        )
        withdraw_auto_matches(self.user)
        self.assertTrue(SalesProductVariant.objects.filter(pk=variant.pk).exists())

    def test_a_product_used_inside_a_bundle_survives_withdrawal(self) -> None:
        # SalesProductComponent.component_product is PROTECT: sweeping a legacy
        # auto product a merchant put in a box would raise and roll back the
        # whole setting change.
        product = SalesProduct.objects.create(
            user=self.user,
            name="Linzer",
            normalized_name="linzer",
            link_source="auto_sku",
        )
        box = SalesProduct.objects.create(
            user=self.user, name="Cookie box", normalized_name="cookie box"
        )
        SalesProductComponent.objects.create(
            product=box, component_product=product, quantity=1, position=0
        )

        withdraw_auto_matches(self.user)

        self.assertTrue(SalesProduct.objects.filter(pk=product.pk).exists())
        self.assertTrue(
            SalesProductComponent.objects.filter(
                product=box, component_product=product
            ).exists()
        )

    def test_a_manual_link_is_never_withdrawn(self) -> None:
        product = SalesProduct.objects.create(
            user=self.user, name="Hand made", normalized_name="hand made"
        )
        SalesProductVariant.objects.create(
            user=self.user,
            product=product,
            channel="square",
            provider_account_id="M1",
            match_key="square:item:HAND",
            sku="HAND",
            external_name="Hand made",
        )

        self.assertEqual(withdraw_auto_matches(self.user), 0)
        self.assertEqual(SalesProductVariant.objects.filter(user=self.user).count(), 1)


class IgnoresSerializeWithMirroring(AutoMatchTestCase):
    def test_ignoring_takes_the_workspace_lock_the_mirror_holds(self) -> None:
        # SQLite cannot exercise the blocking itself; what this pins is that
        # the ignore write acquires the same lock mirror_variants holds, so
        # it either lands before mirroring reads the ignore set or after the
        # variant exists — where the tracked check refuses it.
        item = self.catalog("shopify", "shop-1", "LZ-100")
        locked = []
        original = core.lock_workspace
        with mock.patch.object(
            core,
            "lock_workspace",
            side_effect=lambda user: locked.append(user.pk) or original(user),
        ):
            apply_sku_ignores(
                self.user,
                [
                    {
                        "channel": item.channel,
                        "provider_account_id": item.provider_account_id,
                        "match_key": item.match_key,
                        "sku": item.sku,
                        "external_name": item.item_name,
                        "external_variant_title": "",
                    }
                ],
            )

        self.assertEqual(locked, [self.user.pk])
        self.assertTrue(SalesSkuIgnore.objects.filter(user=self.user).exists())


class UnrefreshedAccountsSitOut(AutoMatchTestCase):
    def test_an_account_without_a_catalog_fetch_defers_mirroring(self) -> None:
        # Disconnecting deletes the connection but not the catalog rows, so a
        # reconnected account arrives with stale is_active snapshots and no
        # product_catalog_synced_at. Those rows cannot vouch for uniqueness
        # until the account's own refresh lands.
        SalesChannelConnection.objects.filter(
            user=self.user, provider="square"
        ).update(product_catalog_synced_at=None)
        self.catalog("square", "M1", "LZ-100")

        self.track("shopify", "shop-1", "LZ-100")
        self.assertEqual(self.mirrored().count(), 0)

        SalesChannelConnection.objects.filter(
            user=self.user, provider="square"
        ).update(product_catalog_synced_at=timezone.now())
        self.assertEqual(mirror_existing_links(self.user), 1)
