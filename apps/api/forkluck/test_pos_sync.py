import json
import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from django.conf import settings
from django.core import signing
from django.db import IntegrityError
from django.http import JsonResponse
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from .integrations import pos_oauth, shopify, square
from .models import (
    SalesChannelConnection,
    SalesProductVariant,
    SalesIgnoreRule,
    SalesImport,
    SalesLine,
    SalesLineModifier,
    SalesModifierList,
    SalesModifierOption,
    SalesProduct,
    SalesSkuIgnore,
    SyncRun,
    User,
)
from .testing import InternalApiTestCase
from .integrations.pos_sync import (
    MIN_TIME_BUDGET_S,
    SyncFailed,
    SquareSalesAdapter,
    ensure_fresh_square_token,
    shopify_order_entries,
    square_order_entries,
)
from .domains.sales.pos_sync import interpret_provider_entries, sync_connection
from .domains.sales.core import base_fingerprint, interpreted_components
from .integrations.token_crypto import TokenCryptoError, decrypt_token, encrypt_token


class TokenCryptoTests(TestCase):
    def test_roundtrip(self) -> None:
        envelope = encrypt_token("sq0atp-secret")
        self.assertTrue(envelope.startswith("v1:default:"))
        self.assertEqual(decrypt_token(envelope), "sq0atp-secret")

    def test_tampered_envelope_raises(self) -> None:
        envelope = encrypt_token("secret")
        parts = envelope.split(":")
        parts[4] = parts[4][:-4] + "AAAA"
        with self.assertRaises(TokenCryptoError):
            decrypt_token(":".join(parts))

    def test_unknown_key_id_raises(self) -> None:
        envelope = encrypt_token("secret").replace("v1:default:", "v1:ghost:")
        with self.assertRaises(TokenCryptoError):
            decrypt_token(envelope)

    def test_rotation_dual_read(self) -> None:
        old_key = "bb" * 32
        with patch.dict(
            "os.environ", {"FORKLUCK_TOKEN_ENCRYPTION_KEY": old_key}
        ):
            old_envelope = encrypt_token("secret")
        # New primary key, old key still readable through the registry.
        with patch.dict(
            "os.environ",
            {
                "FORKLUCK_TOKEN_ENCRYPTION_KEY_ID": "k2",
                "FORKLUCK_TOKEN_ENCRYPTION_KEYS": json.dumps(
                    {"default": old_key}
                ),
            },
        ):
            self.assertEqual(decrypt_token(old_envelope), "secret")
            fresh = encrypt_token("secret")
            self.assertTrue(fresh.startswith("v1:k2:"))


SQUARE_APP = override_settings(
    SQUARE_APPLICATION_ID="sq-app", SQUARE_APPLICATION_SECRET="sq-secret"
)
SHOPIFY_APP = override_settings(
    SHOPIFY_API_KEY="shp-key", SHOPIFY_API_SECRET="shp-secret"
)


class PosOAuthTestCase(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="pos@example.com",
            name="POS Tester",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)

    def minted_state(self, connect_path: str) -> str:
        response = self.client.get(connect_path)
        self.assertEqual(response.status_code, 302)
        query = parse_qs(urlparse(response["Location"]).query)
        return query["state"][0]

    def shopify_params(self, extra: dict) -> dict:
        """Query params carrying a valid Shopify HMAC signature."""
        import hashlib
        import hmac as hmac_module

        message = "&".join(
            f"{key}={value}" for key, value in sorted(extra.items())
        ).encode()
        digest = hmac_module.new(
            settings.SHOPIFY_API_SECRET.encode(), message, hashlib.sha256
        ).hexdigest()
        return {**extra, "hmac": digest}


@SQUARE_APP
class SquareOAuthTests(PosOAuthTestCase):
    def test_connect_requires_login(self) -> None:
        response = Client().get("/api/integrations/square/connect")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], "/login")

    def test_denied_callback_redirects_with_error(self) -> None:
        response = self.client.get(
            "/api/integrations/square/callback", {"error": "access_denied"}
        )
        self.assertIn("integration_error=denied", response["Location"])

    def test_callback_without_session_nonce_fails(self) -> None:
        state = signing.dumps(
            {"n": "nonce", "p": "square", "s": ""}, salt="pos-oauth"
        )
        response = self.client.get(
            "/api/integrations/square/callback", {"state": state, "code": "c"}
        )
        self.assertIn("integration_error=state_expired", response["Location"])

    def test_expired_state_fails(self) -> None:
        state = self.minted_state("/api/integrations/square/connect")
        with patch.object(pos_oauth, "STATE_MAX_AGE_S", -1):
            response = self.client.get(
                "/api/integrations/square/callback",
                {"state": state, "code": "c"},
            )
        self.assertIn("integration_error=state_expired", response["Location"])

    def test_cross_provider_state_rejected(self) -> None:
        state = self.minted_state("/api/integrations/square/connect")
        with override_settings(SHOPIFY_API_KEY="shp", SHOPIFY_API_SECRET="s"):
            params = self.shopify_params(
                {"state": state, "code": "c", "shop": "x.myshopify.com"}
            )
            response = self.client.get(
                "/api/integrations/shopify/callback", params
            )
        self.assertIn("integration_error=state_expired", response["Location"])

    @patch("forkluck.integrations.square.list_locations")
    @patch("forkluck.integrations.square.exchange_code")
    def test_happy_path_creates_encrypted_connection(
        self, exchange, locations
    ) -> None:
        exchange.return_value = {
            "access_token": "tok-1",
            "refresh_token": "ref-1",
            "expires_at": "2026-09-08T00:00:00Z",
            "merchant_id": "M1",
        }
        locations.return_value = [
            {
                "id": "L1",
                "name": "Main",
                "timezone": "America/New_York",
                "currency": "USD",
            }
        ]
        state = self.minted_state("/api/integrations/square/connect")
        response = self.client.get(
            "/api/integrations/square/callback",
            {"state": state, "code": "auth-code"},
        )
        self.assertEqual(
            response["Location"], "/integrations/sales/connections?connected=square"
        )
        connection = SalesChannelConnection.objects.get(
            user=self.user, provider="square"
        )
        self.assertEqual(decrypt_token(connection.access_token_encrypted), "tok-1")
        self.assertEqual(decrypt_token(connection.refresh_token_encrypted), "ref-1")
        self.assertEqual(connection.merchant_id, "M1")
        self.assertEqual(connection.location_ids, ["L1"])
        self.assertEqual(connection.provider_timezone, "America/New_York")
        self.assertEqual(connection.status, "active")

        # Replaying the same callback must fail: the nonce was consumed.
        response = self.client.get(
            "/api/integrations/square/callback",
            {"state": state, "code": "auth-code"},
        )
        self.assertIn("integration_error=state_expired", response["Location"])

    @patch("forkluck.integrations.square.list_locations")
    @patch("forkluck.integrations.square.exchange_code")
    def test_reconnecting_other_merchant_resets_sync_state(
        self, exchange, locations
    ) -> None:
        connection = SalesChannelConnection.objects.create(
            user=self.user,
            provider="square",
            access_token_encrypted=encrypt_token("old"),
            merchant_id="M0",
            sync_watermark=timezone.now(),
            backfilled_at=timezone.now(),
        )
        product = SalesProduct.objects.create(
            user=self.user, name="Old item", normalized_name="old item"
        )
        variant = SalesProductVariant.objects.create(
            user=self.user,
            product=product,
            channel="square",
            provider_account_id="M0",
            match_key="square:item:OLD_VARIATION",
            external_object_id="OLD_VARIATION",
            external_name="Old item",
        )
        ignored = SalesSkuIgnore.objects.create(
            user=self.user,
            channel="square",
            provider_account_id="M0",
            match_key="square:item:IGNORED_VARIATION",
            external_name="Ignored item",
        )
        modifier_list = SalesModifierList.objects.create(
            user=self.user,
            channel="square",
            provider_account_id="M0",
            external_object_id="OLD_LIST",
            name="Old modifiers",
            last_synced_at=timezone.now(),
        )
        run = SyncRun.objects.create(
            user=self.user,
            connection=connection,
            connection_generation=connection.generation,
            provider="square",
            provider_account_id="M0",
        )
        exchange.return_value = {"access_token": "tok", "merchant_id": "M1"}
        locations.return_value = []
        state = self.minted_state("/api/integrations/square/connect")
        self.client.get(
            "/api/integrations/square/callback", {"state": state, "code": "c"}
        )
        connection = SalesChannelConnection.objects.get(
            user=self.user, provider="square"
        )
        self.assertEqual(connection.merchant_id, "M1")
        self.assertEqual(connection.provider_account_id, "M1")
        self.assertEqual(connection.generation, 2)
        self.assertIsNone(connection.sync_watermark)
        self.assertIsNone(connection.backfilled_at)
        run.refresh_from_db()
        self.assertEqual(run.status, SyncRun.Status.CANCELLED)
        variant.refresh_from_db()
        ignored.refresh_from_db()
        modifier_list.refresh_from_db()
        self.assertEqual(variant.provider_account_id, "M0")
        self.assertEqual(ignored.provider_account_id, "M0")
        self.assertEqual(modifier_list.provider_account_id, "M0")
        self.assertFalse(
            SalesProductVariant.objects.filter(
                user=self.user, provider_account_id="M1"
            ).exists()
        )


@SHOPIFY_APP
class ShopifyOAuthTests(PosOAuthTestCase):
    def test_bad_shop_domain_rejected(self) -> None:
        response = self.client.get(
            "/api/integrations/shopify/connect", {"shop": "evil.example.com"}
        )
        self.assertIn("integration_error=bad_shop", response["Location"])

    def test_invalid_hmac_rejected(self) -> None:
        response = self.client.get(
            "/api/integrations/shopify/callback",
            {"state": "x", "code": "c", "shop": "s.myshopify.com", "hmac": "bad"},
        )
        self.assertIn("integration_error=hmac_invalid", response["Location"])

    @patch("forkluck.integrations.shopify.fetch_shop_info")
    @patch("forkluck.integrations.shopify.exchange_code")
    def test_happy_path(self, exchange, shop_info) -> None:
        exchange.return_value = {
            "access_token": "shp-tok",
            "scope": "read_orders,read_all_orders",
        }
        shop_info.return_value = {"timezone": "America/New_York", "currency": "USD"}
        state = self.minted_state(
            "/api/integrations/shopify/connect?shop=teashop.myshopify.com"
        )
        params = self.shopify_params(
            {"state": state, "code": "c", "shop": "teashop.myshopify.com"}
        )
        response = self.client.get("/api/integrations/shopify/callback", params)
        self.assertEqual(
            response["Location"], "/integrations/sales/connections?connected=shopify"
        )
        connection = SalesChannelConnection.objects.get(
            user=self.user, provider="shopify"
        )
        self.assertEqual(connection.shop_domain, "teashop.myshopify.com")
        self.assertEqual(decrypt_token(connection.access_token_encrypted), "shp-tok")
        self.assertIn("read_all_orders", connection.scopes)

    @patch("forkluck.integrations.shopify.fetch_shop_info")
    @patch("forkluck.integrations.shopify.exchange_code")
    def test_callback_for_other_shop_rejected(self, exchange, shop_info) -> None:
        state = self.minted_state(
            "/api/integrations/shopify/connect?shop=teashop.myshopify.com"
        )
        params = self.shopify_params(
            {"state": state, "code": "c", "shop": "other.myshopify.com"}
        )
        response = self.client.get("/api/integrations/shopify/callback", params)
        self.assertIn("integration_error=bad_shop", response["Location"])
        exchange.assert_not_called()


SQUARE_ORDER = {
    "id": "sqo_1",
    "closed_at": "2026-08-01T12:00:00Z",
    "updated_at": "2026-08-01T12:00:05Z",
    "location_id": "L1",
    "source": {"name": "Register"},
    "line_items": [
        {
            "uid": "u1",
            "catalog_object_id": "VAR1",
            "quantity": "2",
            "name": "Latte",
            "variation_name": "Regular",
            "item_type": "ITEM",
            "gross_sales_money": {"amount": 800, "currency": "USD"},
            "total_discount_money": {"amount": 100},
            "total_tax_money": {"amount": 62},
            "total_money": {"amount": 762, "currency": "USD"},
        },
        {
            "uid": "u2",
            "catalog_object_id": "VAR2",
            "quantity": "1",
            "name": "Mug",
            "variation_name": "",
            "item_type": "ITEM",
            "gross_sales_money": {"amount": 1500, "currency": "USD"},
            "total_discount_money": {"amount": 0},
            "total_tax_money": {"amount": 0},
            "total_money": {"amount": 1500, "currency": "USD"},
        },
    ],
}

SQUARE_CATALOG = {
    "VAR1": {"sku": "LATTE", "item_name": "Latte", "variant_name": "Regular"},
    "VAR2": {"sku": "MUG-01", "item_name": "Mug", "variant_name": ""},
}


class SquareSyncTests(InternalApiTestCase):
    def setUp(self) -> None:
        product_catalog = patch(
            "forkluck.integrations.square.list_catalog_items", return_value=[]
        )
        product_catalog.start()
        self.addCleanup(product_catalog.stop)
        self.user = User.objects.create_user(
            email="sync@example.com",
            name="Sync Tester",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)
        self.product = SalesProduct.objects.create(
            user=self.user, name="Latte", normalized_name="latte"
        )
        self.connection = SalesChannelConnection.objects.create(
            user=self.user,
            provider="square",
            access_token_encrypted=encrypt_token("tok"),
            merchant_id="M1",
            location_ids=["L1"],
            provider_timezone="UTC",
            currency_code="USD",
        )
        self.variant = SalesProductVariant.objects.create(
            user=self.user,
            product=self.product,
            channel="square",
            provider_account_id="M1",
            match_key="square:item:VAR1",
            sku="LATTE",
            external_name="Latte",
            external_variant_title="Regular",
            external_object_id="VAR1",
        )

    def run_sync(
        self,
        orders: list[dict],
        *,
        modifier_lists: list[dict] | None = None,
        modifier_lists_error: Exception | None = None,
        time_budget_s: int | None = None,
    ):
        def fake_search(
            token, location_ids, *, field, start_at, end_at, cursor=None
        ):
            return orders, None

        modifier_patch = (
            {"side_effect": modifier_lists_error}
            if modifier_lists_error is not None
            else {"return_value": modifier_lists or []}
        )
        with (
            patch(
                "forkluck.integrations.square.search_orders_page",
                side_effect=fake_search,
            ),
            patch(
                "forkluck.integrations.square.list_locations",
                return_value=[
                    {"id": "L1", "timezone": "UTC", "currency": "USD"}
                ],
            ),
            patch(
                "forkluck.integrations.square.batch_retrieve_catalog",
                return_value=SQUARE_CATALOG,
            ),
            patch(
                "forkluck.integrations.square.list_modifier_lists",
                **modifier_patch,
            ),
        ):
            receipt = sync_connection(
                self.connection,
                time_budget_s=time_budget_s or 40,
                include_modifier_catalog=True,
            )
            response = JsonResponse(receipt)
            response.json = lambda: receipt
            return response

    def test_sync_imports_the_square_modifier_catalog(self) -> None:
        response = self.run_sync(
            [],
            modifier_lists=[
                {
                    "external_object_id": "LIST_FLIGHT",
                    "name": "Snack Flight",
                    "modifier_type": "list",
                    "selection_type": "multiple",
                    "ordinal": 1,
                    "allow_quantities": False,
                    "min_selected": 1,
                    "max_selected": 3,
                    "options": [
                        {
                            "external_object_id": "MOD_COOKIE",
                            "name": "Chocolate Cookie",
                            "ordinal": 1,
                            "price_cents": 0,
                            "currency_code": "USD",
                        }
                    ],
                }
            ],
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(
            SalesModifierList.objects.filter(
                user=self.user,
                provider_account_id="M1",
                name="Snack Flight",
                is_active=True,
            ).exists()
        )
        self.assertTrue(
            SalesModifierOption.objects.filter(
                modifier_list__user=self.user,
                external_object_id="MOD_COOKIE",
                is_active=True,
            ).exists()
        )
        self.connection.refresh_from_db()
        self.assertIsNotNone(self.connection.modifier_catalog_synced_at)

    def test_modifier_catalog_failure_keeps_the_sales_sync(self) -> None:
        # A catalog outage after the orders call must not discard a stored
        # run: the watermark has to advance so retries do not reread the
        # same orders and eventually fail the whole sync.
        response = self.run_sync(
            [SQUARE_ORDER],
            modifier_lists_error=SyncFailed("Square catalog is unavailable"),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(SalesLine.objects.filter(user=self.user).count(), 2)

        self.connection.refresh_from_db()
        self.assertIsNotNone(self.connection.sync_watermark)
        self.assertIsNotNone(self.connection.last_synced_at)
        self.assertEqual(self.connection.last_error, "")
        self.assertIsNone(self.connection.modifier_catalog_synced_at)

    def test_catalog_grant_revocation_keeps_the_sales_sync(self) -> None:
        # The adapter marks the connection NEEDS_RECONNECT before raising. The
        # run is committed first, so that status change cannot strand the
        # watermark behind orders that were already stored.
        response = self.run_sync(
            [SQUARE_ORDER],
            modifier_lists_error=square.SquareGrantRevoked("dead"),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(SalesLine.objects.filter(user=self.user).count(), 2)

        self.connection.refresh_from_db()
        self.assertIsNotNone(self.connection.sync_watermark)
        self.assertIsNotNone(self.connection.last_synced_at)
        # The merchant still learns the grant died.
        self.assertEqual(
            self.connection.status,
            SalesChannelConnection.Status.NEEDS_RECONNECT,
        )
        self.assertIn("Reconnect", self.connection.last_error)

    def test_catalog_is_skipped_when_the_orders_pass_used_the_budget(
        self,
    ) -> None:
        # One catalog page can block for the vendor timeout, and the web
        # service kills the request before many. Leave it for the next sync.
        # The same lists import fine on a full budget, one test above.
        response = self.run_sync(
            [SQUARE_ORDER],
            modifier_lists=[
                {
                    "external_object_id": "LIST_FLIGHT",
                    "name": "Snack Flight",
                    "modifier_type": "list",
                    "selection_type": "multiple",
                    "ordinal": 1,
                    "allow_quantities": False,
                    "min_selected": 1,
                    "max_selected": 3,
                    "options": [],
                }
            ],
            time_budget_s=MIN_TIME_BUDGET_S,
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(
            SalesModifierList.objects.filter(user=self.user).exists()
        )
        self.connection.refresh_from_db()
        self.assertIsNotNone(self.connection.sync_watermark)
        self.assertIsNone(self.connection.modifier_catalog_synced_at)

    def test_unmatched_lines_are_stored_as_pending(self) -> None:
        # Replaces the old "only matched SKUs are stored": sync now keeps
        # every usable line, unmatched ones land in Menu Review.
        response = self.run_sync([SQUARE_ORDER])
        self.assertEqual(response.status_code, 200)
        receipt = response.json()
        self.assertEqual(receipt["imported"], 2)
        self.assertEqual(receipt["trackedLines"], 1)
        self.assertEqual(receipt["pendingLines"], 1)
        self.assertEqual(receipt["pendingIdentities"], 1)
        self.assertEqual(receipt["skippedMalformed"], 0)
        self.assertEqual(receipt["deduplicated"], 0)
        self.assertFalse(receipt["partial"])

        line = SalesLine.objects.get(user=self.user, sku="LATTE")
        self.assertEqual(line.product_id, self.product.id)
        self.assertEqual(line.variant_id, self.variant.id)
        self.assertEqual(line.gross_cents, 800)
        self.assertEqual(line.net_sales_cents, 700)
        self.assertEqual(line.tax_cents, 62)

        pending = SalesLine.objects.get(user=self.user, sku="MUG-01")
        self.assertIsNone(pending.product_id)
        self.assertIsNone(pending.variant_id)

        sales_import = SalesImport.objects.get(id=receipt["batchId"])
        self.assertEqual(sales_import.source, "api")
        self.assertEqual(sales_import.channel, "square")
        self.assertEqual(sales_import.total_rows, 2)
        self.assertEqual(sales_import.skipped_count, 0)
        self.assertEqual(sales_import.unmapped_count, 1)

        self.connection.refresh_from_db()
        self.assertIsNotNone(self.connection.sync_watermark)
        self.assertIsNotNone(self.connection.backfilled_at)
        self.assertIsNotNone(self.connection.last_synced_at)

    def test_a_rule_moves_a_new_identity_out_of_the_receipt_pending_count(
        self,
    ) -> None:
        # The counters are taken against the pre-sync ignore set, so a rule
        # claiming a first-seen identity has to correct them. A receipt that
        # reports work waiting in a queue the row already left is worse than
        # no receipt at all.
        SalesIgnoreRule.objects.create(
            user=self.user,
            channel="square",
            conditions=[{"field": "title", "operator": "is", "value": "Mug"}],
        )

        receipt = self.run_sync([SQUARE_ORDER]).json()

        self.assertEqual(receipt["ruleIgnoredIdentities"], 1)
        self.assertEqual(receipt["pendingLines"], 0)
        self.assertEqual(receipt["pendingIdentities"], 0)
        self.assertEqual(receipt["ignoredLines"], 1)
        self.assertEqual(receipt["ignoredIdentities"], 1)
        self.assertEqual(receipt["trackedLines"], 1)
        self.assertTrue(
            SalesSkuIgnore.objects.filter(
                user=self.user, rule__isnull=False, external_name="Mug"
            ).exists()
        )

    def test_second_sync_is_idempotent(self) -> None:
        self.run_sync([SQUARE_ORDER])
        response = self.run_sync([SQUARE_ORDER])
        receipt = response.json()
        self.assertEqual(receipt["imported"], 0)
        self.assertEqual(receipt["deduplicated"], 2)
        self.assertIsNone(receipt["batchId"])
        self.assertEqual(SalesLine.objects.filter(user=self.user).count(), 2)
        # No import row for a run that stored nothing new.
        self.assertEqual(
            SalesImport.objects.filter(user=self.user, source="api").count(), 1
        )

    def test_transition_bridge_never_claims_another_known_account(self) -> None:
        other_import = SalesImport.objects.create(
            user=self.user,
            file_name="Other merchant Square API",
            source=SalesImport.Source.API,
            channel=SalesImport.Channel.SQUARE,
            provider_account_id="M0",
        )
        SalesLine.objects.create(
            user=self.user,
            sales_import=other_import,
            channel=SalesImport.Channel.SQUARE,
            provider_account_id="M0",
            source_position=1,
            source_fingerprint="other-provider-record",
            provider_record_id="shared-order:line:u1",
            external_order_id="shared-order",
            sold_at=datetime.fromisoformat("2026-08-01T12:00:00+00:00"),
            timezone="UTC",
            sku="LATTE",
            item_name="Latte",
            group_key="sku:LATTE",
            match_key="square:item:VAR1",
            external_object_id="VAR1",
            quantity=Decimal("2"),
            gross_cents=800,
            net_sales_cents=800,
            currency_code="USD",
            location="L1",
            source_payload={"orderId": "shared-order", "lineUid": "u1"},
        )
        overlap = square_order(
            [
                square_line(
                    uid="u1",
                    object_id="VAR1",
                    name="Latte",
                    quantity="2",
                    gross_cents=800,
                )
            ],
            order_id="shared-order",
            closed_at="2026-08-01T12:00:00Z",
        )

        receipt = self.run_sync([overlap]).json()

        self.assertEqual(receipt["imported"], 1)
        self.assertEqual(receipt["deduplicated"], 0)
        self.assertEqual(
            set(
                SalesLine.objects.filter(user=self.user).values_list(
                    "provider_account_id", flat=True
                )
            ),
            {"M0", "M1"},
        )

    def test_square_line_uid_is_scoped_to_its_order(self) -> None:
        first = square_order(
            [square_line(uid="same", object_id="VAR1", quantity="1")],
            order_id="order-a",
            closed_at="2026-08-01T12:00:00Z",
        )
        second = square_order(
            [square_line(uid="same", object_id="VAR1", quantity="1")],
            order_id="order-b",
            closed_at="2026-08-01T12:00:00Z",
        )
        receipt = self.run_sync([first, second]).json()
        self.assertEqual(receipt["imported"], 2)
        self.assertEqual(
            set(
                SalesLine.objects.filter(user=self.user).values_list(
                    "provider_record_id", flat=True
                )
            ),
            {"order-a:line:same", "order-b:line:same"},
        )

    def test_square_return_uid_cannot_collide_with_original_line(self) -> None:
        order = square_order(
            [square_line(uid="same", object_id="VAR1", quantity="1")],
            order_id="order-a",
            returns=[
                {
                    "return_line_items": [
                        {
                            "uid": "same",
                            "catalog_object_id": "VAR1",
                            "quantity": "1",
                            "name": "Latte",
                            "item_type": "ITEM",
                            "gross_return_money": {"amount": 500},
                            "total_discount_money": {"amount": 0},
                            "total_tax_money": {"amount": 0},
                        }
                    ]
                }
            ],
        )
        receipt = self.run_sync([order]).json()
        self.assertEqual(receipt["imported"], 2)
        self.assertEqual(
            set(
                SalesLine.objects.filter(user=self.user).values_list(
                    "provider_record_id", flat=True
                )
            ),
            {"order-a:line:same", "order-a:return:same"},
        )

    def test_returns_become_negative_lines(self) -> None:
        return_order = {
            "id": "sqo_ret",
            "closed_at": "2026-08-03T09:00:00Z",
            "location_id": "L1",
            "line_items": [],
            "returns": [
                {
                    "return_line_items": [
                        {
                            "uid": "r1",
                            "catalog_object_id": "VAR1",
                            "quantity": "1",
                            "name": "Latte",
                            "variation_name": "Regular",
                            "item_type": "ITEM",
                            "gross_return_money": {"amount": 400},
                            "total_discount_money": {"amount": 50},
                            "total_tax_money": {"amount": 31},
                        }
                    ]
                }
            ],
        }
        response = self.run_sync([return_order])
        self.assertEqual(response.json()["imported"], 1)
        line = SalesLine.objects.get(user=self.user)
        self.assertEqual(line.quantity, -1)
        self.assertEqual(line.gross_cents, -400)
        self.assertEqual(line.net_sales_cents, -350)
        self.assertEqual(line.tax_cents, -31)
        self.assertEqual(line.refund_cents, 350)
        self.assertEqual(line.sales_import.refund_cents, 350)

    def test_gift_card_lines_skipped(self) -> None:
        order = {
            "id": "sqo_gc",
            "closed_at": "2026-08-01T10:00:00Z",
            "location_id": "L1",
            "line_items": [
                {
                    "uid": "g1",
                    "quantity": "1",
                    "name": "Gift Card",
                    "item_type": "GIFT_CARD",
                    "gross_sales_money": {"amount": 5000},
                }
            ],
        }
        receipt = self.run_sync([order]).json()
        self.assertEqual(receipt["imported"], 0)
        self.assertEqual(receipt["skippedMalformed"], 0)

    def test_empty_run_advances_watermark_without_import_row(self) -> None:
        receipt = self.run_sync([]).json()
        self.assertEqual(receipt["imported"], 0)
        self.assertIsNone(receipt["batchId"])
        self.assertEqual(SalesImport.objects.filter(user=self.user).count(), 0)
        self.connection.refresh_from_db()
        self.assertIsNotNone(self.connection.sync_watermark)

    def test_undo_rolls_watermark_back(self) -> None:
        receipt = self.run_sync([SQUARE_ORDER]).json()
        self.connection.refresh_from_db()
        watermark_after_sync = self.connection.sync_watermark
        self.connection.sync_cursor = {"version": 1}
        self.connection.sync_lease_token = uuid.uuid4()
        self.connection.sync_lease_started_at = timezone.now()
        self.connection.save(
            update_fields=[
                "sync_cursor",
                "sync_lease_token",
                "sync_lease_started_at",
            ]
        )
        run = SyncRun.objects.create(
            user=self.user,
            connection=self.connection,
            connection_generation=self.connection.generation,
            provider="square",
            provider_account_id="M1",
        )
        response = self.post_internal(
            "undo-sales-import", {"id": receipt["batchId"]}
        )
        self.assertEqual(response.status_code, 200)
        self.connection.refresh_from_db()
        self.assertLess(self.connection.sync_watermark, watermark_after_sync)
        self.assertEqual(
            self.connection.sync_watermark.date().isoformat(), "2026-08-01"
        )
        self.assertEqual(self.connection.sync_cursor, {})
        self.assertIsNone(self.connection.sync_lease_token)
        run.refresh_from_db()
        self.assertEqual(run.status, SyncRun.Status.CANCELLED)

    def test_undo_leaves_a_pending_backfill_alone(self) -> None:
        # External review: stamping a None watermark here turns the next sync
        # incremental and silently cancels the 90-day backfill.
        receipt = self.run_sync([SQUARE_ORDER]).json()
        self.connection.sync_watermark = None
        self.connection.backfilled_at = None
        self.connection.save(
            update_fields=["sync_watermark", "backfilled_at", "updated_at"]
        )
        response = self.post_internal(
            "undo-sales-import", {"id": receipt["batchId"]}
        )
        self.assertEqual(response.status_code, 200)
        self.connection.refresh_from_db()
        self.assertIsNone(self.connection.sync_watermark)

    def test_disconnect_deletes_connection_and_keeps_lines(self) -> None:
        self.run_sync([SQUARE_ORDER])
        run = SyncRun.objects.create(
            user=self.user,
            connection=self.connection,
            connection_generation=self.connection.generation,
            provider="square",
            provider_account_id="M1",
        )
        with patch("forkluck.integrations.square.revoke_access") as revoke:
            response = self.post_internal(
                "disconnect-pos", {"provider": "square"}
            )
        self.assertEqual(response.status_code, 200)
        revoke.assert_called_once_with("M1")
        self.assertFalse(
            SalesChannelConnection.objects.filter(user=self.user).exists()
        )
        self.assertEqual(SalesLine.objects.filter(user=self.user).count(), 2)
        run.refresh_from_db()
        self.assertEqual(run.status, SyncRun.Status.CANCELLED)
        self.assertIsNone(run.connection_id)


MODIFIER_CATALOG = {
    "VAR_BURGER": {
        "sku": "BURGER",
        "item_name": "Burger",
        "variant_name": "",
        "kind": "item",
    },
    "VAR_SAMPLER": {
        "sku": "SAMPLER",
        "item_name": "Sampler",
        "variant_name": "",
        "kind": "item",
    },
    "MOD_CHEESE": {
        "sku": "",
        "item_name": "Extra Cheese",
        "variant_name": "",
        "kind": "modifier",
    },
}


def square_modifier(
    *,
    uid: str = "m1",
    object_id: str = "MOD_CHEESE",
    name: str = "Extra Cheese",
    quantity: str | None = "1",
    base_cents: int | None = 100,
    total_cents: int | None = 100,
    extra: dict | None = None,
) -> dict:
    row: dict = {"uid": uid, "name": name}
    if object_id:
        row["catalog_object_id"] = object_id
    if quantity is not None:
        row["quantity"] = quantity
    if base_cents is not None:
        row["base_price_money"] = {"amount": base_cents, "currency": "USD"}
    if total_cents is not None:
        row["total_price_money"] = {"amount": total_cents, "currency": "USD"}
    if extra:
        row.update(extra)
    return row


def square_line(
    *,
    uid: str = "u1",
    object_id: str = "VAR_BURGER",
    name: str = "Burger",
    quantity: str = "2",
    modifiers: list[dict] | None = None,
    item_type: str = "ITEM",
    gross_cents: int = 1000,
) -> dict:
    line: dict = {
        "uid": uid,
        "quantity": quantity,
        "name": name,
        "variation_name": "",
        "item_type": item_type,
        "gross_sales_money": {"amount": gross_cents, "currency": "USD"},
        "total_discount_money": {"amount": 0},
        "total_tax_money": {"amount": 0},
        "total_money": {"amount": gross_cents, "currency": "USD"},
    }
    if object_id:
        line["catalog_object_id"] = object_id
    if modifiers is not None:
        line["modifiers"] = modifiers
    return line


def square_order(
    lines: list[dict],
    *,
    order_id: str = "sqo_mod",
    closed_at: str = "2026-08-05T12:00:00Z",
    returns: list[dict] | None = None,
) -> dict:
    order: dict = {
        "id": order_id,
        "closed_at": closed_at,
        "updated_at": closed_at,
        "location_id": "L1",
        "source": {"name": "Register"},
        "line_items": lines,
    }
    if returns is not None:
        order["returns"] = returns
    return order


class SquareModifierSyncTests(InternalApiTestCase):
    """Spec tests 12-27: structured modifier ingestion and pending retention."""

    def setUp(self) -> None:
        product_catalog = patch(
            "forkluck.integrations.square.list_catalog_items", return_value=[]
        )
        product_catalog.start()
        self.addCleanup(product_catalog.stop)
        self.user = User.objects.create_user(
            email="mods@example.com",
            name="Modifier Tester",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)
        self.burger = SalesProduct.objects.create(
            user=self.user, name="Burger", normalized_name="burger"
        )
        self.cheese = SalesProduct.objects.create(
            user=self.user, name="Cheese Portion", normalized_name="cheese portion"
        )
        self.burger_variant = SalesProductVariant.objects.create(
            user=self.user,
            product=self.burger,
            channel="square",
            match_key="square:item:VAR_BURGER",
            external_object_id="VAR_BURGER",
            sku="BURGER",
            external_name="Burger",
        )
        self.connection = SalesChannelConnection.objects.create(
            user=self.user,
            provider="square",
            access_token_encrypted=encrypt_token("tok"),
            merchant_id="M1",
            location_ids=["L1"],
            provider_timezone="UTC",
            currency_code="USD",
        )

    def track_cheese_modifier(self, match_key: str = "square:modifier:*:MOD_CHEESE"):
        return SalesProductVariant.objects.create(
            user=self.user,
            product=self.cheese,
            channel="square",
            match_key=match_key,
            identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
            external_object_id="MOD_CHEESE",
            external_name="Extra Cheese",
        )

    def run_sync(self, orders: list[dict], **kwargs) -> dict:
        def fake_search(
            token, location_ids, *, field, start_at, end_at, cursor=None
        ):
            return orders, None

        with (
            patch(
                "forkluck.integrations.square.search_orders_page",
                side_effect=fake_search,
            ),
            patch(
                "forkluck.integrations.square.list_locations",
                return_value=[
                    {"id": "L1", "timezone": "UTC", "currency": "USD"}
                ],
            ),
            patch(
                "forkluck.integrations.square.batch_retrieve_catalog",
                return_value=MODIFIER_CATALOG,
            ),
        ):
            return sync_connection(self.connection, **kwargs)

    def test_square_sync_stores_catalog_modifier_identity_and_quantity(self) -> None:
        self.track_cheese_modifier()
        receipt = self.run_sync(
            [square_order([square_line(modifiers=[square_modifier(quantity="2")])])]
        )
        self.assertEqual(receipt["imported"], 1)
        self.assertEqual(receipt["modifierOccurrences"], 1)
        self.assertEqual(receipt["modifierOccurrencesAttached"], 1)
        # One financial line, no invented revenue line for the modifier.
        line = SalesLine.objects.get(user=self.user)
        self.assertEqual(line.quantity, 2)
        self.assertEqual(line.gross_cents, 1000)
        modifier = SalesLineModifier.objects.get(user=self.user)
        self.assertEqual(modifier.sales_line_id, line.id)
        self.assertEqual(modifier.external_object_id, "MOD_CHEESE")
        self.assertEqual(modifier.quantity, 2)
        self.assertEqual(modifier.variant.product_id, self.cheese.id)
        self.assertEqual(modifier.match_key, "square:modifier:*:MOD_CHEESE")

    def test_disconnect_during_acquisition_prevents_sales_persistence(self) -> None:
        def fake_search(
            token, location_ids, *, field, start_at, end_at, cursor=None
        ):
            self.connection.delete()
            return [square_order([square_line()])], None

        with (
            patch(
                "forkluck.integrations.square.search_orders_page",
                side_effect=fake_search,
            ),
            patch(
                "forkluck.integrations.square.list_locations",
                return_value=[
                    {"id": "L1", "timezone": "UTC", "currency": "USD"}
                ],
            ),
            patch(
                "forkluck.integrations.square.batch_retrieve_catalog",
                return_value=MODIFIER_CATALOG,
            ),
            self.assertRaisesRegex(SyncFailed, "disconnected"),
        ):
            sync_connection(self.connection)

        self.assertFalse(SalesImport.objects.filter(user=self.user).exists())
        self.assertFalse(SalesLine.objects.filter(user=self.user).exists())

    def test_square_sync_stores_ad_hoc_name_only_modifier(self) -> None:
        receipt = self.run_sync(
            [
                square_order(
                    [
                        square_line(
                            modifiers=[
                                square_modifier(
                                    object_id="", name="Oat Milk", quantity="1"
                                )
                            ]
                        )
                    ]
                )
            ]
        )
        self.assertEqual(receipt["modifierOccurrences"], 1)
        modifier = SalesLineModifier.objects.get(user=self.user)
        self.assertEqual(modifier.external_object_id, "")
        self.assertEqual(modifier.name, "Oat Milk")
        self.assertEqual(
            modifier.match_key, "square:modifier:*:name:oat milk"
        )
        self.assertIsNone(modifier.variant_id)

    def test_square_sync_preserves_modifier_prices_without_adding_revenue(
        self,
    ) -> None:
        self.track_cheese_modifier()
        self.run_sync(
            [
                square_order(
                    [
                        square_line(
                            gross_cents=1000,
                            modifiers=[
                                square_modifier(base_cents=150, total_cents=300)
                            ],
                        )
                    ]
                )
            ]
        )
        line = SalesLine.objects.get(user=self.user)
        modifier = SalesLineModifier.objects.get(user=self.user)
        self.assertEqual(modifier.base_price_cents, 150)
        self.assertEqual(modifier.total_price_cents, 300)
        # Provider money stays exactly as reported on the parent line.
        self.assertEqual(line.gross_cents, 1000)
        self.assertEqual(line.net_sales_cents, 1000)

    def test_square_sync_preserves_raw_modifier_payload(self) -> None:
        self.run_sync(
            [
                square_order(
                    [
                        square_line(
                            modifiers=[
                                square_modifier(
                                    extra={"unknown_future_field": "keep me"}
                                )
                            ]
                        )
                    ]
                )
            ]
        )
        modifier = SalesLineModifier.objects.get(user=self.user)
        self.assertEqual(
            modifier.source_payload.get("unknown_future_field"), "keep me"
        )
        self.assertEqual(modifier.source_payload.get("uid"), "m1")

    def test_square_return_uses_negative_parent_quantity(self) -> None:
        self.track_cheese_modifier()
        order = square_order(
            [],
            order_id="sqo_return",
            returns=[
                {
                    "return_line_items": [
                        {
                            "uid": "r1",
                            "catalog_object_id": "VAR_BURGER",
                            "quantity": "1",
                            "name": "Burger",
                            "variation_name": "",
                            "item_type": "ITEM",
                            "gross_return_money": {"amount": 500},
                            "total_discount_money": {"amount": 0},
                            "total_tax_money": {"amount": 0},
                            "return_modifiers": [square_modifier(quantity="2")],
                        }
                    ]
                }
            ],
        )
        self.run_sync([order])
        line = SalesLine.objects.get(user=self.user)
        self.assertEqual(line.quantity, -1)
        self.assertEqual(line.gross_cents, -500)
        modifier = SalesLineModifier.objects.get(user=self.user)
        # The reversal lives in the parent quantity; modifier facts stay
        # non-negative.
        self.assertEqual(modifier.quantity, 2)

    def test_square_sync_handles_multiple_modifiers_on_one_line(self) -> None:
        self.run_sync(
            [
                square_order(
                    [
                        square_line(
                            object_id="VAR_SAMPLER",
                            name="Sampler",
                            quantity="1",
                            modifiers=[
                                square_modifier(
                                    uid="m1", object_id="MOD_A", name="Cookie A"
                                ),
                                square_modifier(
                                    uid="m2", object_id="MOD_B", name="Cookie B"
                                ),
                                square_modifier(
                                    uid="m3", object_id="MOD_C", name="Cookie C"
                                ),
                            ],
                        )
                    ]
                )
            ]
        )
        self.assertEqual(SalesLine.objects.filter(user=self.user).count(), 1)
        names = sorted(
            SalesLineModifier.objects.filter(user=self.user).values_list(
                "name", flat=True
            )
        )
        self.assertEqual(names, ["Cookie A", "Cookie B", "Cookie C"])

    def test_square_sync_handles_repeated_same_modifier_quantity(self) -> None:
        self.track_cheese_modifier()
        self.run_sync(
            [
                square_order(
                    [
                        square_line(
                            modifiers=[
                                square_modifier(uid="m1", quantity="2"),
                                square_modifier(uid="m2", quantity="3"),
                            ]
                        )
                    ]
                )
            ]
        )
        rows = SalesLineModifier.objects.filter(user=self.user).order_by("source_uid")
        self.assertEqual([row.quantity for row in rows], [2, 3])
        self.assertEqual(len({row.source_fingerprint for row in rows}), 2)

    def test_square_sync_ignores_gift_cards_without_orphan_modifiers(self) -> None:
        receipt = self.run_sync(
            [
                square_order(
                    [
                        square_line(
                            uid="g1",
                            object_id="",
                            name="Gift Card",
                            quantity="1",
                            item_type="GIFT_CARD",
                            modifiers=[
                                square_modifier(object_id="", name="Message")
                            ],
                        )
                    ]
                )
            ]
        )
        self.assertEqual(receipt["imported"], 0)
        self.assertEqual(receipt["modifierOccurrences"], 0)
        self.assertEqual(SalesLine.objects.filter(user=self.user).count(), 0)
        self.assertEqual(
            SalesLineModifier.objects.filter(user=self.user).count(), 0
        )

    def test_square_sync_stores_unmatched_parent_as_pending(self) -> None:
        receipt = self.run_sync(
            [
                square_order(
                    [square_line(uid="u9", object_id="", name="Mystery Item")]
                )
            ]
        )
        self.assertEqual(receipt["imported"], 1)
        self.assertEqual(receipt["pendingLines"], 1)
        self.assertEqual(receipt["pendingIdentities"], 1)
        self.assertEqual(receipt["skippedMalformed"], 0)
        line = SalesLine.objects.get(user=self.user)
        self.assertIsNone(line.product_id)
        self.assertIsNone(line.variant_id)
        self.assertEqual(line.group_key, "name:mystery item|")

    def test_square_sync_stores_unmatched_modifier_as_pending(self) -> None:
        receipt = self.run_sync(
            [square_order([square_line(modifiers=[square_modifier()])])]
        )
        self.assertEqual(receipt["modifierOccurrences"], 1)
        self.assertEqual(receipt["modifierOccurrencesPending"], 1)
        self.assertEqual(receipt["pendingModifierIdentities"], 1)
        modifier = SalesLineModifier.objects.get(user=self.user)
        self.assertIsNone(modifier.variant_id)
        self.assertEqual(modifier.name, "Extra Cheese")

    def test_square_sync_stores_ignored_identity_for_future_unignore(self) -> None:
        SalesSkuIgnore.objects.create(
            user=self.user,
            channel="square",
            provider_account_id=self.connection.provider_account_id,
            match_key="name:mystery item|",
            external_name="Mystery Item",
        )
        receipt = self.run_sync(
            [
                square_order(
                    [square_line(uid="u9", object_id="", name="Mystery Item")]
                )
            ]
        )
        self.assertEqual(receipt["imported"], 1)
        self.assertEqual(receipt["ignoredLines"], 1)
        self.assertEqual(receipt["pendingLines"], 0)
        # The fact survives so unignoring can recover the history.
        line = SalesLine.objects.get(user=self.user)
        self.assertIsNone(line.product_id)
        self.assertEqual(line.item_name, "Mystery Item")

    def test_square_sync_receipt_separates_pending_from_malformed_skips(self) -> None:
        receipt = self.run_sync(
            [
                square_order(
                    [
                        square_line(uid="u9", object_id="", name="Mystery Item"),
                        square_line(uid="u8", object_id="", quantity="not-a-number"),
                    ]
                )
            ]
        )
        self.assertEqual(receipt["skippedMalformed"], 1)
        self.assertEqual(receipt["pendingLines"], 1)
        self.assertEqual(receipt["imported"], 1)
        self.assertEqual(receipt["skippedUnmatched"], 0)
        sales_import = SalesImport.objects.get(id=receipt["batchId"])
        self.assertEqual(sales_import.skipped_count, 1)
        self.assertEqual(sales_import.unmapped_count, 1)

    def test_second_square_sync_does_not_duplicate_modifier_occurrences(self) -> None:
        order = square_order([square_line(modifiers=[square_modifier(quantity="2")])])
        self.run_sync([order])
        receipt = self.run_sync([order])
        self.assertEqual(receipt["imported"], 0)
        self.assertEqual(receipt["deduplicated"], 1)
        self.assertEqual(receipt["modifierOccurrences"], 0)
        self.assertEqual(
            SalesLineModifier.objects.filter(user=self.user).count(), 1
        )

    def test_provider_line_id_wins_over_changed_modifier_fingerprint(self) -> None:
        plain = square_order([square_line(modifiers=[])])
        with_cheese = square_order(
            [square_line(modifiers=[square_modifier(quantity="1")])]
        )
        entries_plain, _ = square_order_entries(
            plain,
            MODIFIER_CATALOG,
            self.connection,
            location_timezones={"L1": "UTC"},
        )
        entries_cheese, _ = square_order_entries(
            with_cheese,
            MODIFIER_CATALOG,
            self.connection,
            location_timezones={"L1": "UTC"},
        )
        interpret_provider_entries(entries_plain)
        interpret_provider_entries(entries_cheese)
        self.assertNotEqual(
            base_fingerprint(entries_plain[0]), base_fingerprint(entries_cheese[0])
        )
        # A modifier-less line hashes exactly as it did before modifiers
        # existed, so every stored fingerprint keeps matching.
        legacy = {
            key: value
            for key, value in entries_plain[0].items()
            if key != "modifiers"
        }
        self.assertEqual(
            base_fingerprint(entries_plain[0]), base_fingerprint(legacy)
        )
        # The immutable order+line identity still wins end to end: a replay
        # whose payload changed must not book the financial line twice.
        self.run_sync([plain])
        receipt = self.run_sync([with_cheese])
        self.assertEqual(receipt["imported"], 0)
        self.assertEqual(receipt["updated"], 1)
        self.assertEqual(receipt["deduplicated"], 0)
        self.assertEqual(receipt["modifierOccurrences"], 1)
        self.assertEqual(
            SalesLineModifier.objects.get(user=self.user).name,
            "Extra Cheese",
        )

    def test_undo_import_deletes_parent_and_modifier_occurrences(self) -> None:
        self.track_cheese_modifier()
        receipt = self.run_sync(
            [square_order([square_line(modifiers=[square_modifier(quantity="2")])])]
        )
        self.assertEqual(SalesLineModifier.objects.count(), 1)
        response = self.post_internal("undo-sales-import", {"id": receipt["batchId"]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(SalesLine.objects.filter(user=self.user).count(), 0)
        self.assertEqual(
            SalesLineModifier.objects.filter(user=self.user).count(), 0
        )

    def test_partial_square_sync_persists_cursor_not_global_watermark(self) -> None:
        order = square_order(
            [square_line(modifiers=[square_modifier()])],
            closed_at="2026-08-05T12:00:00Z",
        )
        receipt = self.run_sync([order], time_budget_s=-1)
        self.assertTrue(receipt["partial"])
        self.connection.refresh_from_db()
        self.assertIsNone(self.connection.sync_watermark)
        self.assertEqual(self.connection.sync_cursor["chunkIndex"], 0)
        # A partial run never claims the backfill is complete.
        self.assertIsNone(self.connection.backfilled_at)


CATEGORY_ORDER = {
    "id": "sqo_cat",
    "closed_at": "2026-08-04T12:00:00Z",
    "updated_at": "2026-08-04T12:00:05Z",
    "location_id": "L1",
    "source": {"name": "Register"},
    "line_items": [
        {
            "uid": "c1",
            "catalog_object_id": "VAR_TEA",
            "quantity": "1",
            "name": "Tea Flight",
            "item_type": "ITEM",
            "gross_sales_money": {"amount": 1200, "currency": "USD"},
            "total_discount_money": {"amount": 0},
            "total_tax_money": {"amount": 0},
            "total_money": {"amount": 1200, "currency": "USD"},
        },
        {
            "uid": "c2",
            "catalog_object_id": "VAR_TOTE",
            "quantity": "1",
            "name": "Tote Bag",
            "item_type": "ITEM",
            "gross_sales_money": {"amount": 1800, "currency": "USD"},
            "total_discount_money": {"amount": 0},
            "total_tax_money": {"amount": 0},
            "total_money": {"amount": 1800, "currency": "USD"},
        },
    ],
}

CATEGORY_CATALOG = {
    "VAR_TEA": {
        "sku": "TEA-01",
        "item_name": "Tea Flight",
        "variant_name": "",
        "kind": "item",
        "category": "Tea",
    },
    # No "category" key at all — the pre-category catalog shape, and what an
    # uncategorized Square item still looks like.
    "VAR_TOTE": {
        "sku": "TOTE-01",
        "item_name": "Tote Bag",
        "variant_name": "",
        "kind": "item",
    },
}


class SquareCategoryCaptureTests(InternalApiTestCase):
    """Provider category capture, backfill, and sync progress reporting."""

    def setUp(self) -> None:
        product_catalog = patch(
            "forkluck.integrations.square.list_catalog_items", return_value=[]
        )
        product_catalog.start()
        self.addCleanup(product_catalog.stop)
        self.user = User.objects.create_user(
            email="category@example.com",
            name="Category Tester",
            password="a-long-test-passphrase-2468",
        )
        self.other_user = User.objects.create_user(
            email="other-category@example.com",
            name="Other Category Tester",
            password="a-long-test-passphrase-1357",
        )
        self.client = Client()
        self.client.force_login(self.user)
        self.connection = SalesChannelConnection.objects.create(
            user=self.user,
            provider="square",
            access_token_encrypted=encrypt_token("tok"),
            merchant_id="M1",
            location_ids=["L1"],
            provider_timezone="UTC",
            currency_code="USD",
        )

    def run_sync(self, orders: list[dict], catalog=CATEGORY_CATALOG, **kwargs):
        def fake_search(
            token, location_ids, *, field, start_at, end_at, cursor=None
        ):
            return orders, None

        catalog_patch = (
            {"side_effect": catalog}
            if isinstance(catalog, list)
            else {"return_value": catalog}
        )
        with (
            patch(
                "forkluck.integrations.square.search_orders_page",
                side_effect=fake_search,
            ),
            patch(
                "forkluck.integrations.square.list_locations",
                return_value=[
                    {"id": "L1", "timezone": "UTC", "currency": "USD"}
                ],
            ),
            patch(
                "forkluck.integrations.square.batch_retrieve_catalog", **catalog_patch
            ),
        ):
            return sync_connection(self.connection, **kwargs)

    def make_line(self, user, **overrides) -> SalesLine:
        provider_account_id = (
            self.connection.provider_account_id
            if user == self.user
            else "OTHER_MERCHANT"
        )
        sales_import = SalesImport.objects.create(
            user=user,
            file_name="prior.csv",
            source="api",
            channel="square",
            provider_account_id=provider_account_id,
        )
        fields = {
            "user": user,
            "sales_import": sales_import,
            "channel": "square",
            "source_position": 1,
            "source_fingerprint": f"fp-{SalesLine.objects.count()}-{user.pk}",
            "external_order_id": "prior",
            "sold_at": timezone.now(),
            "item_name": "Tea Flight",
            "group_key": "sku:tea-01",
            "external_object_id": "VAR_TEA",
            "quantity": Decimal("1"),
        }
        fields.update(overrides)
        return SalesLine.objects.create(**fields)

    # category capture ---------------------------------------------------

    def test_sync_stores_provider_category_and_tolerates_an_absent_one(
        self,
    ) -> None:
        self.run_sync([CATEGORY_ORDER])
        tea = SalesLine.objects.get(user=self.user, sku="TEA-01")
        tote = SalesLine.objects.get(user=self.user, sku="TOTE-01")
        self.assertEqual(tea.external_category, "Tea")
        # A catalog entry without a category is not an error — it is the
        # uncategorized bucket, stored as blank.
        self.assertEqual(tote.external_category, "")

    def test_square_return_lines_carry_the_category_too(self) -> None:
        return_order = {
            "id": "sqo_cat_ret",
            "closed_at": "2026-08-05T12:00:00Z",
            "location_id": "L1",
            "returns": [
                {
                    "return_line_items": [
                        {
                            "uid": "r1",
                            "catalog_object_id": "VAR_TEA",
                            "quantity": "1",
                            "name": "Tea Flight",
                            "item_type": "ITEM",
                            "gross_return_money": {"amount": 1200},
                            "total_discount_money": {"amount": 0},
                            "total_tax_money": {"amount": 0},
                        }
                    ]
                }
            ],
        }
        self.run_sync([return_order])
        line = SalesLine.objects.get(user=self.user, sku="TEA-01")
        self.assertEqual(line.quantity, Decimal("-1"))
        self.assertEqual(line.external_category, "Tea")

    # backfill -----------------------------------------------------------

    def test_backfill_fills_blank_categories_on_pending_lines_only(self) -> None:
        pending = self.make_line(self.user)
        product = SalesProduct.objects.create(
            user=self.user, name="Tea Flight", normalized_name="tea flight"
        )
        matched = self.make_line(self.user, product=product, external_order_id="m")
        # Another account's identical pending line must never be touched.
        stranger = self.make_line(self.other_user)

        receipt = self.run_sync([])
        self.assertEqual(receipt["categoriesBackfilled"], 1)

        pending.refresh_from_db()
        matched.refresh_from_db()
        stranger.refresh_from_db()
        self.assertEqual(pending.external_category, "Tea")
        # A line already claimed by a menu item has left the review inbox.
        self.assertEqual(matched.external_category, "")
        self.assertEqual(stranger.external_category, "")

    def test_backfill_leaves_an_already_categorized_line_alone(self) -> None:
        line = self.make_line(self.user, external_category="Retail")
        receipt = self.run_sync([])
        self.assertEqual(receipt["categoriesBackfilled"], 0)
        line.refresh_from_db()
        self.assertEqual(line.external_category, "Retail")

    def test_backfill_skips_lines_without_a_provider_object_id(self) -> None:
        line = self.make_line(self.user, external_object_id="")
        receipt = self.run_sync([])
        self.assertEqual(receipt["categoriesBackfilled"], 0)
        line.refresh_from_db()
        self.assertEqual(line.external_category, "")

    def test_backfill_failure_never_fails_the_sync(self) -> None:
        line = self.make_line(self.user)
        receipt = self.run_sync(
            [CATEGORY_ORDER],
            catalog=[CATEGORY_CATALOG, square.SquareError("catalog down")],
        )
        # The run's own lines still landed; only the top-up was lost.
        self.assertEqual(receipt["imported"], 2)
        self.assertEqual(receipt["categoriesBackfilled"], 0)
        line.refresh_from_db()
        self.assertEqual(line.external_category, "")

    # progress -----------------------------------------------------------

    def test_receipt_reports_pages_and_lines_fetched(self) -> None:
        receipt = self.run_sync([CATEGORY_ORDER])
        self.assertEqual(receipt["pagesProcessed"], 1)
        self.assertEqual(receipt["linesFetched"], 2)

class SquareCatalogCategoryTests(TestCase):
    """`batch_retrieve_catalog` reading Square's three category shapes."""

    def catalog(self, *responses: dict) -> dict:
        with patch(
            "forkluck.integrations.square._request", side_effect=list(responses)
        ):
            return square.batch_retrieve_catalog("tok", ["VAR_TEA"])

    def variation(self, item_id: str = "ITEM_TEA") -> dict:
        return {
            "type": "ITEM_VARIATION",
            "id": "VAR_TEA",
            "item_variation_data": {
                "item_id": item_id,
                "sku": "TEA-01",
                "name": "Small",
            },
        }

    def item(self, **item_data) -> dict:
        return {
            "type": "ITEM",
            "id": "ITEM_TEA",
            "item_data": {"name": "Tea Flight", **item_data},
        }

    def category(self, category_id: str, name: str) -> dict:
        return {
            "type": "CATEGORY",
            "id": category_id,
            "category_data": {"name": name},
        }

    def test_reporting_category_wins(self) -> None:
        result = self.catalog(
            {
                "objects": [self.variation()],
                "related_objects": [
                    self.item(
                        reporting_category={"id": "CAT_TEA", "ordinal": 0},
                        categories=[{"id": "CAT_OTHER", "ordinal": 0}],
                        category_id="CAT_LEGACY",
                    ),
                    self.category("CAT_TEA", "Tea"),
                    self.category("CAT_OTHER", "Retail"),
                ],
            }
        )
        self.assertEqual(result["VAR_TEA"]["category"], "Tea")
        self.assertEqual(result["VAR_TEA"]["item_name"], "Tea Flight")

    def test_categories_list_uses_the_lowest_ordinal(self) -> None:
        result = self.catalog(
            {
                "objects": [self.variation()],
                "related_objects": [
                    self.item(
                        categories=[
                            {"id": "CAT_RETAIL", "ordinal": 3},
                            {"id": "CAT_TEA", "ordinal": 1},
                        ]
                    ),
                    self.category("CAT_TEA", "Tea"),
                    self.category("CAT_RETAIL", "Retail"),
                ],
            }
        )
        self.assertEqual(result["VAR_TEA"]["category"], "Tea")

    def test_legacy_category_id_is_still_read(self) -> None:
        result = self.catalog(
            {
                "objects": [self.variation()],
                "related_objects": [
                    self.item(category_id="CAT_TEA"),
                    self.category("CAT_TEA", "Tea"),
                ],
            }
        )
        self.assertEqual(result["VAR_TEA"]["category"], "Tea")

    def test_item_without_any_category_reads_blank(self) -> None:
        result = self.catalog(
            {"objects": [self.variation()], "related_objects": [self.item()]}
        )
        self.assertEqual(result["VAR_TEA"]["category"], "")

    def test_malformed_category_shapes_do_not_raise(self) -> None:
        result = self.catalog(
            {
                "objects": [self.variation()],
                "related_objects": [
                    self.item(
                        reporting_category=["nonsense"],
                        categories="nonsense",
                        category_id=17,
                    )
                ],
            }
        )
        self.assertEqual(result["VAR_TEA"]["category"], "")

    def test_category_name_missing_from_related_objects_is_fetched(self) -> None:
        # `include_related_objects` only walks one level, so a VARIATION lookup
        # returns its ITEM but not that item's CATEGORY — hence a second pass.
        result = self.catalog(
            {
                "objects": [self.variation()],
                "related_objects": [
                    self.item(reporting_category={"id": "CAT_TEA", "ordinal": 0})
                ],
            },
            {"objects": [self.category("CAT_TEA", "Tea")]},
        )
        self.assertEqual(result["VAR_TEA"]["category"], "Tea")

    def test_failed_category_name_pass_degrades_to_blank(self) -> None:
        result = self.catalog(
            {
                "objects": [self.variation()],
                "related_objects": [
                    self.item(reporting_category={"id": "CAT_TEA", "ordinal": 0})
                ],
            },
            square.SquareError("catalog down"),
        )
        self.assertEqual(result["VAR_TEA"]["category"], "")
        self.assertEqual(result["VAR_TEA"]["sku"], "TEA-01")

    def test_modifier_entries_carry_a_blank_category(self) -> None:
        with patch(
            "forkluck.integrations.square._request",
            return_value={
                "objects": [
                    {
                        "type": "MODIFIER",
                        "id": "MOD_HONEY",
                        "modifier_data": {"name": "Honey"},
                    }
                ]
            },
        ):
            result = square.batch_retrieve_catalog("tok", ["MOD_HONEY"])
        self.assertEqual(result["MOD_HONEY"]["category"], "")
        self.assertEqual(result["MOD_HONEY"]["kind"], "modifier")


class SquareTokenRefreshTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="refresh@example.com",
            name="Refresh Tester",
            password="a-long-test-passphrase-2468",
        )
        self.connection = SalesChannelConnection.objects.create(
            user=self.user,
            provider="square",
            access_token_encrypted=encrypt_token("old-token"),
            refresh_token_encrypted=encrypt_token("refresh-1"),
            token_expires_at=timezone.now() + timedelta(days=1),
            merchant_id="M1",
        )

    def test_refresh_happens_once_and_persists_rotated_pair(self) -> None:
        with patch(
            "forkluck.integrations.square.refresh_access_token",
            return_value={
                "access_token": "new-token",
                "refresh_token": "refresh-2",
                "expires_at": (timezone.now() + timedelta(days=30)).isoformat(),
            },
        ) as refresh:
            token = ensure_fresh_square_token(self.connection)
        self.assertEqual(token, "new-token")
        refresh.assert_called_once_with("refresh-1")
        stored = SalesChannelConnection.objects.get(pk=self.connection.pk)
        self.assertEqual(decrypt_token(stored.access_token_encrypted), "new-token")
        self.assertEqual(
            decrypt_token(stored.refresh_token_encrypted), "refresh-2"
        )
        self.assertGreater(
            stored.token_expires_at, timezone.now() + timedelta(days=20)
        )

    def test_fresh_token_is_not_refreshed(self) -> None:
        self.connection.token_expires_at = timezone.now() + timedelta(days=20)
        self.connection.save(update_fields=["token_expires_at"])
        with patch("forkluck.integrations.square.refresh_access_token") as refresh:
            token = ensure_fresh_square_token(self.connection)
        self.assertEqual(token, "old-token")
        refresh.assert_not_called()

    def test_revoked_grant_marks_needs_reconnect(self) -> None:
        with patch(
            "forkluck.integrations.square.refresh_access_token",
            side_effect=square.SquareGrantRevoked("dead"),
        ):
            with self.assertRaises(SyncFailed):
                ensure_fresh_square_token(self.connection)
        stored = SalesChannelConnection.objects.get(pk=self.connection.pk)
        self.assertEqual(stored.status, "needs_reconnect")


SHOPIFY_SALE = {
    "id": "s1",
    "actionType": "ORDER",
    "lineType": "PRODUCT",
    "quantity": 2,
    "totalAmount": {"shopMoney": {"amount": "21.60", "currencyCode": "USD"}},
    "totalDiscountAmountBeforeTaxes": {"shopMoney": {"amount": "2.00"}},
    "totalTaxAmount": {"shopMoney": {"amount": "1.60"}},
    "lineItem": {"id": "li1", "name": "Tea Cake", "sku": "CAKE-01", "variantTitle": ""},
}


def shopify_order(sales: list[dict], *, test: bool = False) -> dict:
    return {
        "id": "gid://shopify/Order/1",
        "name": "#1001",
        "test": test,
        "updatedAt": "2026-08-02T10:00:00Z",
        "cancelledAt": None,
        "agreements": {
            "nodes": [
                {
                    "id": "a1",
                    "happenedAt": "2026-08-02T09:59:00Z",
                    "sales": {
                        "nodes": sales,
                        "pageInfo": {"hasNextPage": False},
                    },
                }
            ],
            "pageInfo": {"hasNextPage": False},
        },
    }


class ShopifySyncTests(TestCase):
    def setUp(self) -> None:
        product_catalog = patch(
            "forkluck.integrations.shopify.list_catalog_items", return_value=[]
        )
        product_catalog.start()
        self.addCleanup(product_catalog.stop)
        self.user = User.objects.create_user(
            email="shp@example.com",
            name="Shp Tester",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)
        product = SalesProduct.objects.create(
            user=self.user, name="Tea Cake", normalized_name="tea cake"
        )
        SalesProductVariant.objects.create(
            user=self.user,
            product=product,
            channel="shopify",
            match_key="sku:cake-01",
            sku="CAKE-01",
            external_name="Tea Cake",
        )
        self.connection = SalesChannelConnection.objects.create(
            user=self.user,
            provider="shopify",
            access_token_encrypted=encrypt_token("shp-tok"),
            shop_domain="teashop.myshopify.com",
            provider_timezone="UTC",
            currency_code="USD",
        )

    def run_sync(self, nodes: list[dict]) -> dict:
        def fake_fetch(shop, token, *, since_iso, on_page, **kwargs):
            on_page(nodes)

        with patch(
            "forkluck.integrations.shopify.fetch_sales_agreements",
            side_effect=fake_fetch,
        ):
            return sync_connection(self.connection)

    def test_first_sync_requests_two_years_of_shopify_history(self) -> None:
        seen: list[str] = []

        def fake_fetch(shop, token, *, since_iso, on_page, **kwargs):
            seen.append(since_iso)
            on_page([])

        before = timezone.now()
        with patch(
            "forkluck.integrations.shopify.fetch_sales_agreements",
            side_effect=fake_fetch,
        ):
            sync_connection(self.connection)
        requested_since = datetime.fromisoformat(seen[0])
        self.assertLessEqual(requested_since, before - timedelta(days=729))
        self.assertGreaterEqual(requested_since, before - timedelta(days=731))

    def test_shopify_category_prefers_product_type(self) -> None:
        sale = json.loads(json.dumps(SHOPIFY_SALE))
        sale["lineItem"]["product"] = {
            "id": "gid://shopify/Product/9",
            "productType": "Snacks",
            "category": {"name": "Bakery"},
        }
        self.run_sync([shopify_order([sale])])
        line = SalesLine.objects.get(user=self.user)
        self.assertEqual(line.external_category, "Snacks")

    def test_shopify_category_falls_back_to_taxonomy(self) -> None:
        sale = json.loads(json.dumps(SHOPIFY_SALE))
        sale["lineItem"]["product"] = {
            "id": "gid://shopify/Product/9",
            "productType": "",
            "category": {"name": "Bakery"},
        }
        self.run_sync([shopify_order([sale])])
        line = SalesLine.objects.get(user=self.user)
        self.assertEqual(line.external_category, "Bakery")

    def test_shopify_category_backfills_pending_lines(self) -> None:
        self.run_sync([shopify_order([SHOPIFY_SALE])])
        line = SalesLine.objects.get(user=self.user)
        line.product = None
        line.variant = None
        line.external_category = ""
        line.source_payload = {
            **line.source_payload,
            "productObjectId": "gid://shopify/Product/9",
        }
        line.save()

        def fake_fetch(shop, token, *, since_iso, on_page, **kwargs):
            return on_page([])

        with (
            patch(
                "forkluck.integrations.shopify.fetch_sales_agreements",
                side_effect=fake_fetch,
            ),
            patch(
                "forkluck.integrations.shopify.fetch_product_categories",
                return_value={"gid://shopify/Product/9": "Snacks"},
            ) as fetch,
        ):
            receipt = sync_connection(self.connection)
        self.assertEqual(receipt["categoriesBackfilled"], 1)
        fetch.assert_called_once()
        line.refresh_from_db()
        self.assertEqual(line.external_category, "Snacks")

    def test_resume_session_skips_the_overlap_reread(self) -> None:
        watermark = timezone.now() - timedelta(days=5)
        self.connection.sync_watermark = watermark
        self.connection.backfilled_at = watermark
        self.connection.save(update_fields=["sync_watermark", "backfilled_at"])
        seen: list[str] = []

        def fake_fetch(shop, token, *, since_iso, on_page, **kwargs):
            seen.append(since_iso)
            on_page([])

        with patch(
            "forkluck.integrations.shopify.fetch_sales_agreements",
            side_effect=fake_fetch,
        ):
            sync_connection(self.connection)
            self.connection.refresh_from_db()
            self.connection.sync_watermark = watermark
            self.connection.save(update_fields=["sync_watermark"])
            sync_connection(self.connection, pass_count=2)
        self.assertEqual(seen[0], (watermark - timedelta(days=2)).isoformat())
        self.assertEqual(seen[1], watermark.isoformat())

    def test_product_sale_money_mapping(self) -> None:
        receipt = self.run_sync([shopify_order([SHOPIFY_SALE])])
        self.assertEqual(receipt["imported"], 1)
        line = SalesLine.objects.get(user=self.user)
        # total 21.60 includes 1.60 tax → net 20.00; gross adds the 2.00
        # pre-tax discount back → 22.00.
        self.assertEqual(line.tax_cents, 160)
        self.assertEqual(line.net_sales_cents, 2000)
        self.assertEqual(line.gross_cents, 2200)
        self.assertEqual(line.quantity, 2)
        self.assertEqual(line.external_order_id, "#1001")
        self.assertEqual(
            line.sold_at.isoformat(), "2026-08-02T09:59:00+00:00"
        )

    def test_test_orders_skipped(self) -> None:
        receipt = self.run_sync([shopify_order([SHOPIFY_SALE], test=True)])
        self.assertEqual(receipt["imported"], 0)
        self.assertEqual(SalesLine.objects.filter(user=self.user).count(), 0)

    def test_return_normalized_to_negative(self) -> None:
        entries, truncated = shopify_order_entries(
            shopify_order(
                [
                    {
                        **SHOPIFY_SALE,
                        "actionType": "RETURN",
                        "quantity": 1,
                        "totalAmount": {
                            "shopMoney": {"amount": "10.80", "currencyCode": "USD"}
                        },
                        "totalDiscountAmountBeforeTaxes": {
                            "shopMoney": {"amount": "1.00"}
                        },
                        "totalTaxAmount": {"shopMoney": {"amount": "0.80"}},
                    }
                ]
            ),
            self.connection,
        )
        self.assertEqual(truncated, 0)
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry["quantity"], -1)
        self.assertEqual(entry["tax_cents"], -80)
        self.assertEqual(entry["net_sales_cents"], -1000)
        self.assertEqual(entry["refund_cents"], 1000)

    def test_non_product_lines_skipped(self) -> None:
        receipt = self.run_sync(
            [
                shopify_order(
                    [{**SHOPIFY_SALE, "lineType": "SHIPPING", "lineItem": None}]
                )
            ]
        )
        self.assertEqual(receipt["imported"], 0)
        self.assertEqual(receipt["skippedUnmatched"], 0)


class ConnectShopifyTokenTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="token@example.com",
            name="Token Tester",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)

    def connect(self, body: dict):
        return self.client.post(
            "/internal/v1/actions/connect-shopify-token/",
            data=json.dumps(body),
            content_type="application/json",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )

    @patch("forkluck.integrations.shopify.fetch_token_info")
    def test_happy_path_stores_encrypted_connection(self, token_info) -> None:
        token_info.return_value = {
            "timezone": "America/New_York",
            "currency": "USD",
            "scopes": ["read_orders"],
        }
        response = self.connect(
            {"shopDomain": "teashop.myshopify.com", "accessToken": "shpat_abc123"}
        )
        self.assertEqual(response.status_code, 200)
        connection = SalesChannelConnection.objects.get(
            user=self.user, provider="shopify"
        )
        self.assertEqual(connection.shop_domain, "teashop.myshopify.com")
        self.assertEqual(
            decrypt_token(connection.access_token_encrypted), "shpat_abc123"
        )
        self.assertEqual(connection.scopes, "read_orders")
        self.assertEqual(connection.provider_timezone, "America/New_York")
        token_info.assert_called_once_with(
            "teashop.myshopify.com", "shpat_abc123"
        )

    def test_secret_key_paste_gets_helpful_error(self) -> None:
        response = self.connect(
            {"shopDomain": "teashop.myshopify.com", "accessToken": "shpss_e2wrong"}
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("shpat_", response.json()["error"])

    def test_bad_domain_rejected(self) -> None:
        response = self.connect(
            {"shopDomain": "evil.example.com", "accessToken": "shpat_abc123"}
        )
        self.assertEqual(response.status_code, 400)

    @patch("forkluck.integrations.shopify.fetch_token_info")
    def test_rejected_token_surfaces_friendly_error(self, token_info) -> None:
        token_info.side_effect = shopify.ShopifyError("401")
        response = self.connect(
            {"shopDomain": "teashop.myshopify.com", "accessToken": "shpat_bad"}
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("rejected", response.json()["error"])

    @patch("forkluck.integrations.shopify.fetch_token_info")
    def test_missing_read_orders_scope_rejected(self, token_info) -> None:
        token_info.return_value = {
            "timezone": "UTC",
            "currency": "USD",
            "scopes": ["read_products"],
        }
        response = self.connect(
            {"shopDomain": "teashop.myshopify.com", "accessToken": "shpat_abc"}
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("read_orders", response.json()["error"])


class ConnectSquareSandboxTokenTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="square-token@example.com",
            name="Square Token Tester",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)

    def connect(self, body: dict):
        return self.client.post(
            "/internal/v1/actions/connect-square-token/",
            data=json.dumps(body),
            content_type="application/json",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )

    @patch("forkluck.integrations.square.list_locations")
    def test_happy_path_stores_verified_sandbox_connection(self, locations) -> None:
        locations.return_value = [
            {
                "id": "L1",
                "merchant_id": "M1",
                "timezone": "America/New_York",
                "currency": "USD",
                "status": "ACTIVE",
            }
        ]
        response = self.connect({"accessToken": "EAAA_sandbox_token"})
        self.assertEqual(response.status_code, 200)
        connection = SalesChannelConnection.objects.get(
            user=self.user, provider="square"
        )
        self.assertEqual(
            decrypt_token(connection.access_token_encrypted), "EAAA_sandbox_token"
        )
        self.assertEqual(connection.merchant_id, "M1")
        self.assertEqual(connection.location_ids, ["L1"])
        self.assertEqual(connection.provider_timezone, "America/New_York")
        self.assertEqual(connection.currency_code, "USD")

    @patch("forkluck.integrations.square.list_locations")
    def test_rejected_token_has_a_safe_error(self, locations) -> None:
        locations.side_effect = square.SquareGrantRevoked("401")
        response = self.connect({"accessToken": "EAAA_bad_token"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("Square rejected", response.json()["error"])

    @patch("forkluck.integrations.square.list_locations")
    def test_an_unsupported_provider_currency_is_refused(self, locations) -> None:
        # JPY has no minor unit, so Square's amounts would land in
        # net_sales_cents 100x smaller than Shopify's for the same money.
        locations.return_value = [
            {
                "id": "L1",
                "merchant_id": "M1",
                "timezone": "Asia/Tokyo",
                "currency": "JPY",
                "status": "ACTIVE",
            }
        ]
        response = self.connect({"accessToken": "EAAA_sandbox_token"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("JPY", response.json()["error"])
        self.assertFalse(SalesChannelConnection.objects.filter(user=self.user).exists())

    @patch("forkluck.integrations.square.list_locations", return_value=[])
    def test_account_without_locations_is_not_connected(self, _locations) -> None:
        response = self.connect({"accessToken": "EAAA_empty_token"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("no locations", response.json()["error"])
        self.assertFalse(
            SalesChannelConnection.objects.filter(
                user=self.user, provider="square"
            ).exists()
        )


class ConnectShopifyCredentialsTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="creds@example.com",
            name="Creds Tester",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)

    def connect(self, body: dict):
        return self.client.post(
            "/internal/v1/actions/connect-shopify-credentials/",
            data=json.dumps(body),
            content_type="application/json",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )

    @patch("forkluck.integrations.shopify.fetch_shop_info")
    @patch("forkluck.integrations.shopify.client_credentials_token")
    def test_happy_path_stores_credentials_and_minted_token(
        self, mint, shop_info
    ) -> None:
        mint.return_value = {
            "access_token": "shpat_minted",
            "scope": "read_orders",
            "expires_in": 86399,
        }
        shop_info.return_value = {"timezone": "America/New_York", "currency": "USD"}
        response = self.connect(
            {
                "shopDomain": "teashop.myshopify.com",
                "clientId": "client-id-123456",
                "clientSecret": "client-secret-abcdef",
            }
        )
        self.assertEqual(response.status_code, 200)
        connection = SalesChannelConnection.objects.get(
            user=self.user, provider="shopify"
        )
        self.assertEqual(
            decrypt_token(connection.access_token_encrypted), "shpat_minted"
        )
        self.assertEqual(
            decrypt_token(connection.refresh_token_encrypted),
            "client-secret-abcdef",
        )
        self.assertEqual(connection.merchant_id, "client-id-123456")
        self.assertIsNotNone(connection.token_expires_at)
        self.assertGreater(
            connection.token_expires_at, timezone.now() + timedelta(hours=20)
        )

    @patch("forkluck.integrations.shopify.client_credentials_token")
    def test_rejected_credentials_surface_friendly_error(self, mint) -> None:
        mint.side_effect = shopify.ShopifyAuthError("401")
        response = self.connect(
            {
                "shopDomain": "teashop.myshopify.com",
                "clientId": "client-id-123456",
                "clientSecret": "client-secret-abcdef",
            }
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("organization", response.json()["error"])

    @patch("forkluck.integrations.shopify.client_credentials_token")
    def test_missing_read_orders_scope_rejected(self, mint) -> None:
        mint.return_value = {
            "access_token": "shpat_minted",
            "scope": "read_products",
            "expires_in": 86399,
        }
        response = self.connect(
            {
                "shopDomain": "teashop.myshopify.com",
                "clientId": "client-id-123456",
                "clientSecret": "client-secret-abcdef",
            }
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("read_orders", response.json()["error"])


class PosConnectionSurfaceTests(TestCase):
    """The connection surface is one sales-domain serializer with two readers.

    `/internal/v1/pos-connections/` (read) and the `pos-connections-status`
    action (write route) must return byte-identical payloads: the frontend
    refreshes the settings screen through whichever one is closer to hand.
    The layers contract cannot catch them drifting apart, because
    integrations legitimately sits below both — so pin the agreement, the
    tenant scoping, and the disconnect matrix here.
    """

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="surface@example.com",
            name="Surface Tester",
            password="a-long-test-passphrase-2468",
        )
        self.other = User.objects.create_user(
            email="other-surface@example.com",
            name="Other Tester",
            password="a-long-test-passphrase-1357",
        )
        self.client = Client()
        self.client.force_login(self.user)
        self.square = SalesChannelConnection.objects.create(
            user=self.user,
            provider=SalesImport.Channel.SQUARE,
            provider_account_id="M1",
            merchant_id="M1",
            access_token_encrypted=encrypt_token("sq0atp-live"),
            scopes="ORDERS_READ",
            provider_timezone="America/New_York",
            currency_code="USD",
        )
        self.shopify = SalesChannelConnection.objects.create(
            user=self.user,
            provider=SalesImport.Channel.SHOPIFY,
            provider_account_id="teashop.myshopify.com",
            shop_domain="teashop.myshopify.com",
            access_token_encrypted=encrypt_token("shpat_live"),
            scopes="read_orders",
            provider_timezone="UTC",
            currency_code="GBP",
        )
        SalesChannelConnection.objects.create(
            user=self.other,
            provider=SalesImport.Channel.SQUARE,
            provider_account_id="M-OTHER",
            merchant_id="M-OTHER",
            access_token_encrypted=encrypt_token("sq0atp-other"),
        )

    def read_endpoint(self):
        return self.client.get(
            "/internal/v1/pos-connections/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )

    def status_action(self):
        return self.client.post(
            "/internal/v1/actions/pos-connections-status/",
            data=json.dumps({}),
            content_type="application/json",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )

    def disconnect(self, body: dict):
        return self.client.post(
            "/internal/v1/actions/disconnect-pos/",
            data=json.dumps(body),
            content_type="application/json",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )

    def test_read_endpoint_and_status_action_agree(self) -> None:
        read = self.read_endpoint()
        action = self.status_action()
        self.assertEqual(read.status_code, 200)
        self.assertEqual(action.status_code, 200)
        self.assertEqual(read.json(), action.json())

    def test_both_readers_are_scoped_to_the_signed_in_user(self) -> None:
        for name, response in (
            ("read", self.read_endpoint()),
            ("action", self.status_action()),
        ):
            with self.subTest(reader=name):
                accounts = {
                    row["providerAccountId"] for row in response.json()["items"]
                }
                self.assertEqual(accounts, {"M1", "teashop.myshopify.com"})

    def test_neither_reader_serializes_a_token(self) -> None:
        for name, response in (
            ("read", self.read_endpoint()),
            ("action", self.status_action()),
        ):
            with self.subTest(reader=name):
                body = response.content.decode()
                self.assertNotIn("sq0atp-live", body)
                self.assertNotIn("shpat_live", body)
                self.assertNotIn("encrypted", body)

    def test_disconnecting_square_revokes_and_leaves_no_note(self) -> None:
        with patch("forkluck.integrations.square.revoke_access") as revoke:
            response = self.disconnect({"provider": "square"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True, "note": ""})
        revoke.assert_called_once_with("M1")
        self.assertFalse(
            SalesChannelConnection.objects.filter(
                user=self.user, provider=SalesImport.Channel.SQUARE
            ).exists()
        )
        # The other provider and the other tenant are untouched.
        self.assertTrue(
            SalesChannelConnection.objects.filter(
                user=self.user, provider=SalesImport.Channel.SHOPIFY
            ).exists()
        )
        self.assertTrue(
            SalesChannelConnection.objects.filter(user=self.other).exists()
        )

    def test_reconnect_cannot_replace_credentials_during_provider_revoke(
        self,
    ) -> None:
        def attempt_reconnect(merchant_id: str) -> None:
            self.assertEqual(merchant_id, "M1")
            with self.assertRaisesRegex(ValueError, "still disconnecting"):
                pos_oauth.save_connection(
                    self.user,
                    SalesImport.Channel.SQUARE,
                    {
                        "access_token_encrypted": encrypt_token("replacement"),
                        "refresh_token_encrypted": "",
                        "token_expires_at": None,
                        "merchant_id": "M1",
                        "location_ids": ["L1"],
                        "location_timezones": {
                            "L1": "America/New_York"
                        },
                        "scopes": "ORDERS_READ",
                        "provider_timezone": "America/New_York",
                        "currency_code": "USD",
                    },
                )

        with patch(
            "forkluck.integrations.square.revoke_access",
            side_effect=attempt_reconnect,
        ):
            response = self.disconnect({"provider": "square"})

        self.assertEqual(response.status_code, 200)
        self.assertFalse(
            SalesChannelConnection.objects.filter(
                user=self.user, provider=SalesImport.Channel.SQUARE
            ).exists()
        )

    def test_a_crashed_disconnect_can_be_retried(self) -> None:
        self.square.generation = 2
        self.square.status = SalesChannelConnection.Status.DISCONNECTING
        self.square.save(update_fields=["generation", "status", "updated_at"])

        with patch("forkluck.integrations.square.revoke_access") as revoke:
            response = self.disconnect({"provider": "square"})

        self.assertEqual(response.status_code, 200)
        revoke.assert_called_once_with("M1")
        self.assertFalse(
            SalesChannelConnection.objects.filter(pk=self.square.pk).exists()
        )

    def test_disconnecting_shopify_returns_the_uninstall_note(self) -> None:
        with patch("forkluck.integrations.square.revoke_access") as revoke:
            response = self.disconnect({"provider": "shopify"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("uninstall", response.json()["note"])
        revoke.assert_not_called()

    def test_disconnecting_a_channel_that_is_not_connected_is_a_400(self) -> None:
        with patch("forkluck.integrations.square.revoke_access"):
            self.disconnect({"provider": "square"})
        with patch("forkluck.integrations.square.revoke_access") as revoke:
            response = self.disconnect({"provider": "square"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("not connected", response.json()["error"])
        revoke.assert_not_called()

    def test_disconnect_rejects_a_non_text_provider(self) -> None:
        response = self.disconnect({"provider": 7})
        self.assertEqual(response.status_code, 400)
        self.assertIn("must be text", response.json()["error"])

    def test_another_users_connection_cannot_be_disconnected(self) -> None:
        SalesChannelConnection.objects.filter(user=self.user).delete()
        with patch("forkluck.integrations.square.revoke_access") as revoke:
            response = self.disconnect({"provider": "square"})
        self.assertEqual(response.status_code, 400)
        revoke.assert_not_called()
        self.assertTrue(
            SalesChannelConnection.objects.filter(user=self.other).exists()
        )

    @patch("forkluck.integrations.shopify.fetch_token_info")
    def test_reconnecting_a_new_shop_replaces_the_identity_both_readers_show(
        self, token_info
    ) -> None:
        self.shopify.sync_watermark = timezone.now()
        self.shopify.last_synced_at = timezone.now()
        self.shopify.save(update_fields=["sync_watermark", "last_synced_at"])
        token_info.return_value = {
            "timezone": "Europe/London",
            "currency": "GBP",
            "scopes": ["read_orders"],
        }
        response = self.client.post(
            "/internal/v1/actions/connect-shopify-token/",
            data=json.dumps(
                {
                    "shopDomain": "othershop.myshopify.com",
                    "accessToken": "shpat_new",
                }
            ),
            content_type="application/json",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["shopDomain"], "othershop.myshopify.com")
        # Replacing the account clears the old watermark, and every reader —
        # the action result, the read endpoint, the status action — reports
        # the same row through the same serializer.
        shopify_rows = [
            row
            for row in self.read_endpoint().json()["items"]
            if row["provider"] == "shopify"
        ]
        self.assertEqual(len(shopify_rows), 1)
        self.assertEqual(shopify_rows[0], response.json())
        self.assertEqual(self.status_action().json()["items"], self.read_endpoint().json()["items"])
        self.assertIsNone(shopify_rows[0]["lastSyncedAt"])


class ShopifyTokenRefreshTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="shprefresh@example.com",
            name="Shp Refresh",
            password="a-long-test-passphrase-2468",
        )
        self.connection = SalesChannelConnection.objects.create(
            user=self.user,
            provider="shopify",
            access_token_encrypted=encrypt_token("shpat_old"),
            refresh_token_encrypted=encrypt_token("client-secret"),
            merchant_id="client-id",
            shop_domain="teashop.myshopify.com",
            token_expires_at=timezone.now() - timedelta(minutes=1),
        )

    def test_expired_token_is_reminted_and_persisted(self) -> None:
        from .integrations.pos_sync import ensure_fresh_shopify_token

        with patch(
            "forkluck.integrations.shopify.client_credentials_token",
            return_value={"access_token": "shpat_new", "expires_in": 86399},
        ) as mint:
            token = ensure_fresh_shopify_token(self.connection)
        self.assertEqual(token, "shpat_new")
        mint.assert_called_once_with(
            "teashop.myshopify.com", "client-id", "client-secret"
        )
        stored = SalesChannelConnection.objects.get(pk=self.connection.pk)
        self.assertEqual(decrypt_token(stored.access_token_encrypted), "shpat_new")

    def test_valid_token_passes_through(self) -> None:
        from .integrations.pos_sync import ensure_fresh_shopify_token

        self.connection.token_expires_at = timezone.now() + timedelta(hours=12)
        self.connection.save(update_fields=["token_expires_at"])
        with patch(
            "forkluck.integrations.shopify.client_credentials_token"
        ) as mint:
            token = ensure_fresh_shopify_token(self.connection)
        self.assertEqual(token, "shpat_old")
        mint.assert_not_called()

    def test_legacy_token_connection_never_mints(self) -> None:
        from .integrations.pos_sync import ensure_fresh_shopify_token

        legacy = SalesChannelConnection.objects.create(
            user=User.objects.create_user(
                email="legacy@example.com",
                name="Legacy",
                password="a-long-test-passphrase-2468",
            ),
            provider="shopify",
            access_token_encrypted=encrypt_token("shpat_legacy"),
            shop_domain="old.myshopify.com",
        )
        with patch(
            "forkluck.integrations.shopify.client_credentials_token"
        ) as mint:
            token = ensure_fresh_shopify_token(legacy)
        self.assertEqual(token, "shpat_legacy")
        mint.assert_not_called()

    def test_auth_failure_marks_needs_reconnect(self) -> None:
        from .integrations.pos_sync import ensure_fresh_shopify_token

        with patch(
            "forkluck.integrations.shopify.client_credentials_token",
            side_effect=shopify.ShopifyAuthError("dead"),
        ):
            with self.assertRaises(SyncFailed):
                ensure_fresh_shopify_token(self.connection)
        stored = SalesChannelConnection.objects.get(pk=self.connection.pk)
        self.assertEqual(stored.status, "needs_reconnect")


@override_settings(SHOPIFY_API_SECRET="shp-secret")
class ShopifyClientTests(TestCase):
    # HMAC-SHA256 of "code=c&shop=s.myshopify.com&state=x" keyed with
    # b"shp-secret". Pinned as a literal on purpose: recomputing it with the
    # implementation's own code path would pass even if that path were wrong.
    KNOWN_GOOD_HMAC = (
        "95f181e2edda077f8ec169c80c2846729b59151b29925cf5a95efa073d6aa322"
    )

    def test_hmac_verification(self) -> None:
        params = {"shop": "s.myshopify.com", "code": "c", "state": "x"}
        self.assertTrue(
            shopify.verify_callback_hmac(
                {**params, "hmac": self.KNOWN_GOOD_HMAC}
            )
        )
        self.assertFalse(
            shopify.verify_callback_hmac({**params, "hmac": "bad"})
        )
        # Sorting is part of the signed message, not an accident of dict order.
        self.assertTrue(
            shopify.verify_callback_hmac(
                {
                    "state": "x",
                    "code": "c",
                    "shop": "s.myshopify.com",
                    "hmac": self.KNOWN_GOOD_HMAC,
                }
            )
        )
        # A tampered parameter breaks the signature.
        self.assertFalse(
            shopify.verify_callback_hmac(
                {**params, "shop": "other.myshopify.com", "hmac": self.KNOWN_GOOD_HMAC}
            )
        )

    def test_graphql_retries_throttled_then_succeeds(self) -> None:
        responses = [
            {"errors": [{"extensions": {"code": "THROTTLED"}}]},
            {"data": {"ok": True}},
        ]
        with (
            patch(
                "forkluck.integrations.shopify._post_json", side_effect=responses
            ) as post,
            patch("forkluck.integrations.shopify.time.sleep") as sleep,
        ):
            data = shopify.graphql("s.myshopify.com", "tok", "query", {})
        self.assertEqual(data, {"ok": True})
        self.assertEqual(post.call_count, 2)
        sleep.assert_called_once()

    def test_graphql_error_never_reads_as_empty(self) -> None:
        with patch(
            "forkluck.integrations.shopify._post_json",
            return_value={"errors": [{"message": "boom"}]},
        ):
            with self.assertRaises(shopify.ShopifyError):
                shopify.graphql("s.myshopify.com", "tok", "query", {})

    def test_graphql_no_data_no_errors_raises(self) -> None:
        with patch("forkluck.integrations.shopify._post_json", return_value={}):
            with self.assertRaises(shopify.ShopifyError):
                shopify.graphql("s.myshopify.com", "tok", "query", {})


class TokenCryptoKeyIdTests(TestCase):
    """External review: a ':' in the key id writes undecryptable envelopes."""

    def test_key_id_with_colon_is_rejected(self) -> None:
        with patch.dict(
            "os.environ", {"FORKLUCK_TOKEN_ENCRYPTION_KEY_ID": "prod:2026"}
        ):
            with self.assertRaises(TokenCryptoError):
                encrypt_token("secret")

    def test_overlong_key_id_is_rejected(self) -> None:
        with patch.dict(
            "os.environ", {"FORKLUCK_TOKEN_ENCRYPTION_KEY_ID": "k" * 65}
        ):
            with self.assertRaises(TokenCryptoError):
                encrypt_token("secret")

    def test_rotation_key_id_with_colon_is_rejected(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "FORKLUCK_TOKEN_ENCRYPTION_KEYS": json.dumps(
                    {"old:key": "bb" * 32}
                )
            },
        ):
            with self.assertRaises(TokenCryptoError):
                encrypt_token("secret")


class ActionDispatcherCryptoTests(TestCase):
    """External review: TokenCryptoError escaped the dispatcher as a 500."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="crypto@example.com",
            name="Crypto Tester",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)

    def test_token_crypto_error_becomes_a_friendly_400(self) -> None:
        with (
            patch(
                "forkluck.integrations.shopify.fetch_token_info",
                return_value={
                    "timezone": "UTC",
                    "currency": "USD",
                    "scopes": ["read_orders"],
                },
            ),
            patch(
                "forkluck.integrations.pos_sync.encrypt_token",
                side_effect=TokenCryptoError(
                    "FORKLUCK_TOKEN_ENCRYPTION_KEY is not set"
                ),
            ),
        ):
            response = self.client.post(
                "/internal/v1/actions/connect-shopify-token/",
                data=json.dumps(
                    {
                        "shopDomain": "teashop.myshopify.com",
                        "accessToken": "shpat_abcdefghij",
                    }
                ),
                content_type="application/json",
                HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
            )
        self.assertEqual(response.status_code, 400)
        message = response.json()["error"]
        self.assertIn("Reconnect the channel in Settings", message)
        # The raw detail names env vars and key ids — it must not leak.
        self.assertNotIn("FORKLUCK_TOKEN_ENCRYPTION_KEY", message)


@SQUARE_APP
class SquareLocationSelectionTests(PosOAuthTestCase):
    """External review: inactive locations and the 10-location search cap."""

    @patch("forkluck.integrations.square.list_locations")
    @patch("forkluck.integrations.square.exchange_code")
    def test_inactive_locations_are_not_stored(self, exchange, locations) -> None:
        exchange.return_value = {"access_token": "tok", "merchant_id": "M1"}
        locations.return_value = [
            {
                "id": "L_CLOSED",
                "name": "Closed",
                "timezone": "UTC",
                "currency": "EUR",
                "status": "INACTIVE",
            },
            {
                "id": "L_MAIN",
                "name": "Main",
                "timezone": "America/New_York",
                "currency": "USD",
                "status": "ACTIVE",
            },
        ]
        state = self.minted_state("/api/integrations/square/connect")
        self.client.get(
            "/api/integrations/square/callback", {"state": state, "code": "c"}
        )
        connection = SalesChannelConnection.objects.get(
            user=self.user, provider="square"
        )
        self.assertEqual(connection.location_ids, ["L_MAIN"])
        # Timezone/currency come from the first ACTIVE location, not [0].
        self.assertEqual(connection.provider_timezone, "America/New_York")
        self.assertEqual(connection.currency_code, "USD")

    def test_search_page_enforces_the_location_cap(self) -> None:
        location_ids = [f"L{index}" for index in range(10)]
        payloads: list[dict] = []

        def fake_request(path, *, method="POST", payload=None, token=None, timeout=15):
            payloads.append(payload)
            return {"orders": [{"id": "o1"}], "cursor": "next"}

        with patch(
            "forkluck.integrations.square._request", side_effect=fake_request
        ):
            orders, cursor = square.search_orders_page(
                "tok",
                location_ids,
                field="closed_at",
                start_at="2026-08-01T00:00:00Z",
                end_at="2026-08-09T00:00:00Z",
            )
        self.assertEqual(payloads[0]["location_ids"], location_ids)
        self.assertEqual(orders, [{"id": "o1"}])
        self.assertEqual(cursor, "next")
        with self.assertRaisesRegex(ValueError, "1-10 locations"):
            square.search_orders_page(
                "tok",
                [f"L{index}" for index in range(11)],
                field="closed_at",
                start_at="2026-08-01T00:00:00Z",
                end_at="2026-08-09T00:00:00Z",
            )


class ShopifyNestedPaginationTests(TestCase):
    """External review: nested agreements/sales connections were truncated."""

    def setUp(self) -> None:
        product_catalog = patch(
            "forkluck.integrations.shopify.list_catalog_items", return_value=[]
        )
        product_catalog.start()
        self.addCleanup(product_catalog.stop)
        self.user = User.objects.create_user(
            email="nested@example.com",
            name="Nested Tester",
            password="a-long-test-passphrase-2468",
        )
        self.connection = SalesChannelConnection.objects.create(
            user=self.user,
            provider="shopify",
            access_token_encrypted=encrypt_token("shp-tok"),
            shop_domain="teashop.myshopify.com",
            provider_timezone="UTC",
            currency_code="USD",
        )

    def test_agreements_are_followed_by_their_own_cursor(self) -> None:
        first = shopify_order([SHOPIFY_SALE])
        first["agreements"]["pageInfo"] = {
            "hasNextPage": True,
            "endCursor": "cur-1",
        }
        second_agreement = {
            "id": "a2",
            "happenedAt": "2026-08-02T10:05:00Z",
            "sales": {
                "nodes": [SHOPIFY_SALE],
                "pageInfo": {"hasNextPage": False},
            },
        }
        responses = [
            {
                "orders": {
                    "nodes": [first],
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                }
            },
            {
                "order": {
                    "id": "gid://shopify/Order/1",
                    "agreements": {
                        "nodes": [second_agreement],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    },
                }
            },
        ]
        pages: list[list[dict]] = []
        with patch(
            "forkluck.integrations.shopify.graphql", side_effect=responses
        ) as call:
            shopify.fetch_sales_agreements(
                "teashop.myshopify.com",
                "tok",
                since_iso="2026-08-01T00:00:00Z",
                on_page=lambda nodes: pages.append(nodes) or True,
            )
        self.assertEqual(call.call_count, 2)
        self.assertEqual(call.call_args_list[1].args[2],
                         shopify.ORDER_AGREEMENTS_QUERY)
        self.assertEqual(call.call_args_list[1].args[3]["after"], "cur-1")
        agreements = pages[0][0]["agreements"]
        self.assertEqual([node["id"] for node in agreements["nodes"]], ["a1", "a2"])
        self.assertFalse(agreements["pageInfo"]["hasNextPage"])

    def test_expired_budget_does_not_start_another_agreement_walk(self) -> None:
        first = shopify_order([SHOPIFY_SALE])
        first["agreements"]["pageInfo"] = {
            "hasNextPage": True,
            "endCursor": "cur-1",
        }
        pending = shopify_order([SHOPIFY_SALE])
        pending["id"] = "gid://shopify/Order/2"
        pending["agreements"]["pageInfo"] = {
            "hasNextPage": True,
            "endCursor": "cur-2",
        }
        responses = [
            {
                "orders": {
                    "nodes": [first, pending],
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                }
            },
            {
                "order": {
                    "id": first["id"],
                    "agreements": {
                        "nodes": [],
                        "pageInfo": {
                            "hasNextPage": False,
                            "endCursor": None,
                        },
                    },
                }
            },
        ]
        pages: list[list[dict]] = []
        with patch(
            "forkluck.integrations.shopify.graphql", side_effect=responses
        ) as graphql:
            shopify.fetch_sales_agreements(
                "teashop.myshopify.com",
                "tok",
                since_iso="2026-08-01T00:00:00Z",
                on_page=lambda nodes: pages.append(nodes) or False,
                should_continue=lambda: False,
            )
        self.assertEqual(graphql.call_count, 2)
        self.assertFalse(pages[0][0]["agreements"]["pageInfo"]["hasNextPage"])
        self.assertTrue(pages[0][1]["agreements"]["pageInfo"]["hasNextPage"])

    def test_expired_budget_still_completes_first_agreement_walk(self) -> None:
        pending = shopify_order([SHOPIFY_SALE])
        pending["agreements"]["pageInfo"] = {
            "hasNextPage": True,
            "endCursor": "cur-1",
        }
        responses = [
            {
                "orders": {
                    "nodes": [pending],
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                }
            },
            {
                "order": {
                    "id": pending["id"],
                    "agreements": {
                        "nodes": [],
                        "pageInfo": {
                            "hasNextPage": False,
                            "endCursor": None,
                        },
                    },
                }
            },
        ]
        pages: list[list[dict]] = []
        with patch(
            "forkluck.integrations.shopify.graphql", side_effect=responses
        ) as graphql:
            shopify.fetch_sales_agreements(
                "teashop.myshopify.com",
                "tok",
                since_iso="2026-08-01T00:00:00Z",
                on_page=lambda nodes: pages.append(nodes) or False,
                should_continue=lambda: False,
            )
        self.assertEqual(graphql.call_count, 2)
        self.assertFalse(
            pages[0][0]["agreements"]["pageInfo"]["hasNextPage"]
        )

    def test_test_order_does_not_consume_first_agreement_walk(self) -> None:
        test_order = shopify_order([SHOPIFY_SALE], test=True)
        test_order["agreements"]["pageInfo"] = {
            "hasNextPage": True,
            "endCursor": "test-cur",
        }
        real_order = shopify_order([SHOPIFY_SALE])
        real_order["id"] = "gid://shopify/Order/2"
        real_order["agreements"]["pageInfo"] = {
            "hasNextPage": True,
            "endCursor": "real-cur",
        }
        responses = [
            {
                "orders": {
                    "nodes": [test_order, real_order],
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                }
            },
            {
                "order": {
                    "id": real_order["id"],
                    "agreements": {
                        "nodes": [],
                        "pageInfo": {
                            "hasNextPage": False,
                            "endCursor": None,
                        },
                    },
                }
            },
        ]
        pages: list[list[dict]] = []
        with patch(
            "forkluck.integrations.shopify.graphql", side_effect=responses
        ) as graphql:
            shopify.fetch_sales_agreements(
                "teashop.myshopify.com",
                "tok",
                since_iso="2026-08-01T00:00:00Z",
                on_page=lambda nodes: pages.append(nodes) or False,
                should_continue=lambda: False,
            )

        self.assertEqual(graphql.call_count, 2)
        self.assertTrue(
            pages[0][0]["agreements"]["pageInfo"]["hasNextPage"]
        )
        self.assertFalse(
            pages[0][1]["agreements"]["pageInfo"]["hasNextPage"]
        )

    def test_replayed_boundary_does_not_consume_first_agreement_walk(self) -> None:
        boundary = shopify_order([SHOPIFY_SALE])
        boundary["updatedAt"] = "2026-08-01T00:00:00Z"
        boundary["agreements"]["pageInfo"] = {
            "hasNextPage": True,
            "endCursor": "boundary-cur",
        }
        pending = shopify_order([SHOPIFY_SALE])
        pending["id"] = "gid://shopify/Order/2"
        pending["agreements"]["pageInfo"] = {
            "hasNextPage": True,
            "endCursor": "pending-cur",
        }
        responses = [
            {
                "orders": {
                    "nodes": [boundary, pending],
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                }
            },
            {
                "order": {
                    "id": boundary["id"],
                    "agreements": {
                        "nodes": [],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    },
                }
            },
            {
                "order": {
                    "id": pending["id"],
                    "agreements": {
                        "nodes": [],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    },
                }
            },
        ]
        pages: list[list[dict]] = []
        with patch(
            "forkluck.integrations.shopify.graphql", side_effect=responses
        ) as graphql:
            shopify.fetch_sales_agreements(
                "teashop.myshopify.com",
                "tok",
                since_iso="2026-08-01T00:00:00+00:00",
                on_page=lambda nodes: pages.append(nodes) or False,
                should_continue=lambda: False,
            )

        self.assertEqual(graphql.call_count, 3)
        self.assertFalse(
            pages[0][0]["agreements"]["pageInfo"]["hasNextPage"]
        )
        self.assertFalse(
            pages[0][1]["agreements"]["pageInfo"]["hasNextPage"]
        )

    def run_sync(self, nodes: list[dict]) -> dict:
        def fake_fetch(shop, token, *, since_iso, on_page, **kwargs):
            on_page(nodes)

        with patch(
            "forkluck.integrations.shopify.fetch_sales_agreements",
            side_effect=fake_fetch,
        ):
            return sync_connection(self.connection)

    def test_truncated_sales_stop_the_watermark_before_that_order(self) -> None:
        early = shopify_order([SHOPIFY_SALE])
        early["id"] = "gid://shopify/Order/0"
        early["name"] = "#1000"
        early["updatedAt"] = "2026-08-02T08:00:00Z"
        truncated = shopify_order([SHOPIFY_SALE])
        truncated["agreements"]["nodes"][0]["sales"]["pageInfo"] = {
            "hasNextPage": True
        }
        receipt = self.run_sync([early, truncated])
        self.assertEqual(receipt["warnings"], 1)
        self.assertTrue(receipt["partial"])
        self.connection.refresh_from_db()
        # Stops on the last order read in full, so the truncated one is re-read.
        self.assertEqual(
            self.connection.sync_watermark.isoformat(),
            "2026-08-02T08:00:00+00:00",
        )
        self.assertIsNone(self.connection.backfilled_at)

    def test_truncation_on_the_first_order_leaves_the_watermark_alone(self) -> None:
        truncated = shopify_order([SHOPIFY_SALE])
        truncated["agreements"]["nodes"][0]["sales"]["pageInfo"] = {
            "hasNextPage": True
        }
        receipt = self.run_sync([truncated])
        self.assertEqual(receipt["warnings"], 1)
        self.connection.refresh_from_db()
        self.assertIsNone(self.connection.sync_watermark)


class SyncFailureModeTests(TestCase):
    """External review: auth failures, concurrency, and the location cap."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="fail@example.com",
            name="Fail Tester",
            password="a-long-test-passphrase-2468",
        )
        self.shopify = SalesChannelConnection.objects.create(
            user=self.user,
            provider="shopify",
            access_token_encrypted=encrypt_token("shp-tok"),
            shop_domain="teashop.myshopify.com",
            provider_timezone="UTC",
            currency_code="USD",
        )
        self.square = SalesChannelConnection.objects.create(
            user=self.user,
            provider="square",
            access_token_encrypted=encrypt_token("tok"),
            location_ids=[f"L{index}" for index in range(12)],
            provider_timezone="UTC",
            currency_code="USD",
        )

    def test_shopify_auth_error_flips_needs_reconnect(self) -> None:
        with patch(
            "forkluck.integrations.shopify.fetch_sales_agreements",
            side_effect=shopify.ShopifyAuthError("nope"),
        ):
            with self.assertRaises(SyncFailed):
                sync_connection(self.shopify)
        self.shopify.refresh_from_db()
        self.assertEqual(self.shopify.status, "needs_reconnect")
        self.assertIn("Reconnect", self.shopify.last_error)

    def test_plain_shopify_error_leaves_the_connection_active(self) -> None:
        with patch(
            "forkluck.integrations.shopify.fetch_sales_agreements",
            side_effect=shopify.ShopifyError("Shopify could not be reached"),
        ):
            with self.assertRaises(SyncFailed):
                sync_connection(self.shopify)
        self.shopify.refresh_from_db()
        self.assertEqual(self.shopify.status, "active")
        self.assertIsNone(self.shopify.sync_lease_token)
        self.assertIsNone(self.shopify.sync_lease_started_at)

    def test_active_sync_is_rejected_before_contacting_shopify(self) -> None:
        self.shopify.sync_lease_token = uuid.uuid4()
        self.shopify.sync_lease_started_at = timezone.now()
        self.shopify.save(
            update_fields=["sync_lease_token", "sync_lease_started_at"]
        )
        with patch(
            "forkluck.integrations.shopify.fetch_sales_agreements"
        ) as fetch:
            with self.assertRaises(SyncFailed) as caught:
                sync_connection(self.shopify)
        self.assertIn("already running", str(caught.exception))
        fetch.assert_not_called()

    def test_stale_sync_lease_is_recovered_and_released(self) -> None:
        self.shopify.sync_lease_token = uuid.uuid4()
        self.shopify.sync_lease_started_at = timezone.now() - timedelta(
            minutes=16
        )
        self.shopify.save(
            update_fields=["sync_lease_token", "sync_lease_started_at"]
        )

        def fake_fetch(shop, token, *, since_iso, on_page, **kwargs):
            on_page([])

        with patch(
            "forkluck.integrations.shopify.fetch_sales_agreements",
            side_effect=fake_fetch,
        ):
            sync_connection(self.shopify)
        self.shopify.refresh_from_db()
        self.assertIsNone(self.shopify.sync_lease_token)
        self.assertIsNone(self.shopify.sync_lease_started_at)

    def test_concurrent_write_becomes_a_friendly_failure(self) -> None:
        def fake_fetch(shop, token, *, since_iso, on_page, **kwargs):
            on_page([shopify_order([SHOPIFY_SALE])])

        with (
            patch(
                "forkluck.integrations.shopify.fetch_sales_agreements",
                side_effect=fake_fetch,
            ),
            patch(
                "forkluck.domains.sales.pos_sync.SalesLine.objects.bulk_create",
                side_effect=IntegrityError("duplicate fingerprint"),
            ),
        ):
            with self.assertRaises(SyncFailed) as caught:
                sync_connection(self.shopify)
        self.assertIn("already running", str(caught.exception))

    def test_square_session_resumes_each_location_chunk_exactly_once(self) -> None:
        locations = [
            {"id": f"L{index}", "timezone": "UTC", "currency": "USD"}
            for index in range(23)
        ]
        chunks: list[list[str]] = []

        def fake_search(
            token, location_ids, *, field, start_at, end_at, cursor=None
        ):
            chunks.append(location_ids)
            return [], None

        with (
            patch(
                "forkluck.integrations.square.search_orders_page",
                side_effect=fake_search,
            ),
            patch(
                "forkluck.integrations.square.list_locations",
                return_value=locations,
            ) as list_locations,
            patch(
                "forkluck.integrations.pos_sync.PAGE_CAP",
                1,
            ),
            patch(
                "forkluck.integrations.square.batch_retrieve_catalog", return_value={}
            ),
        ):
            first = sync_connection(self.square)
            second = sync_connection(self.square, pass_count=2)
            final = sync_connection(self.square, pass_count=3)
        self.assertTrue(first["partial"])
        self.assertTrue(second["partial"])
        self.assertFalse(final["partial"])
        self.assertEqual([len(chunk) for chunk in chunks], [10, 10, 3])
        list_locations.assert_called_once()
        self.square.refresh_from_db()
        self.assertEqual(self.square.sync_cursor, {})
        self.assertIsNotNone(self.square.sync_watermark)

    def test_square_cursor_chunks_cover_one_ten_and_eleven_locations(self) -> None:
        for count, expected in ((1, [1]), (10, [10]), (11, [10, 1])):
            with self.subTest(count=count):
                adapter = SquareSalesAdapter(self.square)
                adapter.token = "tok"
                locations = [
                    {
                        "id": f"X{index}",
                        "timezone": "UTC",
                        "currency": "USD",
                    }
                    for index in range(count)
                ]
                with patch(
                    "forkluck.integrations.square.list_locations",
                    return_value=locations,
                ):
                    cursor = adapter._session_cursor(
                        since=timezone.now() - timedelta(days=2),
                        until=timezone.now(),
                        backfilling=True,
                    )
                self.assertEqual(
                    [len(chunk["locationIds"]) for chunk in cursor["chunks"]],
                    expected,
                )

    def test_repeated_square_provider_cursor_stops_without_advancing(self) -> None:
        self.square.sync_cursor = {
            "version": 1,
            "provider": "square",
            "endAt": timezone.now().isoformat(),
            "locationIds": ["L0"],
            "locationTimezones": {"L0": "UTC"},
            "chunks": [
                {
                    "locationIds": ["L0"],
                    "field": "closed_at",
                    "startAt": (timezone.now() - timedelta(days=2)).isoformat(),
                    "providerCursor": "same",
                }
            ],
            "chunkIndex": 0,
        }
        self.square.save(update_fields=["sync_cursor"])
        with patch(
            "forkluck.integrations.square.search_orders_page",
            return_value=([], "same"),
        ):
            with self.assertRaisesRegex(SyncFailed, "repeated"):
                sync_connection(self.square, pass_count=2)
        self.square.refresh_from_db()
        self.assertEqual(
            self.square.sync_cursor["chunks"][0]["providerCursor"], "same"
        )
        self.assertIsNone(self.square.sync_lease_token)

    def test_square_lines_use_each_locations_calendar_date(self) -> None:
        instant = "2026-08-01T03:00:00Z"
        new_york = square_order(
            [square_line(uid="ny")], order_id="ny-order", closed_at=instant
        )
        new_york["location_id"] = "NY"
        tokyo = square_order(
            [square_line(uid="tokyo")],
            order_id="tokyo-order",
            closed_at=instant,
        )
        tokyo["location_id"] = "TOKYO"
        locations = [
            {
                "id": "NY",
                "timezone": "America/New_York",
                "currency": "USD",
            },
            {"id": "TOKYO", "timezone": "Asia/Tokyo", "currency": "USD"},
        ]
        with (
            patch(
                "forkluck.integrations.square.list_locations",
                return_value=locations,
            ),
            patch(
                "forkluck.integrations.square.search_orders_page",
                return_value=([new_york, tokyo], None),
            ),
            patch(
                "forkluck.integrations.square.batch_retrieve_catalog",
                return_value={},
            ),
        ):
            sync_connection(self.square)
        lines = {
            line.location: line
            for line in SalesLine.objects.filter(user=self.user)
        }
        self.assertEqual(lines["NY"].timezone, "America/New_York")
        self.assertEqual(lines["NY"].sold_on.isoformat(), "2026-07-31")
        self.assertEqual(lines["TOKYO"].timezone, "Asia/Tokyo")
        self.assertEqual(lines["TOKYO"].sold_on.isoformat(), "2026-08-01")
        sales_import = SalesImport.objects.get(user=self.user)
        self.assertEqual(sales_import.period_start.isoformat(), "2026-07-31")
        self.assertEqual(sales_import.period_end.isoformat(), "2026-08-01")

        locations[1]["timezone"] = "America/Los_Angeles"
        with (
            patch(
                "forkluck.integrations.square.list_locations",
                return_value=locations,
            ),
            patch(
                "forkluck.integrations.square.search_orders_page",
                return_value=([], None),
            ),
            patch(
                "forkluck.integrations.square.batch_retrieve_catalog",
                return_value={},
            ),
        ):
            sync_connection(self.square)
        lines["TOKYO"].refresh_from_db()
        sales_import.refresh_from_db()
        self.assertEqual(lines["TOKYO"].timezone, "America/Los_Angeles")
        self.assertEqual(lines["TOKYO"].sold_on.isoformat(), "2026-07-31")
        self.assertEqual(sales_import.period_end.isoformat(), "2026-07-31")


@SQUARE_APP
@SHOPIFY_APP
class PosOAuthSlotTests(PosOAuthTestCase):
    """External review: one session slot let a second connect clobber the
    first, and an unconfigured encryption key 500'd mid-callback."""

    @patch("forkluck.integrations.square.list_locations", return_value=[])
    @patch("forkluck.integrations.square.exchange_code")
    def test_parallel_connects_keep_their_own_nonce(
        self, exchange, _locations
    ) -> None:
        exchange.return_value = {"access_token": "tok", "merchant_id": "M1"}
        square_state = self.minted_state("/api/integrations/square/connect")
        # A Shopify connect started in another tab must not consume the
        # Square nonce.
        self.minted_state(
            "/api/integrations/shopify/connect?shop=teashop.myshopify.com"
        )
        response = self.client.get(
            "/api/integrations/square/callback",
            {"state": square_state, "code": "c"},
        )
        self.assertEqual(
            response["Location"], "/integrations/sales/connections?connected=square"
        )

    @patch("forkluck.integrations.square.list_locations", return_value=[])
    @patch("forkluck.integrations.square.exchange_code")
    def test_unconfigured_encryption_redirects_instead_of_500(
        self, exchange, _locations
    ) -> None:
        exchange.return_value = {"access_token": "tok", "merchant_id": "M1"}
        state = self.minted_state("/api/integrations/square/connect")
        with patch(
            "forkluck.integrations.pos_oauth.encrypt_token",
            side_effect=TokenCryptoError("no key"),
        ):
            response = self.client.get(
                "/api/integrations/square/callback", {"state": state, "code": "c"}
            )
        self.assertIn("integration_error=not_configured", response["Location"])
        self.assertFalse(SalesChannelConnection.objects.exists())


def shopify_sale(
    *,
    sale_id: str,
    name: str,
    variant_id: str = "",
    product_id: str = "",
    variant_title: str = "",
    sku: str = "",
    quantity: int = 1,
    total: str = "10.00",
    action_type: str = "ORDER",
    group_id: str = "",
) -> dict:
    line_item: dict = {"id": f"li-{sale_id}", "name": name, "sku": sku,
                       "variantTitle": variant_title}
    if variant_id:
        line_item["variant"] = {"id": variant_id}
    if product_id:
        line_item["product"] = {"id": product_id}
    if group_id:
        line_item["lineItemGroup"] = {"id": group_id}
    return {
        "id": sale_id,
        "actionType": action_type,
        "lineType": "PRODUCT",
        "quantity": quantity,
        "totalAmount": {"shopMoney": {"amount": total, "currencyCode": "USD"}},
        "totalDiscountAmountBeforeTaxes": {"shopMoney": {"amount": "0.00"}},
        "totalTaxAmount": {"shopMoney": {"amount": "0.00"}},
        "lineItem": line_item,
    }


class ShopifyIdentityTests(TestCase):
    """Spec tests 78, 79, 86, 88: stable Shopify catalog identity."""

    COOKIE_VARIANT = "gid://shopify/ProductVariant/11"
    BOX_VARIANT = "gid://shopify/ProductVariant/12"
    COOKIE_PRODUCT = "gid://shopify/Product/9"

    def setUp(self) -> None:
        product_catalog = patch(
            "forkluck.integrations.shopify.list_catalog_items", return_value=[]
        )
        product_catalog.start()
        self.addCleanup(product_catalog.stop)
        self.user = User.objects.create_user(
            email="shop-identity@example.com",
            name="Shop Identity Tester",
            password="a-long-test-passphrase-2468",
        )
        self.cookie = SalesProduct.objects.create(
            user=self.user, name="Cookie", normalized_name="cookie"
        )
        self.connection = SalesChannelConnection.objects.create(
            user=self.user,
            provider="shopify",
            access_token_encrypted=encrypt_token("shp-tok"),
            shop_domain="teashop.myshopify.com",
            provider_timezone="UTC",
            currency_code="USD",
        )
        self.order_seq = 0

    def make_variant(self, **overrides) -> SalesProductVariant:
        fields = {
            "user": self.user,
            "product": self.cookie,
            "channel": "shopify",
            "match_key": f"shopify:item:{self.COOKIE_VARIANT}",
            "external_name": "Cookie",
            "external_object_id": self.COOKIE_VARIANT,
        }
        fields.update(overrides)
        return SalesProductVariant.objects.create(**fields)

    def order(self, sales: list[dict], **overrides) -> dict:
        self.order_seq += 1
        node = shopify_order(sales)
        node["id"] = f"gid://shopify/Order/{self.order_seq}"
        node["name"] = f"#100{self.order_seq}"
        node.update(overrides)
        return node

    def run_sync(self, nodes: list[dict]) -> dict:
        def fake_fetch(shop, token, *, since_iso, on_page, **kwargs):
            on_page(nodes)

        with patch(
            "forkluck.integrations.shopify.fetch_sales_agreements",
            side_effect=fake_fetch,
        ):
            return sync_connection(self.connection)

    # 78, 86 -------------------------------------------------------------

    def test_shopify_variant_id_survives_product_rename(self) -> None:
        variant = self.make_variant()
        self.run_sync(
            [
                self.order(
                    [
                        shopify_sale(
                            sale_id="s1",
                            name="Cookie",
                            variant_id=self.COOKIE_VARIANT,
                            product_id=self.COOKIE_PRODUCT,
                        )
                    ]
                )
            ]
        )
        self.connection.sync_watermark = None
        self.run_sync(
            [
                self.order(
                    [
                        shopify_sale(
                            sale_id="s2",
                            name="Cookie (New Recipe)",
                            variant_id=self.COOKIE_VARIANT,
                            product_id=self.COOKIE_PRODUCT,
                        )
                    ]
                )
            ]
        )
        lines = list(SalesLine.objects.filter(user=self.user))
        self.assertEqual(len(lines), 2)
        self.assertEqual({line.variant_id for line in lines}, {variant.id})
        self.assertEqual({line.external_object_id for line in lines},
                         {self.COOKIE_VARIANT})
        # The order-scoped line-item id is audit data only, never identity.
        self.assertEqual(
            {line.source_payload["lineItemId"] for line in lines},
            {"li-s1", "li-s2"},
        )

    def test_shopify_subscription_title_change_does_not_create_new_identity(
        self,
    ) -> None:
        variant = self.make_variant()
        self.run_sync(
            [
                self.order(
                    [
                        shopify_sale(
                            sale_id="s1",
                            name="Cookie Subscription",
                            variant_id=self.COOKIE_VARIANT,
                        )
                    ]
                )
            ]
        )
        self.connection.sync_watermark = None
        self.run_sync(
            [
                self.order(
                    [
                        shopify_sale(
                            sale_id="s2",
                            name="Cookie Subscription — Auto renew (2 boxes)",
                            variant_id=self.COOKIE_VARIANT,
                        )
                    ]
                )
            ]
        )
        self.assertEqual(
            SalesProductVariant.objects.filter(user=self.user).count(), 1
        )
        self.assertEqual(
            set(
                SalesLine.objects.filter(user=self.user).values_list(
                    "variant_id", flat=True
                )
            ),
            {variant.id},
        )

    def test_shopify_sale_id_deduplicates_a_changed_replay(self) -> None:
        self.make_variant()
        first = self.order(
            [
                shopify_sale(
                    sale_id="gid://shopify/Sale/1",
                    name="Cookie",
                    variant_id=self.COOKIE_VARIANT,
                    total="10.00",
                )
            ]
        )
        replay = self.order(
            [
                shopify_sale(
                    sale_id="gid://shopify/Sale/1",
                    name="Cookie renamed",
                    variant_id=self.COOKIE_VARIANT,
                    total="12.00",
                )
            ]
        )
        self.run_sync([first])
        receipt = self.run_sync([replay])
        self.assertEqual(receipt["imported"], 0)
        self.assertEqual(receipt["updated"], 1)
        self.assertEqual(receipt["deduplicated"], 0)
        self.assertIsNone(receipt["batchId"])
        line = SalesLine.objects.get(user=self.user)
        self.assertEqual(line.provider_record_id, "gid://shopify/Sale/1")
        self.assertEqual(line.item_name, "Cookie renamed")
        self.assertEqual(line.net_sales_cents, 1200)
        self.assertEqual(SalesImport.objects.count(), 1)
        self.assertEqual(SalesImport.objects.get().net_sales_cents, 1200)

    def test_identical_shopify_sales_with_distinct_ids_are_both_stored(self) -> None:
        self.make_variant()
        receipt = self.run_sync(
            [
                self.order(
                    [
                        shopify_sale(
                            sale_id="gid://shopify/Sale/1",
                            name="Cookie",
                            variant_id=self.COOKIE_VARIANT,
                        ),
                        shopify_sale(
                            sale_id="gid://shopify/Sale/2",
                            name="Cookie",
                            variant_id=self.COOKIE_VARIANT,
                        ),
                    ]
                )
            ]
        )
        self.assertEqual(receipt["imported"], 2)
        self.assertEqual(
            set(
                SalesLine.objects.filter(user=self.user).values_list(
                    "provider_record_id", flat=True
                )
            ),
            {"gid://shopify/Sale/1", "gid://shopify/Sale/2"},
        )

    # 79 -----------------------------------------------------------------

    def test_shopify_variants_with_same_title_can_have_different_multipliers(
        self,
    ) -> None:
        single = self.make_variant(quantity_multiplier=Decimal("1"))
        box = self.make_variant(
            match_key=f"shopify:item:{self.BOX_VARIANT}",
            external_object_id=self.BOX_VARIANT,
            external_variant_title="Default",
            quantity_multiplier=Decimal("6"),
        )
        self.run_sync(
            [
                self.order(
                    [
                        shopify_sale(
                            sale_id="s1",
                            name="Cookie",
                            variant_title="Default",
                            variant_id=self.COOKIE_VARIANT,
                        ),
                        shopify_sale(
                            sale_id="s2",
                            name="Cookie",
                            variant_title="Default",
                            variant_id=self.BOX_VARIANT,
                        ),
                    ]
                )
            ]
        )
        by_variant = {
            line.external_object_id: line
            for line in SalesLine.objects.filter(user=self.user)
        }
        self.assertEqual(
            by_variant[self.COOKIE_VARIANT].variant_id, single.id
        )
        self.assertEqual(by_variant[self.BOX_VARIANT].variant_id, box.id)
        self.assertEqual(
            [
                (c.product.name, c.quantity)
                for c in interpreted_components(by_variant[self.BOX_VARIANT])
            ],
            [("Cookie", Decimal("6.000"))],
        )

    def test_shopify_product_id_and_variant_title_resolve_without_variant_id(
        self,
    ) -> None:
        variant = self.make_variant(
            match_key=f"shopify:item:{self.COOKIE_PRODUCT}",
            external_object_id=self.COOKIE_PRODUCT,
            external_variant_title="Large",
        )
        self.run_sync(
            [
                self.order(
                    [
                        shopify_sale(
                            sale_id="s1",
                            name="Renamed Cookie",
                            variant_title="Large",
                            product_id=self.COOKIE_PRODUCT,
                        )
                    ]
                )
            ]
        )
        line = SalesLine.objects.get(user=self.user)
        self.assertEqual(line.variant_id, variant.id)
        self.assertEqual(line.source_payload["productObjectId"],
                         self.COOKIE_PRODUCT)

    # 88 -----------------------------------------------------------------

    def test_shopify_fulfillment_status_does_not_change_financial_sales_totals(
        self,
    ) -> None:
        self.make_variant()
        # The ledger query must never filter or branch on fulfillment: kitchen
        # demand is a separate read model (spec).
        self.assertNotIn("fulfillment", shopify.ORDERS_QUERY.casefold())
        self.assertNotIn(
            "fulfillment", shopify.ORDER_AGREEMENTS_QUERY.casefold()
        )
        receipt = self.run_sync(
            [
                self.order(
                    [
                        shopify_sale(
                            sale_id="s1",
                            name="Cookie",
                            variant_id=self.COOKIE_VARIANT,
                            total="10.00",
                        )
                    ],
                    displayFulfillmentStatus="UNFULFILLED",
                ),
                self.order(
                    [
                        shopify_sale(
                            sale_id="s2",
                            name="Cookie",
                            variant_id=self.COOKIE_VARIANT,
                            total="10.00",
                        )
                    ],
                    displayFulfillmentStatus="FULFILLED",
                ),
            ]
        )
        self.assertEqual(receipt["imported"], 2)
        lines = SalesLine.objects.filter(user=self.user)
        self.assertEqual(sum(line.net_sales_cents for line in lines), 2000)
        self.assertEqual({line.fulfillment_status for line in lines}, {""})

    # bundle identity is preserved, not interpreted (Phase 5) --------------

    def test_shopify_bundle_group_id_is_preserved_as_a_raw_fact(self) -> None:
        self.make_variant()
        entries, _ = shopify_order_entries(
            self.order(
                [
                    shopify_sale(
                        sale_id="s1",
                        name="Cookie",
                        variant_id=self.COOKIE_VARIANT,
                        group_id="gid://shopify/LineItemGroup/7",
                    )
                ]
            ),
            self.connection,
        )
        self.assertEqual(
            entries[0]["source_payload"]["lineItemGroupId"],
            "gid://shopify/LineItemGroup/7",
        )


class ShopifyApiVersionTests(TestCase):
    """Spec test 96: the pinned Admin API version must be supported, and a
    fall-forward must be visible."""

    def test_shopify_client_targets_supported_api_version(self) -> None:
        self.assertRegex(shopify.API_VERSION, r"^\d{4}-(01|04|07|10)$")
        self.assertGreaterEqual(
            shopify.API_VERSION,
            shopify.MIN_SUPPORTED_API_VERSION,
        )
        # 2025-07 was retired on 2026-07-16.
        self.assertNotEqual(shopify.API_VERSION, "2025-07")

    def test_served_api_version_header_is_captured(self) -> None:
        class FakeResponse:
            headers = {"X-Shopify-API-Version": "2026-10"}

            def read(self) -> bytes:
                return json.dumps({"data": {"shop": {}}}).encode()

            def __enter__(self):
                return self

            def __exit__(self, *args) -> bool:
                return False

        with patch("urllib.request.urlopen", return_value=FakeResponse()):
            with self.assertLogs("forkluck.integrations.shopify", "WARNING") as logs:
                shopify.graphql("s.myshopify.com", "tok", "query { shop { id } }", {})
        self.assertEqual(shopify.last_served_api_version(), "2026-10")
        self.assertTrue(any("2026-10" in message for message in logs.output))
        self.assertFalse(any("tok" in message for message in logs.output))

    def test_denied_field_scope_falls_back_to_the_basic_query(self) -> None:
        queries: list[str] = []

        def fake_graphql(shop, token, query, variables):
            queries.append(query)
            if len(queries) == 1:
                raise shopify.ShopifyFieldAccessError("denied")
            return {"orders": {"nodes": [], "pageInfo": {"hasNextPage": False}}}

        with patch("forkluck.integrations.shopify.graphql", side_effect=fake_graphql):
            shopify.fetch_sales_agreements(
                "s.myshopify.com",
                "tok",
                since_iso="2026-08-01T00:00:00+00:00",
                on_page=lambda nodes: True,
            )
        self.assertIn("variant { id }", queries[0])
        self.assertNotIn("variant { id }", queries[1])


class SyncLeaseSerializationTests(TestCase):
    def test_claiming_a_lease_takes_the_workspace_lock(self) -> None:
        # SQLite cannot exercise the blocking; what this pins is that lease
        # acquisition shares the matcher's serialization point, so a claim
        # either lands before the lease check or waits out the decision.
        from unittest import mock as mock_module

        from .domains.sales import pos_sync as pos_sync_domain

        user = User.objects.create_user(
            email="lease-lock@example.com", password="test-password"
        )
        connection = SalesChannelConnection.objects.create(
            user=user,
            provider="square",
            provider_account_id="M1",
            access_token_encrypted="unused-in-test",
        )
        locked = []
        original = pos_sync_domain.lock_workspace
        with mock_module.patch.object(
            pos_sync_domain,
            "lock_workspace",
            side_effect=lambda target: locked.append(target.pk)
            or original(target),
        ):
            token = pos_sync_domain._claim_sync_lease(connection)

        self.assertIn(user.pk, locked)
        connection.refresh_from_db()
        self.assertEqual(connection.sync_lease_token, token)
