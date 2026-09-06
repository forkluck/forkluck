from unittest.mock import patch
from datetime import timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from .integrations import square
from .models import (
    SalesChannelConnection,
    SalesProductVariant,
    SalesImport,
    SalesLine,
    SalesLineModifier,
    SalesModifierList,
    SalesModifierOption,
    SalesProduct,
)
from .domains.sales.pos_sync import sync_square_modifier_catalog
from .domains.sales.core import (
    action_associate_sales_modifier_options,
    action_save_sales_modifier_associations,
    menu_overview_payload,
    modifier_object_match_key,
)


User = get_user_model()


class SquareModifierCatalogClientTests(TestCase):
    @patch("forkluck.integrations.square._request")
    def test_list_modifier_lists_paginates_and_normalizes(self, request) -> None:
        request.side_effect = [
            {
                "objects": [
                    {
                        "type": "MODIFIER_LIST",
                        "id": "LIST_FLIGHT",
                        "modifier_list_data": {
                            "name": "Snack Flight",
                            "selection_type": "MULTIPLE",
                            "allow_quantities": True,
                            "min_selected_modifiers": 3,
                            "max_selected_modifiers": 3,
                            "modifiers": [
                                {
                                    "type": "MODIFIER",
                                    "id": "MOD_LINZER",
                                    "modifier_data": {
                                        "name": "Pineapple Linzer",
                                        "ordinal": 2,
                                        "price_money": {
                                            "amount": 0,
                                            "currency": "USD",
                                        },
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
                        "type": "MODIFIER_LIST",
                        "id": "LIST_NOTE",
                        "modifier_list_data": {
                            "name": "Order note",
                            "modifier_type": "TEXT",
                        },
                    }
                ]
            },
        ]

        result = square.list_modifier_lists("token")

        self.assertEqual([row["name"] for row in result], ["Snack Flight", "Order note"])
        self.assertEqual(result[0]["min_selected"], 3)
        self.assertEqual(result[0]["max_selected"], 3)
        self.assertTrue(result[0]["allow_quantities"])
        self.assertEqual(result[0]["options"][0]["price_cents"], 0)
        self.assertEqual(result[1]["modifier_type"], "text")
        self.assertIn("cursor=next+page", request.call_args_list[1].args[0])

    @patch("forkluck.integrations.square.time_module.monotonic")
    @patch("forkluck.integrations.square._request")
    def test_list_modifier_lists_stops_paging_at_deadline(
        self, request, monotonic
    ) -> None:
        monotonic.side_effect = [1.0, 5.0]
        request.return_value = {"objects": [], "cursor": "next page"}

        with self.assertRaisesRegex(square.SquareError, "timed out"):
            square.list_modifier_lists("token", deadline=5.0)

        request.assert_called_once()
        self.assertEqual(request.call_args.kwargs["timeout"], 4.0)


class ModifierCatalogTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="modifier@example.com", password="test-password"
        )
        self.connection = SalesChannelConnection.objects.create(
            user=self.user,
            provider=SalesImport.Channel.SQUARE,
            access_token_encrypted="unused-in-test",
            provider_timezone="America/New_York",
            currency_code="USD",
        )

    def test_overview_reports_both_sync_times_for_staleness(self) -> None:
        # The modifiers page compares the two: a sales sync stamped later than
        # the catalog is how it knows the catalog step was skipped or failed.
        catalog_at = timezone.now() - timedelta(hours=2)
        sales_at = timezone.now()
        SalesChannelConnection.objects.filter(pk=self.connection.pk).update(
            modifier_catalog_synced_at=catalog_at, last_synced_at=sales_at
        )

        catalog = menu_overview_payload(self.user)["modifierCatalog"]

        self.assertTrue(catalog["squareConnected"])
        self.assertEqual(catalog["squareSyncedAt"], catalog_at.isoformat())
        self.assertEqual(catalog["squareSalesSyncedAt"], sales_at.isoformat())

    def test_overview_reports_no_sales_sync_before_the_first_run(self) -> None:
        catalog = menu_overview_payload(self.user)["modifierCatalog"]

        self.assertIsNone(catalog["squareSyncedAt"])
        self.assertIsNone(catalog["squareSalesSyncedAt"])

    @patch("forkluck.integrations.pos_sync.square.list_modifier_lists")
    @patch("forkluck.integrations.pos_sync.ensure_fresh_square_token", return_value="token")
    def test_square_import_persists_lists_and_soft_deactivates_missing_options(
        self, _token, list_modifier_lists
    ) -> None:
        list_modifier_lists.return_value = [
            {
                "external_object_id": "LIST_FLIGHT",
                "name": "Snack Flight",
                "modifier_type": "list",
                "selection_type": "multiple",
                "ordinal": 1,
                "allow_quantities": False,
                "min_selected": 3,
                "max_selected": 3,
                "options": [
                    {
                        "external_object_id": "MOD_LINZER",
                        "name": "Pineapple Linzer",
                        "ordinal": 1,
                        "price_cents": 0,
                        "currency_code": "USD",
                    }
                ],
            }
        ]

        receipt = sync_square_modifier_catalog(self.connection)

        self.assertEqual(receipt["listCount"], 1)
        self.assertEqual(receipt["optionCount"], 1)
        modifier_list = SalesModifierList.objects.get()
        option = SalesModifierOption.objects.get()
        self.assertEqual(modifier_list.name, "Snack Flight")
        self.assertEqual(option.name, "Pineapple Linzer")
        self.connection.refresh_from_db()
        self.assertIsNotNone(self.connection.modifier_catalog_synced_at)

        list_modifier_lists.return_value[0]["options"] = []
        sync_square_modifier_catalog(self.connection)
        option.refresh_from_db()
        self.assertFalse(option.is_active)

    def test_catalog_only_shows_the_current_square_account(self) -> None:
        self.connection.merchant_id = "M1"
        self.connection.provider_account_id = "M1"
        self.connection.save(
            update_fields=["merchant_id", "provider_account_id", "updated_at"]
        )
        old_list = SalesModifierList.objects.create(
            user=self.user,
            channel=SalesImport.Channel.SQUARE,
            provider_account_id="M0",
            external_object_id="LIST_OLD",
            name="Old merchant modifiers",
            last_synced_at=self.connection.created_at,
        )
        SalesModifierOption.objects.create(
            modifier_list=old_list,
            external_object_id="MOD_OLD_CATALOG",
            name="Old catalog option",
        )
        current_list = SalesModifierList.objects.create(
            user=self.user,
            channel=SalesImport.Channel.SQUARE,
            provider_account_id="M1",
            external_object_id="LIST_CURRENT",
            name="Current merchant modifiers",
            last_synced_at=self.connection.created_at,
        )
        SalesModifierOption.objects.create(
            modifier_list=current_list,
            external_object_id="MOD_CURRENT_CATALOG",
            name="Current catalog option",
        )
        old_import = SalesImport.objects.create(
            user=self.user,
            file_name="Old Square API",
            source=SalesImport.Source.API,
            channel=SalesImport.Channel.SQUARE,
            provider_account_id="M0",
        )
        old_line = SalesLine.objects.create(
            user=self.user,
            sales_import=old_import,
            channel=SalesImport.Channel.SQUARE,
            provider_account_id="M0",
            source_position=1,
            source_fingerprint="old-account-line",
            external_order_id="old-order",
            sold_at=timezone.now(),
            item_name="Old parent",
            group_key="square:item:OLD_PARENT",
            match_key="square:item:OLD_PARENT",
            quantity=Decimal("1"),
        )
        SalesLineModifier.objects.create(
            user=self.user,
            sales_line=old_line,
            source_fingerprint="old-account-modifier",
            external_object_id="MOD_OLD_RECORD",
            name="Old historical option",
            match_key="square:modifier:OLD_PARENT:MOD_OLD_RECORD",
            quantity=Decimal("1"),
        )

        payload = menu_overview_payload(self.user)

        self.assertEqual(
            [row["name"] for row in payload["modifierCatalog"]["lists"]],
            ["Current merchant modifiers"],
        )
        self.assertEqual(payload["modifierCatalog"]["unassignedRecords"], [])
        self.assertEqual(
            [row["name"] for row in payload["review"]["modifiers"]],
            ["Old historical option"],
        )

    def test_association_maps_reassigns_and_unmaps_one_catalog_option(self) -> None:
        modifier_list = SalesModifierList.objects.create(
            user=self.user,
            channel=SalesImport.Channel.SQUARE,
            external_object_id="LIST_FLIGHT",
            name="Snack Flight",
            last_synced_at=self.connection.created_at,
        )
        option = SalesModifierOption.objects.create(
            modifier_list=modifier_list,
            external_object_id="MOD_LINZER",
            name="Pineapple Linzer",
        )
        linzer = SalesProduct.objects.create(
            user=self.user,
            name="Pineapple Linzer",
            normalized_name="pineapple linzer",
        )
        raspberry = SalesProduct.objects.create(
            user=self.user,
            name="Raspberry Linzer",
            normalized_name="raspberry linzer",
        )

        action_associate_sales_modifier_options(
            self.user,
            {"items": [{"optionId": str(option.id), "productId": str(linzer.id)}]},
        )
        variant = SalesProductVariant.objects.get()
        self.assertEqual(variant.product, linzer)
        self.assertEqual(
            variant.match_key,
            modifier_object_match_key("square", "MOD_LINZER"),
        )

        action_associate_sales_modifier_options(
            self.user,
            {
                "items": [
                    {"optionId": str(option.id), "productId": str(raspberry.id)}
                ]
            },
        )
        variant.refresh_from_db()
        self.assertEqual(variant.product, raspberry)

        payload = menu_overview_payload(self.user)
        catalog_option = payload["modifierCatalog"]["lists"][0]["options"][0]
        self.assertEqual(catalog_option["productId"], str(raspberry.id))

        action_associate_sales_modifier_options(
            self.user,
            {"items": [{"optionId": str(option.id), "productId": None}]},
        )
        self.assertFalse(SalesProductVariant.objects.exists())

    def test_retired_modifier_without_global_identity_stays_unassigned(
        self,
    ) -> None:
        modifier_list = SalesModifierList.objects.create(
            user=self.user,
            channel=SalesImport.Channel.SQUARE,
            external_object_id="LIST_FLIGHT",
            name="Snack Flight",
            last_synced_at=self.connection.created_at,
        )
        SalesModifierOption.objects.create(
            modifier_list=modifier_list,
            external_object_id="MOD_CURRENT",
            name="Pineapple Linzer (200120)",
        )
        sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="sales.csv",
            channel=SalesImport.Channel.SQUARE,
        )
        line = SalesLine.objects.create(
            user=self.user,
            sales_import=sales_import,
            channel=SalesImport.Channel.SQUARE,
            source_position=1,
            source_fingerprint="line-history",
            external_order_id="order-history",
            sold_at=timezone.now(),
            item_name="Snack Flight",
            external_object_id="PARENT_FLIGHT",
            group_key="square:item:PARENT_FLIGHT",
            quantity=Decimal("1"),
        )
        SalesLineModifier.objects.create(
            user=self.user,
            sales_line=line,
            source_fingerprint="modifier-history",
            external_object_id="MOD_RETIRED",
            name="Kumquat Cake (203402)",
            match_key="square:modifier:PARENT_FLIGHT:MOD_RETIRED",
            quantity=Decimal("1"),
        )

        payload = menu_overview_payload(self.user)

        records = payload["modifierCatalog"]["lists"][0]["records"]
        self.assertEqual(records, [])
        self.assertEqual(
            [
                row["name"]
                for row in payload["modifierCatalog"]["unassignedRecords"]
            ],
            ["Kumquat Cake (203402)"],
        )

    def test_grouped_association_maps_current_and_retired_square_ids(self) -> None:
        modifier_list = SalesModifierList.objects.create(
            user=self.user,
            channel=SalesImport.Channel.SQUARE,
            external_object_id="LIST_FLIGHT",
            name="Snack Flight",
            last_synced_at=self.connection.created_at,
        )
        options = [
            SalesModifierOption.objects.create(
                modifier_list=modifier_list,
                external_object_id=external_id,
                name="Pineapple Linzer (200120)",
                ordinal=index,
            )
            for index, external_id in enumerate(["MOD_CURRENT_1", "MOD_CURRENT_2"])
        ]
        product = SalesProduct.objects.create(
            user=self.user,
            name="Pineapple Linzer",
            normalized_name="pineapple linzer",
        )
        sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="sales.csv",
            channel=SalesImport.Channel.SQUARE,
        )
        line = SalesLine.objects.create(
            user=self.user,
            sales_import=sales_import,
            channel=SalesImport.Channel.SQUARE,
            source_position=1,
            source_fingerprint="line-grouped",
            external_order_id="order-grouped",
            sold_at=timezone.now(),
            item_name="Snack Flight",
            external_object_id="PARENT_FLIGHT",
            group_key="square:item:PARENT_FLIGHT",
            quantity=Decimal("1"),
        )
        occurrence = SalesLineModifier.objects.create(
            user=self.user,
            sales_line=line,
            source_fingerprint="modifier-grouped",
            external_object_id="MOD_RETIRED",
            name="Pineapple Linzer (200120)",
            match_key="square:modifier:PARENT_FLIGHT:MOD_RETIRED",
            quantity=Decimal("1"),
        )

        action_save_sales_modifier_associations(
            self.user,
            {
                "options": [
                    {"optionId": str(option.id), "productId": str(product.id)}
                    for option in options
                ],
                "records": [
                    {
                        "matchKey": occurrence.match_key,
                        "externalName": occurrence.name,
                        "decision": "associate",
                        "productId": str(product.id),
                    }
                ],
            },
        )

        occurrence.refresh_from_db()
        self.assertEqual(occurrence.variant.product_id, product.id)
        self.assertEqual(
            SalesProductVariant.objects.filter(
                user=self.user,
                identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
                product=product,
            ).count(),
            3,
        )
        payload = menu_overview_payload(self.user)
        historical = payload["modifierCatalog"]["lists"][0]["records"]
        self.assertEqual(historical[0]["productId"], str(product.id))

        action_save_sales_modifier_associations(
            self.user,
            {
                "records": [
                    {
                        "matchKey": historical[0]["matchKey"],
                        "externalName": historical[0]["name"],
                        "decision": "unassociate",
                        "productId": None,
                    }
                ]
            },
        )
        occurrence.refresh_from_db()
        self.assertIsNone(occurrence.variant_id)

        action_save_sales_modifier_associations(
            self.user,
            {
                "records": [
                    {
                        "matchKey": occurrence.match_key,
                        "externalName": occurrence.name,
                        "decision": "ignore",
                        "productId": None,
                    }
                ]
            },
        )
        self.assertEqual(menu_overview_payload(self.user)["review"]["modifierReviewCount"], 0)
