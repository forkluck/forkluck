from unittest.mock import patch
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase
from django.utils import timezone

from .domains.sales.core import item_object_match_key
from .domains.sales.pos_sync import sync_product_catalog
from .integrations import pos_sync as provider_sync
from .models import (
    SalesCatalogItem,
    SalesChannelConnection,
    SalesImport,
    SalesLine,
)


User = get_user_model()
shopify = provider_sync.shopify
square = provider_sync.square


class SquareProductCatalogClientTests(SimpleTestCase):
    @patch("forkluck.integrations.square._request")
    def test_variations_use_item_metadata_across_catalog_pages(self, request) -> None:
        request.side_effect = [
            {
                "objects": [
                    {
                        "type": "ITEM",
                        "id": "ITEM_LINZER",
                        "item_data": {
                            "name": "Cranberry Linzer",
                            "category_id": "CAT_COOKIE",
                            "variations": [
                                {
                                    "type": "ITEM_VARIATION",
                                    "id": "VAR_LINZER",
                                    "item_variation_data": {
                                        "name": "Box of six",
                                        "sku": "202320",
                                    },
                                }
                            ],
                        },
                    }
                ],
                "cursor": "next page",
            },
            {
                "objects": [
                    {
                        "type": "CATEGORY",
                        "id": "CAT_COOKIE",
                        "category_data": {"name": "Cookies"},
                    }
                ]
            },
        ]

        items = square.list_catalog_items("token")

        self.assertEqual(
            items,
            [
                {
                    "external_object_id": "VAR_LINZER",
                    "sku": "202320",
                    "item_name": "Cranberry Linzer",
                    "variant_name": "Box of six",
                    "category": "Cookies",
                    "is_active": True,
                }
            ],
        )
        self.assertIn("types=ITEM%2CCATEGORY", request.call_args.args[0])
        self.assertIn("cursor=next+page", request.call_args_list[1].args[0])

    @patch("forkluck.integrations.square._request")
    def test_error_response_is_not_treated_as_an_empty_catalog(self, request) -> None:
        request.return_value = {"errors": [{"code": "INTERNAL_SERVER_ERROR"}]}

        with self.assertRaisesRegex(square.SquareError, "catalog list failed"):
            square.list_catalog_items("token")


class ShopifyProductCatalogClientTests(SimpleTestCase):
    @patch("forkluck.integrations.shopify.graphql")
    def test_variants_paginate_with_product_metadata(self, graphql) -> None:
        graphql.side_effect = [
            {
                "productVariants": {
                    "nodes": [
                        {
                            "id": "gid://shopify/ProductVariant/1",
                            "sku": "202320",
                            "title": "Box of six",
                            "product": {
                                "title": "Cranberry Linzer",
                                "productType": "Cookies",
                                "status": "ACTIVE",
                                "category": {"name": "Food"},
                            },
                        }
                    ],
                    "pageInfo": {"hasNextPage": True, "endCursor": "cursor-1"},
                }
            },
            {
                "productVariants": {
                    "nodes": [
                        {
                            "id": "gid://shopify/ProductVariant/2",
                            "sku": "",
                            "title": "Default Title",
                            "product": {
                                "title": "Seasonal Bar",
                                "productType": "",
                                "status": "DRAFT",
                                "category": {"name": "Desserts"},
                            },
                        },
                        {
                            "id": "gid://shopify/ProductVariant/3",
                            "sku": "",
                            "title": "Archive pack",
                            "product": {
                                "title": "Retired cookie",
                                "productType": "Cookies",
                                "status": "ARCHIVED",
                                "category": {"name": "Food"},
                            },
                        }
                    ],
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                }
            },
        ]

        items = shopify.list_catalog_items("shop.myshopify.com", "token")

        self.assertEqual([row["external_object_id"] for row in items], [
            "gid://shopify/ProductVariant/1",
            "gid://shopify/ProductVariant/2",
            "gid://shopify/ProductVariant/3",
        ])
        self.assertEqual(items[0]["category"], "Cookies")
        self.assertEqual(items[1]["category"], "Desserts")
        self.assertTrue(items[1]["is_active"])
        self.assertTrue(items[2]["is_active"])
        self.assertIsNone(graphql.call_args_list[0].args[3]["after"])
        self.assertEqual(graphql.call_args_list[1].args[3]["after"], "cursor-1")

    @patch("forkluck.integrations.shopify.graphql")
    def test_missing_next_cursor_fails_the_entire_walk(self, graphql) -> None:
        graphql.return_value = {
            "productVariants": {
                "nodes": [],
                "pageInfo": {"hasNextPage": True, "endCursor": None},
            }
        }

        with self.assertRaisesRegex(shopify.ShopifyError, "omitted a cursor"):
            shopify.list_catalog_items("shop.myshopify.com", "token")

    @patch("forkluck.integrations.shopify.time.monotonic", return_value=10.0)
    @patch("forkluck.integrations.shopify._post_json")
    def test_catalog_deadline_caps_graphql_request_timeout(
        self, post_json, _monotonic
    ) -> None:
        post_json.return_value = {
            "data": {
                "productVariants": {
                    "nodes": [],
                    "pageInfo": {"hasNextPage": False},
                }
            }
        }

        shopify.list_catalog_items("shop.myshopify.com", "token", deadline=12.5)

        self.assertEqual(post_json.call_args.kwargs["timeout"], 2.5)

    @patch("forkluck.integrations.shopify.time.sleep")
    @patch("forkluck.integrations.shopify.time.monotonic", side_effect=[10.0, 14.0])
    @patch("forkluck.integrations.shopify._post_json")
    def test_deadline_refuses_a_throttle_sleep_that_cannot_finish(
        self, post_json, _monotonic, sleep
    ) -> None:
        post_json.return_value = {
            "errors": [{"extensions": {"code": "THROTTLED"}}]
        }

        with self.assertRaisesRegex(shopify.ShopifyError, "timed out"):
            shopify.graphql(
                "shop.myshopify.com", "token", "query", {}, deadline=15.0
            )

        sleep.assert_not_called()


class _CatalogAdapter:
    def __init__(self, items: list[dict] | Exception) -> None:
        self.items = items

    def product_catalog_items(self, *, deadline=None) -> list[dict]:
        if isinstance(self.items, Exception):
            raise self.items
        return self.items


class ProductCatalogSyncTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="catalog@example.com", password="test-password"
        )
        self.connection = SalesChannelConnection.objects.create(
            user=self.user,
            provider=SalesImport.Channel.SQUARE,
            merchant_id="M1",
            provider_account_id="M1",
            access_token_encrypted="unused-in-test",
        )

    def test_complete_walk_upserts_and_deactivates_only_current_account(self) -> None:
        stale = SalesCatalogItem.objects.create(
            user=self.user,
            channel=SalesImport.Channel.SQUARE,
            provider_account_id="M1",
            match_key=item_object_match_key(SalesImport.Channel.SQUARE, "OLD"),
            external_object_id="OLD",
            item_name="Old cookie",
            last_seen_at=self.connection.created_at,
        )
        other_account = SalesCatalogItem.objects.create(
            user=self.user,
            channel=SalesImport.Channel.SQUARE,
            provider_account_id="M0",
            match_key=item_object_match_key(SalesImport.Channel.SQUARE, "OLD"),
            external_object_id="OLD",
            item_name="Former merchant cookie",
            last_seen_at=self.connection.created_at,
        )

        receipt = sync_product_catalog(
            self.connection,
            adapter=_CatalogAdapter(
                [
                    {
                        "external_object_id": "VAR_LINZER",
                        "sku": "202320",
                        "item_name": "Cranberry Linzer",
                        "variant_name": "Box of six",
                        "category": "Cookies",
                        "is_active": True,
                    }
                ]
            ),
        )

        self.assertEqual(receipt["itemCount"], 1)
        current = SalesCatalogItem.objects.get(
            provider_account_id="M1", external_object_id="VAR_LINZER"
        )
        self.assertEqual(
            current.match_key,
            item_object_match_key(SalesImport.Channel.SQUARE, "VAR_LINZER"),
        )
        self.assertEqual(current.sku, "202320")
        sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="Square API",
            source=SalesImport.Source.API,
            channel=SalesImport.Channel.SQUARE,
            provider_account_id="M1",
        )
        sales_line = SalesLine.objects.create(
            user=self.user,
            sales_import=sales_import,
            channel=SalesImport.Channel.SQUARE,
            provider_account_id="M1",
            source_position=1,
            source_fingerprint="catalog-identity-collapse",
            external_order_id="ORDER-1",
            sold_at=timezone.now(),
            item_name="Older display name",
            group_key=current.match_key,
            match_key=current.match_key,
            quantity=Decimal("1"),
        )
        self.assertEqual(sales_line.match_key, current.match_key)
        stale.refresh_from_db()
        other_account.refresh_from_db()
        self.assertFalse(stale.is_active)
        self.assertTrue(other_account.is_active)
        self.connection.refresh_from_db()
        self.assertIsNotNone(self.connection.product_catalog_synced_at)

    def test_failed_walk_retains_prior_catalog_without_deactivation(self) -> None:
        catalog_item = SalesCatalogItem.objects.create(
            user=self.user,
            channel=SalesImport.Channel.SHOPIFY,
            provider_account_id="shop.myshopify.com",
            match_key=item_object_match_key(
                SalesImport.Channel.SHOPIFY, "gid://shopify/ProductVariant/1"
            ),
            external_object_id="gid://shopify/ProductVariant/1",
            item_name="Still here",
            last_seen_at=self.connection.created_at,
        )
        self.connection.provider = SalesImport.Channel.SHOPIFY
        self.connection.provider_account_id = "shop.myshopify.com"
        self.connection.save(update_fields=["provider", "provider_account_id", "updated_at"])

        with self.assertRaisesRegex(RuntimeError, "provider outage"):
            sync_product_catalog(
                self.connection, adapter=_CatalogAdapter(RuntimeError("provider outage"))
            )

        catalog_item.refresh_from_db()
        self.assertTrue(catalog_item.is_active)
        self.connection.refresh_from_db()
        self.assertIsNone(self.connection.product_catalog_synced_at)

    def test_catalog_sync_holds_the_workspace_lock_with_the_matcher(self) -> None:
        # SQLite cannot exercise the blocking; what this pins is that the
        # snapshot write and the matching decision share the workspace lock,
        # so the other provider's job cannot replace its snapshot between the
        # two.
        from .domains.sales import pos_sync as pos_sync_domain

        locked = []
        original = pos_sync_domain.lock_workspace
        with patch.object(
            pos_sync_domain,
            "lock_workspace",
            side_effect=lambda user: locked.append(user.pk) or original(user),
        ):
            sync_product_catalog(self.connection, adapter=_CatalogAdapter([]))

        self.assertIn(self.user.pk, locked)

    def test_replacing_the_account_forgets_the_old_catalog_fetch(self) -> None:
        # A replacement account's stale snapshots cannot vouch for SKU
        # uniqueness; carrying the old fetch stamp over would let them.
        from .integrations.pos_oauth import save_connection

        self.connection.product_catalog_synced_at = timezone.now()
        self.connection.save(update_fields=["product_catalog_synced_at"])

        replaced = save_connection(
            self.user,
            SalesImport.Channel.SQUARE,
            {
                "merchant_id": "M2",
                "access_token_encrypted": "unused-in-test",
                "provider_timezone": "UTC",
                "currency_code": "USD",
            },
        )

        self.assertEqual(replaced.provider_account_id, "M2")
        self.assertIsNone(replaced.product_catalog_synced_at)
