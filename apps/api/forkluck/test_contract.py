"""Frozen pins for the internal HTTP contract.

Everything asserted here is consumed by the Next.js layer. The point is that
these tests fail loudly when a route, an action slug, a handler wiring, or a
JSON key path changes, so the change has to be deliberate and propagated.
When one of them breaks, update the pin, `apps/web/lib/backend/types.ts`, and
`docs/CONTRACT.md` in the same change.

Serializer shapes are pinned recursively as sorted key *paths*: a nested
object contributes `parent.child`, and a list contributes `parent[].child`
taken from its first element. Fixtures below are deliberately rich enough
that every nested collection is non-empty, otherwise a list would collapse
to a bare leaf and stop guarding its element shape.
"""

import json
import re
import uuid
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from unittest import mock

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured, ValidationError
from django.db.models import Count
from django.db.utils import IntegrityError
from django.test import TestCase, override_settings
from django.utils import timezone

from . import internal_urls, master_prices, public_urls
from .domains.sales import connections as sales_connections
from .domains.sales import core as sales
from .domains.accounts import billing as accounts_billing
from .domains.accounts import serializers as accounts
from .domains.ingredients import serializers as ingredients
from .domains.ingredients import views as ingredient_views
from .domains.invoices import serializers as invoices
from .domains.invoices import views as invoice_views
from .domains.labor import serializers as labor
from .domains.recipes import actions as recipe_actions
from .domains.recipes import serializers as recipes
from .domains.recipes import views as recipe_views
from .domains.recipes.health import (
    RecipeHealthReadModel,
    menu_recipe_rows,
    menu_detail_payload,
    menu_sources_payload,
)
from .domains.search import serializers as search
from .domains.workspace import views as workspace_views
from .domains.shared.pagination import BrowseQuery, paginated_payload
from .http import dispatch
from .models import (
    BenchCostRecipe,
    BenchCostStep,
    BenchCostTiming,
    CatalogIngredient,
    CatalogIngredientAllergen,
    CatalogIngredientMeasure,
    CatalogProduct,
    Employee,
    EmployeeHourlyRate,
    ExpenseCategory,
    Ingredient,
    IngredientAllergenStatus,
    IngredientConversion,
    IngredientImport,
    IngredientMeasure,
    IngredientPrice,
    Invoice,
    InvoiceLine,
    LaborImport,
    Menu,
    MenuItem,
    NutritionRequest,
    Preparation,
    Recipe,
    RecipeCategory,
    RecipeEquivalency,
    RecipeExternalRef,
    RecipeItem,
    RecipeStep,
    RecipeTiming,
    SalesChannelConnection,
    SalesProductVariant,
    SalesIgnoreRule,
    SalesImport,
    SalesProduct,
    SalesProductComponent,
    SalesProductSku,
    SalesSkuIgnore,
    Supplier,
    SupplierItem,
    SupplierItemIgnore,
    TimeEntry,
    User,
)
from .integrations.token_crypto import TokenCryptoError
from .testing import CONTRACT_MESSAGE, ShapeAssertions, internal_payload, key_paths

from .paths import ROOT as REPO_ROOT


# Slug -> handler function name. A bare set of slugs would not catch a slug
# rewired to the wrong handler, which is the failure mode a refactor makes
# easy, so the wiring itself is frozen.
EXPECTED_ACTIONS: dict[str, str] = {
    "add-timing": "action_add_timing",
    "adopt-catalog-price": "action_adopt_catalog_price",
    "activate-catalog-ingredient": "action_activate_catalog_ingredient",
    "adopt-master-price": "action_adopt_master_price",
    "archive-ingredient": "action_archive_ingredient",
    "associate-sales-modifier-options": "action_associate_sales_modifier_options",
    "connect-connector": "action_connect_connector",
    "complete-connector-authorization": "action_complete_connector_authorization",
    "connect-shopify-credentials": "action_connect_shopify_credentials",
    "connect-shopify-token": "action_connect_shopify_token",
    "connect-square-token": "action_connect_square_token",
    "create-billing-portal": "action_create_billing_portal",
    "create-step": "action_create_step",
    "create-stripe-checkout": "action_create_stripe_checkout",
    "currency-conversion-quote": "action_currency_conversion_quote",
    "delete-anthropic-key": "action_delete_anthropic_key",
    "delete-expense-category": "action_delete_expense_category",
    "delete-payment-method": "action_delete_payment_method",
    "delete-ingredient": "action_delete_ingredient",
    "delete-ingredient-category": "action_delete_ingredient_category",
    "clear-ingredient-nutrition": "action_clear_ingredient_nutrition",
    "commit-recipe-paste": "action_commit_recipe_paste",
    "delete-invoice": "action_delete_invoice",
    "review-invoice-line": "action_review_invoice_line",
    "delete-kitchen-data": "action_delete_kitchen_data",
    "reset-guest-links": "action_reset_guest_links",
    "invite-kitchen-member": "action_invite_kitchen_member",
    "update-kitchen-member": "action_update_kitchen_member",
    "remove-kitchen-member": "action_remove_kitchen_member",
    "remove-kitchen-invite": "action_remove_kitchen_invite",
    "delete-menu": "action_delete_menu",
    "delete-recipe": "action_delete_recipe",
    "delete-recipe-category": "action_delete_recipe_category",
    "delete-recipe-external-ref": "action_delete_recipe_external_ref",
    "delete-sales-ignore-rule": "action_delete_sales_ignore_rule",
    "delete-sales-product": "action_delete_sales_product",
    "delete-step": "action_delete_step",
    "delete-timing": "action_delete_timing",
    "disconnect-connector": "action_disconnect_connector",
    "disconnect-pos": "action_disconnect_pos",
    "dismiss-master-price": "action_dismiss_master_price",
    "enqueue-connector-sync": "action_enqueue_connector_sync",
    "enqueue-pos-sync": "action_enqueue_pos_sync",
    "ignore-sales-category": "action_ignore_sales_category",
    "ignore-sales-modifiers": "action_ignore_sales_modifiers",
    "ignore-sales-skus": "action_ignore_sales_skus",
    "import-ingredients": "action_import_ingredients",
    "import-invoices": "action_import_invoices",
    "save-invoice": "action_save_invoice",
    "save-receipt-feedback": "action_save_receipt_feedback",
    "import-labor": "action_import_labor",
    "invoice-line-status": "action_invoice_line_status",
    "invoice-ai-usage": "action_invoice_ai_usage",
    "link-invoice-line": "action_link_invoice_line",
    "disconnect-invoice-line": "action_disconnect_invoice_line",
    "use-invoice-price": "action_use_invoice_price",
    "save-supplier": "action_save_supplier",
    "merge-suppliers": "action_merge_suppliers",
    "delete-supplier": "action_delete_supplier",
    "connect-drive-folder": "action_connect_drive_folder",
    "disconnect-drive-folder": "action_disconnect_drive_folder",
    "skip-drive-files": "action_skip_drive_files",
    "unskip-drive-file": "action_unskip_drive_file",
    "retry-drive-file": "action_retry_drive_file",
    "relink-supplier-item": "action_relink_supplier_item",
    "ignore-supplier-item": "action_ignore_supplier_item",
    "unignore-supplier-item": "action_unignore_supplier_item",
    "delete-supplier-item": "action_delete_supplier_item",
    "labor-import-status": "action_labor_import_status",
    "match-catalog-prices": "action_match_catalog_prices",
    "match-master-prices": "action_match_master_prices",
    "merge-ingredients": "action_merge_ingredients",
    "open-cost-for-recipe": "action_open_cost_for_recipe",
    "pos-connections-status": "action_pos_connections_status",
    "primo-archive-conversation": "action_primo_archive_conversation",
    "primo-delete-conversation": "action_primo_delete_conversation",
    "primo-rename-conversation": "action_primo_rename_conversation",
    "primo-feedback": "action_primo_feedback",
    "primo-attachment": "action_primo_attachment",
    "primo-save-turn": "action_primo_save_turn",
    "preview-sales-ignore-rule": "action_preview_sales_ignore_rule",
    "reinterpret-sales": "action_reinterpret_sales",
    "retry-pos-sync": "action_retry_pos_sync",
    "rename-ingredient-category": "action_rename_ingredient_category",
    "rename-recipe-category": "action_rename_recipe_category",
    "reorder-steps": "action_reorder_steps",
    "save-anthropic-key": "action_save_anthropic_key",
    "save-expense-category": "action_save_expense_category",
    "save-payment-method": "action_save_payment_method",
    "save-sales-ignore-rule": "action_save_sales_ignore_rule",
    "save-ingredient": "action_save_ingredient",
    "replace-ingredient-allergens": "action_replace_ingredient_allergens",
    "save-preparation": "action_save_preparation",
    "delete-preparations": "action_delete_preparations",
    "save-ingredient-conversion": "action_save_ingredient_conversion",
    "reset-ingredient-conversion": "action_reset_ingredient_conversion",
    "search-nutrition-foods": "action_search_nutrition_foods",
    "set-ingredient-nutrition": "action_set_ingredient_nutrition",
    "update-ingredient-nutrition-settings": "action_update_ingredient_nutrition_settings",
    "request-custom-nutrition": "action_request_custom_nutrition",
    "save-menu": "action_save_menu",
    "save-recipe": "action_save_recipe",
    "share-recipe": "action_share_recipe",
    "share-recipes": "action_share_recipes",
    "update-recipe-share": "action_update_recipe_share",
    "remove-recipe-share": "action_remove_recipe_share",
    "remove-recipe-guest-link": "action_remove_recipe_guest_link",
    "remove-recipe-book": "action_remove_recipe_book",
    "save-recipe-comment": "action_save_recipe_comment",
    "delete-recipe-comment": "action_delete_recipe_comment",
    "save-recipe-external-ref": "action_save_recipe_external_ref",
    "save-recipe-line-match": "action_save_recipe_line_match",
    "save-sales-modifier-associations": "action_save_sales_modifier_associations",
    "save-sales-product": "action_save_sales_product",
    "record-manual-sales": "action_record_manual_sales",
    "search-catalog-ingredients": "action_search_catalog_ingredients",
    "search-catalog-prices": "action_search_catalog_prices",
    "search-master-prices": "action_search_master_prices",
    "set-employee-active": "action_set_employee_active",
    "set-employee-excluded-from-cost": "action_set_employee_excluded_from_cost",
    "set-employee-rate": "action_set_employee_rate",
    "set-time-entry-rate": "action_set_time_entry_rate",
    "set-preferred-supplier-item": "action_set_preferred_supplier_item",
    "supplier-import-status": "action_supplier_import_status",
    "sync-stripe-subscription": "action_sync_stripe_subscription",
    "track-sales-modifiers": "action_track_sales_modifiers",
    "undo-ingredient-import": "action_undo_ingredient_import",
    "undo-labor-import": "action_undo_labor_import",
    "undo-recipe-paste": "action_undo_recipe_paste",
    "undo-sales-import": "action_undo_sales_import",
    "unignore-sales-modifiers": "action_unignore_sales_modifiers",
    "unignore-sales-skus": "action_unignore_sales_skus",
    "update-account": "action_update_account",
    "set-newsletter": "action_set_newsletter",
    "update-business-settings": "action_update_business_settings",
    "update-recipe-statuses": "action_update_recipe_statuses",
    "update-recipe-costing": "action_update_recipe_costing",
    "set-recipe-nutrition-serving": "action_set_recipe_nutrition_serving",
    "set-recipe-item-yield-after-cooking": "action_set_recipe_item_yield_after_cooking",
    "set-recipe-item-excluded-from-cost": "action_set_recipe_item_excluded_from_cost",
    "update-sales-variant-multiplier": "action_update_sales_variant_multiplier",
    "update-sales-variant-attribution": "action_update_sales_variant_attribution",
    "untrack-sales-variant": "action_untrack_sales_variant",
    "set-product-matching": "action_set_product_matching",
    "update-step": "action_update_step",
}


# Ordered (route string, url name). A list, not a set: duplicates and
# reordering both change routing behaviour and both must be visible.
EXPECTED_INTERNAL_ROUTES: list[tuple[str, str | None]] = [
    ("session/", None),
    ("auth-methods/", None),
    ("primo/conversations/", None),
    ("primo/conversations/<uuid:conversation_id>/", None),
    ("newsletter/", None),
    ("search-index/", None),
    ("ingredients/", None),
    ("ingredients/<str:ingredient_ref>/", None),
    ("ingredient-options/", None),
    ("ingredient-tags/", None),
    ("ingredient-categories/", None),
    ("ingredient-measures/", None),
    ("ingredient-duplicates/", None),
    ("ingredient-imports/", None),
    ("matches/", None),
    ("pricing-entries/", None),
    ("recipes/", None),
    ("recipe-health/", None),
    ("recipes-export/", None),
    ("dashboard-overview/", None),
    ("recipes/<str:recipe_ref>/cost-diff/", None),
    ("recipes/<str:recipe_ref>/", None),
    ("recipes/<str:recipe_ref>/nutrition/", None),
    ("guest/recipes/<str:token>/", None),
    ("guest/books/<str:token>/", None),
    ("recipe-categories/", None),
    ("cost-recipes/", None),
    ("cost-recipes/<str:recipe_ref>/", None),
    ("cost-for-recipe/<uuid:recipe_id>/", None),
    ("menus/", None),
    ("menu/<str:menu_ref>/", None),
    ("menu/<str:menu_ref>/forecast/", None),
    ("menu-sources/", None),
    ("menu-component-price/", None),
    ("business-settings/", None),
    ("activity/", None),
    ("kitchen-members/", None),
    ("labor-overview/", None),
    ("labor-employees/<uuid:employee_id>/", None),
    ("sales-overview/", None),
    ("sales-imports/", None),
    ("pos-connections/", None),
    ("pos-sync-runs/", None),
    ("pos-sync-runs/<uuid:sync_run_id>/", None),
    ("invoices-overview/", None),
    ("invoice-suppliers/", None),
    ("invoice-line-options/", None),
    ("payment-methods/", None),
    ("invoices/<uuid:invoice_id>/lines/", None),
    ("invoices/<str:public_id>/", None),
    ("ai-credential/", None),
    ("drive-folder/", None),
    ("drive-files/", None),
    ("supplier-items/", None),
    ("connector-sync-runs/", None),
    ("connector-sync-runs/<uuid:run_id>/", None),
    ("menu-overview/", None),
    ("menu-items/", None),
    ("menu-product-rows/", None),
    ("product/<str:product_ref>/", None),
    ("product-categories/", None),
    ("sales-identity-lines/", None),
    ("system/drive-watch/", None),
    ("system/invoice-ai-usage/", None),
    ("system/drive-watch/save/", None),
    ("system/drive-files/", None),
    ("system/invoice-line-status/", None),
    ("system/drive-extractions/", None),
    ("system/drive-extractions/failed/", None),
    ("actions/<slug:action_name>/", None),
]

EXPECTED_PUBLIC_ROUTES: list[tuple[str, str | None]] = [
    ("auth/feedback/authorize", None),
    ("auth/feedback/token", None),
    ("auth/feedback/profile", None),
    ("auth/csrf", "csrf"),
    ("auth/session", "public-session"),
    ("auth/register", "register"),
    ("auth/verify-email", "verify-email"),
    ("auth/resend-code", "resend-code"),
    ("auth/request-password-reset", "request-password-reset"),
    ("auth/reset-password", "reset-password"),
    ("auth/change-password", "change-password"),
    ("auth/login", "login"),
    ("auth/logout", "logout"),
    ("auth/google/start", None),
    ("auth/google/callback", None),
    ("integrations/square/connect", None),
    ("integrations/square/callback", None),
    ("integrations/shopify/connect", None),
    ("integrations/shopify/callback", None),
    ("integrations/connectors/callback", None),
    ("billing/stripe-webhook", "stripe-webhook"),
]

INTERNAL_URL_PREFIX = "internal/v1/"
PUBLIC_URL_PREFIX = "api/"


class ActionRegistryContractTests(TestCase):
    def test_action_wiring_is_frozen(self):
        wiring = {slug: handler.__name__ for slug, handler in dispatch.ACTIONS.items()}
        self.assertEqual(wiring, EXPECTED_ACTIONS, CONTRACT_MESSAGE)

    def test_every_action_handler_lives_in_a_domain(self):
        # urls -> dispatch -> domains -> integrations. A handler registered
        # from below the domain layer puts a tenant-scoped write where no
        # domain owns its scoping or its JSON shape, and the layers contract
        # cannot see it because integrations legitimately sits under
        # dispatch. Pin the direction here instead.
        misplaced = {
            slug: handler.__module__
            for slug, handler in dispatch.ACTIONS.items()
            if not handler.__module__.startswith("forkluck.domains.")
        }
        self.assertEqual(misplaced, {}, CONTRACT_MESSAGE)

    def test_slugs_are_url_safe(self):
        # The route captures <slug:action_name>; a slug outside that charset
        # would be silently unroutable.
        for slug in dispatch.ACTIONS:
            with self.subTest(action=slug):
                self.assertRegex(slug, r"^[-a-zA-Z0-9_]+$")

    def test_duplicate_action_slug_fails_with_both_registry_owners(self):
        def first_handler(user, body):
            return {}

        def second_handler(user, body):
            return {}

        registries = (
            ("ingredients", {"save-ingredient": first_handler}),
            ("sales", {"save-ingredient": second_handler}),
        )
        with mock.patch.object(dispatch, "REGISTRIES", registries):
            with self.assertRaisesRegex(
                ImproperlyConfigured,
                r"Action slug 'save-ingredient' is claimed by both ingredients and sales",
            ):
                dispatch._compose()


class UrlTableContractTests(TestCase):
    def assertRouteList(self, patterns, expected) -> None:
        actual = [
            (str(entry.pattern), getattr(entry, "name", None)) for entry in patterns
        ]
        self.assertEqual(actual, expected, CONTRACT_MESSAGE)

    def test_internal_routes_are_frozen(self):
        self.assertRouteList(internal_urls.urlpatterns, EXPECTED_INTERNAL_ROUTES)

    def test_public_routes_are_frozen(self):
        self.assertRouteList(public_urls.urlpatterns, EXPECTED_PUBLIC_ROUTES)

    def test_route_groups_are_mounted_under_their_prefixes(self):
        from config import urls as root_urls

        mounted = {
            str(entry.pattern): getattr(entry, "urlconf_name", None)
            for entry in root_urls.urlpatterns
            if hasattr(entry, "url_patterns")
        }
        self.assertIn(INTERNAL_URL_PREFIX, mounted, CONTRACT_MESSAGE)
        self.assertIn(PUBLIC_URL_PREFIX, mounted, CONTRACT_MESSAGE)
        self.assertIs(mounted[INTERNAL_URL_PREFIX], internal_urls)
        self.assertIs(mounted[PUBLIC_URL_PREFIX], public_urls)


class RecipeMethodContractTests(TestCase):
    """Method is always text; omitted or null input becomes blank text."""

    @classmethod
    def setUpTestData(cls) -> None:
        cls.user = User.objects.create_user(
            email="method-contract@example.com",
            password="a-long-test-passphrase-9753",
            name="Method Contract Chef",
        )

    def values(self, method=...):
        body = {
            "title": "Sugar",
            "body": "100 g Granulated sugar",
            "yieldAmount": None,
            "yieldUnit": "pcs",
            "menuPriceCents": None,
        }
        if method is not ...:
            body["method"] = method
        return recipe_actions.recipe_values(self.user, body)

    def test_missing_or_null_method_becomes_blank_text(self):
        self.assertEqual(self.values()["method"], "")
        self.assertEqual(self.values(None)["method"], "")

    def test_blank_or_nonblank_method_is_preserved(self):
        self.assertEqual(self.values("")["method"], "")
        self.assertEqual(self.values("Mix.")["method"], "Mix.")


class PricingEntriesTenantTests(TestCase):
    """The recipe editor's unpaginated read stays inside one tenant."""

    @classmethod
    def setUpTestData(cls) -> None:
        cls.users = []
        for index in (1, 2):
            user = User.objects.create_user(
                email=f"pricing-{index}@example.com",
                password="a-long-test-passphrase-1357",
                name=f"Pricing Chef {index}",
            )
            Ingredient.objects.create(
                user=user,
                name=f"Butter {index}",
                normalized_name=f"butter {index}",
                purchase_cost_cents=1200,
                purchase_size=1000,
                purchase_unit="g",
            )
            Recipe.objects.create(
                user=user, title=f"Croissant {index}", code=f"R{index}", body="Fold."
            )
            cls.users.append(user)

    def test_each_user_sees_only_their_own_rows(self):
        for index, user in enumerate(self.users, start=1):
            self.client.force_login(user)
            response = self.client.get(
                "/internal/v1/pricing-entries/",
                HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
            )
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(
                [row["name"] for row in payload["items"]], [f"Butter {index}"]
            )
            self.assertEqual(
                [row["title"] for row in payload["recipes"]], [f"Croissant {index}"]
            )

    def test_equivalencies_do_not_cost_a_query_each(self):
        user = self.users[0]
        for number in range(3):
            recipe = Recipe.objects.create(
                user=user, title=f"Curd {number}", code=f"C{number}", body="Stir."
            )
            RecipeEquivalency.objects.create(
                recipe=recipe,
                mass_amount=Decimal("700"),
                mass_unit="g",
                volume_amount=Decimal("2.75"),
                volume_unit="cup",
                standard=False,
            )
        with self.assertNumQueries(
            3,
            msg=(
                "The equivalency is select_related on the recipe read; one "
                "query per recipe means that was dropped."
            ),
        ):
            payload = internal_payload(ingredient_views.pricing_entries, user)
        equivalencies = [row["equivalency"] for row in payload["recipes"]]
        self.assertEqual(
            [one["massAmount"] for one in equivalencies if one], [700.0] * 3
        )


class SerializerContractTests(ShapeAssertions, TestCase):
    """One recursive key-path pin per serializer that reaches the frontend."""

    @classmethod
    def setUpTestData(cls) -> None:
        cls.user = User.objects.create_user(
            email="contract@example.com",
            password="a-long-test-passphrase-2468",
            name="Contract Chef",
        )
        cls.category = RecipeCategory.objects.create(
            user=cls.user, name="Pastry", normalized_name="pastry"
        )
        cls.recipe = Recipe.objects.create(
            user=cls.user,
            title="Croissant",
            code="R1",
            category=cls.category,
            body="Fold.",
            yield_amount=1200.0,
            yield_unit="g",
            sellable_yield=12.0,
            menu_price_cents=450,
        )
        cls.external_ref = RecipeExternalRef.objects.create(
            user=cls.user,
            recipe=cls.recipe,
            system=RecipeExternalRef.SYSTEM_SQUARE,
            ref_kind=RecipeExternalRef.KIND_ITEM,
            external_id="SQ-1",
        )
        cls.ingredient = Ingredient.objects.create(
            user=cls.user,
            name="Butter",
            normalized_name="butter",
            purchase_cost_cents=1200,
            purchase_size=1.0,
            purchase_unit="kg",
        )
        IngredientPrice.objects.create(
            ingredient=cls.ingredient,
            purchase_cost_cents=1200,
            purchase_size=1.0,
            purchase_unit="kg",
            effective_at=timezone.now(),
        )
        SupplierItem.objects.create(
            user=cls.user,
            ingredient=cls.ingredient,
            supplier="acme",
            external_id="ACME-1",
            title="Butter 1kg",
            raw_size="1 kg",
            pack_price_cents=1200,
            pack_grams=1000,
            pack_amount=1.0,
            pack_unit="kg",
            purchased_quantity=2.0,
            period_start=date(2026, 1, 1),
            period_end=date(2026, 1, 31),
            is_preferred=True,
        )
        cls.ingredient_import = IngredientImport.objects.create(
            user=cls.user, file_name="prices.csv", supplier="acme"
        )
        cls.cost_recipe = BenchCostRecipe.objects.create(
            user=cls.user, recipe=cls.recipe, name="Croissant cost", batch_yield=12
        )
        cls.step = BenchCostStep.objects.create(
            recipe=cls.cost_recipe, name="Laminate", covers=1, position=0
        )
        cls.timing = BenchCostTiming.objects.create(
            step=cls.step, seconds=600, yield_count=12
        )
        cls.labor_import = LaborImport.objects.create(
            user=cls.user, file_name="hours.csv"
        )
        cls.employee = Employee.objects.create(
            user=cls.user, name="Sam Baker", normalized_name="sam baker"
        )
        EmployeeHourlyRate.objects.create(
            employee=cls.employee,
            hourly_rate_cents=2500,
            effective_from=timezone.localdate() - timedelta(days=1),
        )
        clock_in = timezone.now() - timedelta(hours=8)
        cls.time_entry = TimeEntry.objects.create(
            user=cls.user,
            employee=cls.employee,
            labor_import=cls.labor_import,
            source_position=0,
            source_fingerprint="fp-1",
            clock_in=clock_in,
            clock_out=clock_in + timedelta(hours=6),
            paid_seconds=21600,
            hourly_rate_cents=2500,
            labor_cost_cents=15000,
        )
        cls.expense_category = ExpenseCategory.objects.create(
            user=cls.user, name="Dairy", normalized_name="dairy", is_ingredient=True
        )
        cls.supplier = Supplier.objects.create(
            user=cls.user,
            key="acme",
            name="Acme Foods",
            email="orders@acme.example",
            phone="555-0100",
            account_number="A-1",
            notes="Delivers Tuesdays.",
        )
        cls.invoice = Invoice.objects.create(
            user=cls.user,
            supplier="acme",
            supplier_name="Acme Foods",
            invoice_number="INV-1",
            invoice_date=date(2026, 1, 15),
            total_cents=12000,
            line_count=1,
            matched_line_count=1,
            source_fingerprint="invoice-fp-1",
            file_name="invoice.pdf",
        )
        cls.invoice_line = InvoiceLine.objects.create(
            user=cls.user,
            invoice=cls.invoice,
            position=0,
            sku="ACME-1",
            description="Butter 1kg",
            quantity=Decimal("2.000"),
            unit="case",
            pack_size="1 kg",
            unit_price_cents=1200,
            line_amount_cents=2400,
            category=cls.expense_category,
            ingredient=cls.ingredient,
        )
        cls.sales_import = SalesImport.objects.create(
            user=cls.user,
            file_name="sales.csv",
            channel=SalesImport.Channel.SQUARE,
        )
        cls.sales_product = SalesProduct.objects.create(
            user=cls.user, name="Croissant", normalized_name="croissant"
        )
        SalesProductComponent.objects.create(
            product=cls.sales_product, recipe=cls.recipe, quantity=Decimal("1.000")
        )
        SalesProductSku.objects.create(
            user=cls.user,
            product=cls.sales_product,
            sku="CROISSANT",
            normalized_sku="croissant",
        )
        cls.variant = SalesProductVariant.objects.create(
            user=cls.user,
            product=cls.sales_product,
            channel=SalesImport.Channel.SQUARE,
            match_key="sku:croissant",
            sku="croissant",
            external_name="Croissant",
        )
        cls.sku_ignore = SalesSkuIgnore.objects.create(
            user=cls.user,
            channel=SalesImport.Channel.SQUARE,
            match_key="sku:napkin",
            sku="napkin",
            external_name="Napkin",
        )
        cls.connection = SalesChannelConnection.objects.create(
            user=cls.user,
            provider=SalesImport.Channel.SQUARE,
            access_token_encrypted="envelope",
        )
        cls.menu = Menu.objects.create(
            user=cls.user,
            name="Spring",
            period_start=date(2026, 3, 1),
            period_end=date(2026, 3, 31),
        )
        cls.menu_item = MenuItem.objects.create(
            menu=cls.menu,
            position=0,
            name="Croissant",
            category="Pastry",
            sell_price_cents=450,
            qty_sold=Decimal("12.000"),
            product=cls.sales_product,
            original_sell_price_cents=450,
            original_qty_sold=Decimal("12.000"),
            original_food_cost_cents=120,
        )

    # --- account -----------------------------------------------------------

    def test_user_json(self):
        self.assertShape(accounts.user_json(self.user), ["email", "hasPassword", "id", "name"])

    def test_billing_json(self):
        self.assertShape(
            accounts_billing.billing_json(self.user),
            [
                "entitlements.catalogSearch",
                "entitlements.connectors",
                "entitlements.invoiceAi",
                "entitlements.maxRecipes",
                "entitlements.posSync",
                "entitlements.primo",
                "entitlements.usdaSearch",
                "locked",
                "plan",
                "status",
                "trialDaysLeft",
            ],
        )

    # --- shared browse/search envelopes -----------------------------------

    def test_paginated_payload(self):
        self.assertShape(
            paginated_payload(
                [{"id": "row-1"}],
                BrowseQuery(page=1, limit=50, query="", order="name"),
                1,
            ),
            [
                "items[].id",
                "meta.pagination.limit",
                "meta.pagination.next",
                "meta.pagination.page",
                "meta.pagination.pages",
                "meta.pagination.prev",
                "meta.pagination.total",
            ],
        )

    def test_search_index_json(self):
        item = search.search_item_json(
            label="Butter",
            href="/ingredients",
            item_type="ingredient",
        )
        self.assertShape(
            search.search_index_json([item]),
            [
                "items[].href",
                "items[].label",
                "items[].type",
            ],
        )

    # --- ingredients -------------------------------------------------------

    def test_ingredient_option_json(self):
        self.assertShape(
            ingredients.ingredient_option_json(self.ingredient),
            ["id", "name", "nonEdible"],
        )

    def test_pricing_entry_json(self):
        self.assertShape(
            ingredients.pricing_entry_json(self.ingredient),
            [
                "conversion",
                "id",
                "measureName",
                "name",
                "nonEdible",
                "normalizedName",
                "nutritionPer100g",
                "preparations",
                "purchaseCostCents",
                "purchaseSize",
                "purchaseUnit",
                "status",
                "yieldPercent",
            ],
        )

    def test_pricing_entry_json_keeps_supplies_for_the_picker_to_skip(self):
        self.ingredient.non_edible = True
        self.ingredient.save(update_fields=["non_edible"])
        entry = ingredients.pricing_entry_json(self.ingredient)
        self.assertIs(entry["nonEdible"], True)

    def test_editor_recipe_json(self):
        self.assertShape(
            ingredients.editor_recipe_json(self.recipe),
            [
                "body",
                "category",
                "equivalency",
                "id",
                "kind",
                "title",
                "yieldAmount",
                "yieldUnit",
            ],
        )

    def test_editor_recipe_json_carries_the_equivalency(self):
        """A cup of a recipe weighed in grams is costed off this."""
        RecipeEquivalency.objects.create(
            recipe=self.recipe,
            mass_amount=Decimal("700"),
            mass_unit="g",
            volume_amount=Decimal("2.75"),
            volume_unit="cup",
            standard=False,
        )
        row = Recipe.objects.select_related("equivalency").get(pk=self.recipe.pk)
        self.assertShape(
            ingredients.editor_recipe_json(row),
            [
                "body",
                "category",
                "equivalency.countAmount",
                "equivalency.countUnit",
                "equivalency.id",
                "equivalency.massAmount",
                "equivalency.massUnit",
                "equivalency.standard",
                "equivalency.volumeAmount",
                "equivalency.volumeUnit",
                "id",
                "kind",
                "title",
                "yieldAmount",
                "yieldUnit",
            ],
        )

    def test_ingredient_json(self):
        # A package text and a brand-dependent catalog row, so all three hint
        # lists are pinned with a key in them rather than as empty arrays.
        catalog = CatalogIngredient.objects.create(
            name="Contract butter", normalized_name="contract butter"
        )
        CatalogIngredientAllergen.objects.create(
            ingredient=catalog,
            allergen="soy",
            status=IngredientAllergenStatus.CHECK_LABEL,
            source_kind="catalog",
            source_ref="contract-butter",
        )
        self.ingredient.catalog_ingredient = catalog
        self.ingredient.nutrition_package_ingredients = (
            "CREAM, SALT. CONTAINS: MILK. MAY CONTAIN ALMONDS."
        )
        self.ingredient.nutrition_source = "usda_fdc"
        self.ingredient.nutrition_source_id = "123"
        self.ingredient.nutrition_description = "Butter, without salt"
        self.ingredient.nutrition_per_100g = {
            "water": 16,
            "fat": 81,
            "protein": 1,
            "sugars": 0,
            "starch": 0,
            "fiber": 0,
            "salt": 0,
            "other": 2,
            "totalCarbohydrate": 0,
            "sodiumMg": 0,
        }
        self.ingredient.nutrition_updated_at = timezone.now()
        self.ingredient.save()
        Preparation.objects.create(
            user=self.user,
            ingredient=self.ingredient,
            name="Clarified",
            yield_percent=Decimal("82"),
            average_weight=False,
            weight_amount=Decimal("820"),
            weight_unit="Gram (g)",
            volume_amount=Decimal("3.5"),
            volume_unit="Cup (c)",
            each_amount=Decimal("1"),
            each_unit="Each (ea)",
        )
        IngredientConversion.objects.create(
            user=self.user,
            ingredient=self.ingredient,
            average_weight=False,
            weight_amount=Decimal("1000"),
            weight_unit="Gram (g)",
            volume_amount=Decimal("4.2"),
            volume_unit="Cup (c)",
            each_amount=Decimal("1"),
            each_unit="Each (ea)",
        )
        RecipeItem.objects.create(
            recipe=self.recipe,
            kind=RecipeItem.INGREDIENT,
            position=0,
            display_name="Butter",
            quantity=Decimal("100"),
            unit="g",
            ingredient=self.ingredient,
        )
        NutritionRequest.objects.create(
            user=self.user,
            ingredient=self.ingredient,
            serving_grams=Decimal("30"),
            values={"calories": 100},
            per_100g={
                "water": 0,
                "fat": 0,
                "protein": 0,
                "sugars": 0,
                "starch": 0,
                "fiber": 0,
                "salt": 0,
                "other": 100,
            },
        )
        row = Ingredient.objects.prefetch_related(
            "preparations", "price_history", "supplier_items", "nutrition_requests"
        ).get(id=self.ingredient.id)
        self.assertShape(
            ingredients.ingredient_json(row),
            [
                "conversion.confidence",
                "conversion.each.amount",
                "conversion.each.unit",
                "conversion.source",
                "conversion.updatedAt",
                "conversion.usesStandardConversion",
                "conversion.volume.amount",
                "conversion.volume.unit",
                "conversion.weight.amount",
                "conversion.weight.unit",
                "category",
                "categoryId",
                "createdAt",
                "editVersion",
                "allergenHints.checkLabel[]",
                "allergenHints.contains[]",
                "allergenHints.mayContain[]",
                "effectiveAllergenKeys",
                "effectiveAllergens",
                "id",
                "invoicePrices",
                "measureName",
                "needsAttention",
                "name",
                "nonEdible",
                "normalizedName",
                "nutrition.description",
                "nutrition.packageIngredients",
                "nutritionLabelName",
                "nutritionRequest.createdAt",
                "nutritionRequest.id",
                "nutritionRequest.note",
                "nutritionRequest.servingGrams",
                "nutritionRequest.source",
                "nutritionRequest.status",
                "nutritionRequest.values.addedSugars",
                "nutritionRequest.values.calciumMg",
                "nutritionRequest.values.calories",
                "nutritionRequest.values.cholesterolMg",
                "nutritionRequest.values.fat",
                "nutritionRequest.values.fiber",
                "nutritionRequest.values.ironMg",
                "nutritionRequest.values.potassiumMg",
                "nutritionRequest.values.protein",
                "nutritionRequest.values.saturatedFat",
                "nutritionRequest.values.sodiumMg",
                "nutritionRequest.values.sugars",
                "nutritionRequest.values.totalCarbohydrate",
                "nutritionRequest.values.transFat",
                "nutritionRequest.values.vitaminDMcg",
                "nutrition.per100g.addedSugars",
                "nutrition.per100g.calciumMg",
                "nutrition.per100g.calories",
                "nutrition.per100g.cholesterolMg",
                "nutrition.per100g.fat",
                "nutrition.per100g.fiber",
                "nutrition.per100g.other",
                "nutrition.per100g.protein",
                "nutrition.per100g.salt",
                "nutrition.per100g.saturatedFat",
                "nutrition.per100g.sodiumMg",
                "nutrition.per100g.starch",
                "nutrition.per100g.sugars",
                "nutrition.per100g.totalCarbohydrate",
                "nutrition.per100g.water",
                "nutrition.per100g.ironMg",
                "nutrition.per100g.potassiumMg",
                "nutrition.per100g.transFat",
                "nutrition.per100g.vitaminDMcg",
                "nutrition.source",
                "nutrition.sourceId",
                "nutrition.updatedAt",
                "preparations[].confidence",
                "preparations[].createdAt",
                "preparations[].each.amount",
                "preparations[].each.unit",
                "preparations[].id",
                "preparations[].name",
                "preparations[].source",
                "preparations[].updatedAt",
                "preparations[].usesStandardConversion",
                "preparations[].volume.amount",
                "preparations[].volume.unit",
                "preparations[].weight.amount",
                "preparations[].weight.unit",
                "preparations[].yieldPercent",
                "priceHistory[].createdAt",
                "priceHistory[].effectiveAt",
                "priceHistory[].id",
                "priceHistory[].purchaseCostCents",
                "priceHistory[].purchaseSize",
                "priceHistory[].purchaseUnit",
                "priceHistory[].source",
                "priceHistory[].updatedAt",
                "priceSource",
                "previousPrice",
                "preferredSupplier.id",
                "preferredSupplier.supplier",
                "preferredSupplier.title",
                "publicId",
                "purchaseCostCents",
                "purchaseSize",
                "purchaseUnit",
                "sugarsAreAdded",
                "supplierItems[].externalId",
                "supplierItems[].id",
                "supplierItems[].isPreferred",
                "supplierItems[].packAmount",
                "supplierItems[].packGrams",
                "supplierItems[].packPriceCents",
                "supplierItems[].packUnit",
                "supplierItems[].periodEnd",
                "supplierItems[].periodStart",
                "supplierItems[].purchasedQuantity",
                "supplierItems[].rawSize",
                "supplierItems[].supplier",
                "supplierItems[].title",
                "supplierItems[].updatedAt",
                "status",
                "updatedAt",
                "usedInRecipes[].id",
                "usedInRecipes[].publicId",
                "usedInRecipes[].quantity",
                "usedInRecipes[].status",
                "usedInRecipes[].title",
                "usedInRecipes[].unit",
                "usedInProducts",
                "userId",
                "yieldPercent",
                "tags",
            ],
        )

    def test_ingredient_summary_json_carries_the_kind(self):
        """The browse rows tell a supply from food, so the flag rides both."""
        summary = ingredients.ingredient_json(self.ingredient, detail=False)
        self.assertIs(summary["nonEdible"], False)
        self.assertNotIn("editVersion", summary)

    def test_ingredient_json_shapes_the_products_using_an_ingredient(self):
        """The detail shape above pins the key on a row no product holds."""
        self.assertEqual(
            ingredients.ingredient_json(self.ingredient)["usedInProducts"], []
        )
        SalesProductComponent.objects.create(
            product=self.sales_product,
            ingredient=self.ingredient,
            quantity=Decimal("2.000"),
            unit="each",
        )
        usage = ingredients.ingredient_json(self.ingredient)["usedInProducts"]
        self.assertShape(
            usage[0],
            ["id", "isActive", "name", "publicId", "quantity", "unit"],
        )

    def test_user_ingredient_measure_json(self):
        row = IngredientMeasure(
            ingredient=self.ingredient,
            unit="cup",
            amount=Decimal("1"),
            grams=Decimal("125"),
        )
        self.assertShape(
            ingredients.ingredient_measure_json(row),
            [
                "amount",
                "confidence",
                "grams",
                "highGrams",
                "id",
                "ingredientId",
                "lowGrams",
                "name",
                "normalizedName",
                "qualifier",
                "source",
                "unit",
            ],
        )

    def test_catalog_ingredient_measure_json(self):
        ingredient = CatalogIngredient(name="Test flour", normalized_name="test flour")
        row = CatalogIngredientMeasure(
            ingredient=ingredient,
            unit="cup",
            amount=Decimal("1"),
            grams=Decimal("125"),
            source_kind="public-data",
            source_ref="test-1",
            confidence="high",
        )
        payload = ingredients.ingredient_measure_json(row)
        self.assertIsNone(payload["ingredientId"])
        self.assertEqual(payload["source"], "catalog")
        self.assertShape(
            payload,
            [
                "amount",
                "confidence",
                "grams",
                "highGrams",
                "id",
                "ingredientId",
                "lowGrams",
                "name",
                "normalizedName",
                "qualifier",
                "source",
                "unit",
            ],
        )

    INGREDIENT_IMPORT_PATHS = [
        "canUndo",
        "createdAt",
        "createdCount",
        "fileName",
        "id",
        "ignoredCount",
        "importedCount",
        "periodEnd",
        "periodStart",
        "reviewCount",
        "supplier",
        "totalRows",
        "undoneAt",
        "updatedCount",
    ]

    def test_ingredient_import_json_default(self):
        self.assertShape(
            ingredients.ingredient_import_json(self.ingredient_import),
            self.INGREDIENT_IMPORT_PATHS,
        )

    def test_ingredient_import_json_can_undo(self):
        self.assertShape(
            ingredients.ingredient_import_json(self.ingredient_import, can_undo=True),
            self.INGREDIENT_IMPORT_PATHS,
        )

    def test_master_price_json(self):
        # The starter catalog is loaded from a private path and is empty in
        # source control, so the pin builds its own row.
        price = master_prices.MasterPrice(
            id="mp-1",
            name="Butter",
            pack_price_cents=1200,
            pack_amount=1.0,
            pack_unit="kg",
        )
        self.assertShape(
            master_prices.master_price_json(price),
            [
                "id",
                "masterPriceId",
                "name",
                "normalizedName",
                "packAmount",
                "packGrams",
                "packPriceCents",
                "packUnit",
                "source",
            ],
        )

    def test_catalog_price_json(self):
        ingredient = CatalogIngredient(
            name="Cultured Butter",
            normalized_name="cultured butter",
        )
        product = CatalogProduct(
            id=uuid.UUID("00000000-0000-0000-0000-000000000123"),
            ingredient=ingredient,
            pack_price_cents=1299,
            pack_grams=454,
            pack_amount=1.0,
            pack_unit="lb",
        )
        self.assertEqual(
            ingredients.catalog_price_json(product),
            {
                "id": "catalog:00000000-0000-0000-0000-000000000123",
                "catalogPriceId": "00000000-0000-0000-0000-000000000123",
                "name": "Cultured Butter",
                "normalizedName": "cultured butter",
                "packPriceCents": 1299,
                "packGrams": 454,
                "packAmount": 1.0,
                "packUnit": "lb",
                "source": "catalog",
            },
            CONTRACT_MESSAGE,
        )

    # --- recipes -----------------------------------------------------------

    def test_external_ref_json(self):
        self.assertShape(
            recipes.external_ref_json(self.external_ref),
            ["externalId", "id", "refKind", "system"],
        )

    RECIPE_SUMMARY_PATHS = [
        "autoPrepTimeEnabled",
        "autoSumYieldEnabled",
        "body",
        "category",
        "categoryId",
        "code",
        "description",
        "id",
        "kind",
        "locked",
        "menuPriceCents",
        "method",
        "publicId",
        "percentageMode",
        "percentIngredientEnabled",
        "percentIngredientType",
        "prepTimeAmount",
        "prepTimeUnit",
        "nutritionPackageAmount",
        "nutritionPackageUnit",
        "nutritionServingAmount",
        "nutritionServingUnit",
        "servingAmount",
        "servingUnit",
        "shelfLifeAmount",
        "shelfLifeUnit",
        "status",
        "title",
        "updatedAt",
        "yieldAmount",
        "yieldUnit",
    ]

    def test_recipe_health_row(self):
        recipe = Recipe.objects.create(
            user=self.user,
            title="Timed loaf",
            code="R2",
            yield_amount=10.0,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
            menu_price_cents=500,
            auto_prep_time_enabled=True,
        )
        RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.INGREDIENT,
            position=0,
            display_name="Butter",
            quantity=Decimal("100"),
            unit="g",
            ingredient=self.ingredient,
        )
        step = RecipeStep.objects.create(recipe=recipe, position=0, labor_kind="active")
        RecipeTiming.objects.create(step=step, seconds=600)
        recipe._has_normalized_items = True
        recipe._normalized_items = list(recipe.items.all())
        recipe._normalized_steps = list(recipe.steps.all())
        self.assertShape(
            RecipeHealthReadModel(self.user).rows([recipe])[0],
            [
                "category",
                "categoryId",
                "code",
                "foodCost",
                "id",
                "ingredientCents",
                "issues",
                "kind",
                "labor.centsPerBatch",
                "labor.centsPerPiece",
                "menuPriceCents",
                "overTarget",
                "publicId",
                "status",
                "suffix",
                "title",
                "updatedAt",
            ],
        )

    def test_recipe_json_summary(self):
        self.assertShape(
            recipes.recipe_json(self.recipe, full=False), self.RECIPE_SUMMARY_PATHS
        )

    def test_recipe_json_returns_blank_method_text_by_default(self):
        self.assertEqual(recipes.recipe_json(self.recipe, full=False)["method"], "")

    def test_recipe_json_full(self):
        row = Recipe.objects.prefetch_related("external_refs").get(id=self.recipe.id)
        self.assertShape(
            recipes.recipe_json(row, full=True),
            self.RECIPE_SUMMARY_PATHS
            + [
                "createdAt",
                "editVersion",
                "externalRefs[].externalId",
                "externalRefs[].id",
                "externalRefs[].refKind",
                "externalRefs[].system",
                "userId",
            ],
        )

    def test_recipe_json_defaults_to_full(self):
        self.assertEqual(
            key_paths(recipes.recipe_json(self.recipe)),
            key_paths(recipes.recipe_json(self.recipe, full=True)),
            CONTRACT_MESSAGE,
        )

    # --- bench costing ------------------------------------------------------

    def test_timing_json(self):
        self.assertShape(
            recipes.timing_json(self.timing),
            ["createdAt", "id", "seconds", "stepId", "yieldCount"],
        )

    STEP_PATHS = [
        "covers",
        "id",
        "kind",
        "name",
        "position",
        "recipeId",
        "timings[].createdAt",
        "timings[].id",
        "timings[].seconds",
        "timings[].stepId",
        "timings[].yieldCount",
    ]

    def test_step_json(self):
        row = BenchCostStep.objects.prefetch_related("timings").get(id=self.step.id)
        self.assertShape(recipes.step_json(row), self.STEP_PATHS)

    def test_cost_recipe_json(self):
        row = BenchCostRecipe.objects.prefetch_related("steps__timings").get(
            id=self.cost_recipe.id
        )
        self.assertShape(
            recipes.cost_recipe_json(row),
            [
                "batchYield",
                "createdAt",
                "id",
                "ingredientCostCents",
                "name",
                "packagingCostCents",
                "position",
                "recipeId",
                "sellableYield",
                "updatedAt",
                "userId",
            ]
            + [f"steps[].{path}" for path in self.STEP_PATHS],
        )

    # --- labor -------------------------------------------------------------

    LABOR_IMPORT_PATHS = [
        "canUndo",
        "createdAt",
        "createdEmployeeCount",
        "duplicateCount",
        "excludedCount",
        "fileName",
        "id",
        "importedCount",
        "periodEnd",
        "periodStart",
        "skippedCount",
        "source",
        "timezone",
        "totalLaborCostCents",
        "totalRows",
        "totalSeconds",
        "uncostedCount",
        "undoneAt",
    ]

    def test_labor_import_json_default(self):
        self.assertShape(
            labor.labor_import_json(self.labor_import), self.LABOR_IMPORT_PATHS
        )

    def test_labor_import_json_can_undo(self):
        self.assertShape(
            labor.labor_import_json(self.labor_import, can_undo=True),
            self.LABOR_IMPORT_PATHS,
        )

    EMPLOYEE_PATHS = [
        "currentHourlyRateCents",
        "currentRateEffectiveFrom",
        "excludedFromCost",
        "firstShiftAt",
        "id",
        "isActive",
        "laborCostCents",
        "lastShiftAt",
        "name",
        "normalizedName",
        "payrollTaxCents",
        "shiftCount",
        "totalSeconds",
        "uncostedCount",
        "unpaidBreakSeconds",
    ]

    def test_employee_json(self):
        row = Employee.objects.prefetch_related("hourly_rates", "time_entries").get(
            id=self.employee.id
        )
        self.assertShape(
            labor.employee_json(row),
            self.EMPLOYEE_PATHS
            + [
                "rateHistory[].effectiveFrom",
                "rateHistory[].hourlyRateCents",
                "rateHistory[].id",
            ],
        )

    def test_employee_json_without_prefetch_or_shifts(self):
        # Serialized straight off a fresh row the overview never prefetched:
        # the key set must not depend on the query that produced the row.
        bare = Employee.objects.create(
            user=self.user, name="New Hire", normalized_name="new hire"
        )
        self.assertShape(
            labor.employee_json(bare), self.EMPLOYEE_PATHS + ["rateHistory"]
        )

    def test_time_entry_json(self):
        self.assertShape(
            labor.time_entry_json(self.time_entry),
            [
                "breakSeconds",
                "clockIn",
                "clockOut",
                "comment",
                "earningsAdjustmentCents",
                "employeeId",
                "employeeName",
                "hourlyRateCents",
                "id",
                "importId",
                "importTimezone",
                "laborCostCents",
                "paidSeconds",
                "timeAdjustmentSeconds",
                "unpaidBreakSeconds",
            ],
        )

    # --- invoices ----------------------------------------------------------

    def test_expense_category_json(self):
        self.assertShape(
            invoices.expense_category_json(self.expense_category),
            ["id", "isIngredient", "isSupply", "name", "position"],
        )

    def test_invoice_json(self):
        self.assertShape(
            invoices.invoice_json(self.invoice),
            [
                "createdAt",
                "currencyCode",
                "documentType",
                "driveFileId",
                "driveWebViewLink",
                "fileName",
                "id",
                "invoiceDate",
                "invoiceNumber",
                "issueKind",
                "lineCount",
                "matchedLineCount",
                "unresolvedLineCount",
                "publicId",
                "source",
                "supplier",
                "supplierName",
                "taxCents",
                "totalCents",
                "totalDeltaCents",
                "updatedAt",
            ],
        )

    def test_invoice_line_json(self):
        self.assertShape(
            invoices.invoice_line_json(self.invoice_line),
            [
                "categoryId",
                "categoryName",
                "currencyCode",
                "description",
                "id",
                "ingredientId",
                "ingredientName",
                "lineAmountCents",
                "needsReview",
                "packSize",
                "position",
                "priceUpdated",
                "quantity",
                "sku",
                "unit",
                "unitPriceCents",
            ],
        )

    # --- sales -------------------------------------------------------------

    SALES_IMPORT_PATHS = [
        "canUndo",
        "channel",
        "createdAt",
        "currencyCode",
        "discountCents",
        "duplicateCount",
        "fileName",
        "grossCents",
        "id",
        "ignoredCount",
        "importedCount",
        "netSalesCents",
        "orderCount",
        "periodEnd",
        "periodStart",
        "providerAccountId",
        "refundCents",
        "skippedCount",
        "source",
        "taxCents",
        "timezone",
        "totalRows",
        "undoneAt",
    ]

    def test_sales_import_json_default(self):
        self.assertShape(
            sales.sales_import_json(self.sales_import), self.SALES_IMPORT_PATHS
        )

    def test_sales_import_json_can_undo(self):
        self.assertShape(
            sales.sales_import_json(self.sales_import, can_undo=True),
            self.SALES_IMPORT_PATHS,
        )

    VARIANT_PATHS = [
        "attributionPercent",
        "channel",
        "externalName",
        "externalObjectId",
        "externalVariantTitle",
        "id",
        "identityKind",
        "matchKey",
        "productExternalObjectId",
        "providerAccountId",
        "quantityMultiplier",
        "sku",
    ]

    PRODUCT_COMPONENT_PATHS = [
        "id",
        "recipeId",
        "recipePublicId",
        "recipeName",
        "ingredientId",
        "ingredientPublicId",
        "ingredientName",
        "productId",
        "productPublicId",
        "productName",
        "quantity",
        "unit",
        "position",
        "nonEdible",
    ]

    MENU_PRODUCT_PATHS = [
        "componentProductIds",
        "id",
        "name",
        "publicId",
    ]

    def test_variant_json(self):
        self.assertShape(sales.variant_json(self.variant), self.VARIANT_PATHS)

    def product_paths(self) -> list[str]:
        return (
            [
                "baseUnit",
                "category",
                "costed",
                "createdAt",
                "description",
                "editVersion",
                "id",
                "isActive",
                "name",
                "normalizedName",
                "publicId",
                "recipeLinks[].publicId",
                "recipeLinks[].quantity",
                "recipeLinks[].recipeId",
                "recipeLinks[].recipeTitle",
                "sellPriceCents",
                "sku",
                "skus[].id",
                "skus[].position",
                "skus[].quantityMultiplier",
                "skus[].sku",
                "updatedAt",
            ]
            + [f"components[].{path}" for path in self.PRODUCT_COMPONENT_PATHS]
            + [f"variants[].{path}" for path in self.VARIANT_PATHS]
            + [f"sales.{key}" for key in sales.EMPTY_PRODUCT_SALES]
        )

    def loaded_product(self) -> SalesProduct:
        return SalesProduct.objects.prefetch_related(
            "components__recipe",
            "components__component_product",
        ).get(id=self.sales_product.id)

    def test_product_json_without_stats(self):
        # Absent stats fall back to the zeroed rollup, so the nested sales
        # shape is part of the contract even for a product that never sold.
        self.assertShape(
            sales.product_json(self.loaded_product()), self.product_paths()
        )

    def test_product_json_with_stats(self):
        self.assertShape(
            sales.product_json(self.loaded_product(), dict(sales.EMPTY_PRODUCT_SALES)),
            self.product_paths(),
        )

    def test_product_component_shape(self):
        # Pin both sides of the XOR here; the envelope test adds the same rich
        # rows to its detail fixture so the TypeScript strict schema is checked
        # too.
        self.assertShape(
            {
                "id": str(uuid.uuid4()),
                "recipeId": str(self.recipe.id),
                "recipePublicId": self.recipe.public_id,
                "recipeName": self.recipe.title,
                "ingredientId": None,
                "ingredientPublicId": None,
                "ingredientName": None,
                "productId": None,
                "productPublicId": None,
                "productName": None,
                "quantity": 1.0,
                "unit": "",
                "position": 0,
                "nonEdible": False,
            },
            self.PRODUCT_COMPONENT_PATHS,
        )

    def test_menu_items_payload(self):
        self.assertShape(
            sales.menu_items_payload(
                self.user,
                BrowseQuery(page=1, limit=50, query="", order="name"),
            ),
            [f"items[].{path}" for path in self.product_paths()]
            + [
                "hasAnyProduct",
                "meta.pagination.limit",
                "meta.pagination.next",
                "meta.pagination.page",
                "meta.pagination.pages",
                "meta.pagination.prev",
                "meta.pagination.total",
            ],
        )

    def test_sku_ignore_json(self):
        self.assertShape(
            sales.sku_ignore_json(self.sku_ignore),
            [
                "channel",
                "currencyCode",
                "externalName",
                "externalVariantTitle",
                "id",
                "identityKind",
                "lastSoldAt",
                "lineCount",
                "matchKey",
                "netSalesCents",
                "providerAccountId",
                "quantity",
                "ruleId",
                "sku",
                "source",
            ],
        )

    def test_ignore_rule_json(self):
        rule = SalesIgnoreRule.objects.create(
            user=self.user,
            channel="square",
            conditions=[{"field": "sku", "operator": "starts_with", "value": "GC-"}],
        )
        self.assertShape(
            sales.ignore_rule_json(rule),
            [
                "channel",
                "conditions[].field",
                "conditions[].operator",
                "conditions[].value",
                "createdAt",
                "enabled",
                "id",
                "ignoredCount",
                "updatedAt",
            ],
        )

    def test_ignore_rule_json_carries_a_null_channel(self):
        rule = SalesIgnoreRule.objects.create(
            user=self.user,
            channel=None,
            conditions=[{"field": "sku", "operator": "starts_with", "value": "GC-"}],
        )
        self.assertIsNone(sales.ignore_rule_json(rule)["channel"])

    def test_connection_json(self):
        self.assertShape(
            sales_connections.connection_json(self.connection),
            [
                "backfilledAt",
                "connectedAt",
                "currencyCode",
                "generation",
                "lastError",
                "lastSyncedAt",
                "merchantId",
                "providerTimezone",
                "provider",
                "providerAccountId",
                "scopes",
                "shopDomain",
                "status",
            ],
        )

    def test_connection_json_never_leaks_tokens(self):
        payload = sales_connections.connection_json(self.connection)
        for key in payload:
            self.assertNotIn("token", key.lower(), CONTRACT_MESSAGE)

    # --- menus -------------------------------------------------------------

    MENU_ITEM_PATHS = [
        "category",
        "foodCostCents",
        "id",
        "name",
        "original.foodCostCents",
        "original.qtySold",
        "original.sellPriceCents",
        "position",
        "productId",
        "productName",
        "productPublicId",
        "qtySold",
        "recipeId",
        "recipeName",
        "recipePublicId",
        "sellPriceCents",
        "sourceQtySold",
        "sourceSellPriceCents",
    ]

    MENU_INGREDIENT_PATHS = ["id", "name", "nonEdible", "purchaseUnit"]

    MENU_RECIPE_PATHS = [
        "batchMeasures[].amount",
        "batchMeasures[].unit",
        "category",
        "id",
        "ingredientCents",
        "kind",
        "menuPriceCents",
        "publicId",
        "servingAmount",
        "servingUnit",
        "suffix",
        "title",
    ]

    def test_menu_summary_json(self):
        row = (
            Menu.objects.filter(id=self.menu.id)
            .annotate(item_count=Count("items"))
            .get()
        )
        self.assertShape(
            recipes.menu_summary_json(row),
            [
                "id",
                "itemCount",
                "name",
                "periodEnd",
                "periodStart",
                "publicId",
                "updatedAt",
            ],
        )

    def test_menu_json(self):
        self.assertShape(
            recipes.menu_json(self.menu),
            [
                "createdAt",
                "editVersion",
                "id",
                "name",
                "periodEnd",
                "periodStart",
                "publicId",
                "updatedAt",
            ],
        )

    def test_menu_ingredient_json(self):
        row = Ingredient.objects.filter(id=self.ingredient.id).values(
            "id", "name", "purchase_unit", "non_edible"
        )[0]
        self.assertShape(recipes.menu_ingredient_json(row), self.MENU_INGREDIENT_PATHS)

    def test_menu_item_json(self):
        item = MenuItem.objects.select_related("product", "recipe__category").get(
            id=self.menu_item.id
        )
        self.assertShape(
            recipes.menu_item_json(item, food_cost_cents=120, source_qty_sold=12.0),
            self.MENU_ITEM_PATHS,
        )

    def test_menu_recipe_json(self):
        model = RecipeHealthReadModel(self.user, dashboard=True)
        row = menu_recipe_rows(model)[0]
        self.assertShape(recipes.menu_recipe_json(row), self.MENU_RECIPE_PATHS)

    def test_business_settings_payload(self):
        self.assertShape(
            internal_payload(workspace_views.business_settings, self.user),
            [
                "currencyCode",
                "foodCostTarget",
                "labelRegion",
                "measurementSystem",
                "overtimeWeeklyMinutes",
                "payrollAverageRateCents",
                "payrollTaxPercent",
                "productMatching",
                "timezone",
                "unpaidBreakMinutes",
                "unpaidBreakPerHours",
                "wagePerHourCents",
            ],
        )

    def test_menus_payload(self):
        self.assertShape(
            internal_payload(recipe_views.menus, self.user),
            [
                "hasAnyMenu",
                "menus[].id",
                "menus[].itemCount",
                "menus[].name",
                "menus[].periodEnd",
                "menus[].periodStart",
                "menus[].publicId",
                "menus[].updatedAt",
            ],
        )

    def test_menu_detail_payload(self):
        self.assertShape(
            menu_detail_payload(self.user, self.menu),
            ["currencyCode"]
            + [f"items[].{path}" for path in self.MENU_ITEM_PATHS]
            + [f"recipes[].{path}" for path in self.MENU_RECIPE_PATHS]
            + [f"ingredients[].{path}" for path in self.MENU_INGREDIENT_PATHS]
            + [f"products[].{path}" for path in self.MENU_PRODUCT_PATHS]
            + [
                "menu.createdAt",
                "menu.editVersion",
                "menu.id",
                "menu.name",
                "menu.periodEnd",
                "menu.periodStart",
                "menu.publicId",
                "menu.updatedAt",
            ],
        )

    def test_menu_sources_payload(self):
        self.assertShape(
            menu_sources_payload(self.user),
            ["currencyCode"]
            + [f"recipes[].{path}" for path in self.MENU_RECIPE_PATHS]
            + [f"ingredients[].{path}" for path in self.MENU_INGREDIENT_PATHS]
            + [f"products[].{path}" for path in self.MENU_PRODUCT_PATHS],
        )

    def test_invoice_suppliers_payload(self):
        self.assertShape(
            internal_payload(invoice_views.invoice_suppliers, self.user),
            [
                "items[].accountNumber",
                "items[].defaultCategoryId",
                "items[].email",
                "items[].id",
                "items[].ignoreCount",
                "items[].invoiceCount",
                "items[].itemCount",
                "items[].key",
                "items[].name",
                "items[].notes",
                "items[].phone",
            ],
        )

    SUPPLIER_ITEM_PATHS = [
        "externalId",
        "hasCode",
        "id",
        "rawSize",
        "supplier",
        "supplierName",
        "title",
    ]

    def test_supplier_items_payload(self):
        self.assertShape(
            internal_payload(invoice_views.supplier_items, self.user),
            ["total"]
            + [
                f"items[].{path}"
                for path in [
                    *self.SUPPLIER_ITEM_PATHS,
                    "ingredientId",
                    "ingredientName",
                    "isPreferred",
                    "lastInvoiceDate",
                    "packAmount",
                    "packPriceCents",
                    "packUnit",
                    "timesSeen",
                ]
            ],
        )

    def test_supplier_items_ignored_payload(self):
        SupplierItemIgnore.objects.create(
            user=self.user,
            supplier="acme",
            external_id="desc:butter",
            title="Butter",
            raw_size="1 kg",
        )
        self.assertShape(
            internal_payload(
                invoice_views.supplier_items, self.user, query={"tab": "ignored"}
            ),
            ["total"] + [f"items[].{path}" for path in self.SUPPLIER_ITEM_PATHS],
        )

    def test_menu_component_price_payload(self):
        self.assertShape(
            internal_payload(
                recipe_views.menu_component_price,
                self.user,
                query={"ingredientId": str(self.ingredient.id), "unit": "g"},
            ),
            ["unitCostCents"],
        )


class ActionDispatchContractTests(TestCase):
    """Request-level pins for the single action() funnel.

    Every internal mutation goes through one POST route, so its status codes
    and error payload shape are as much a part of the contract as the JSON
    the serializers emit.
    """

    ROUTE = "/internal/v1/actions/{}/"

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="funnel@example.com",
            password="a-long-test-passphrase-2468",
            name="Funnel Chef",
        )
        self.client.force_login(self.user)

    def post(self, slug: str, body: str = "{}", *, secret: bool = True):
        # Malformed bodies are part of this contract, so the raw string goes
        # on the wire instead of the base class's json.dumps.
        headers = (
            {"HTTP_X_FORKLUCK_INTERNAL_SECRET": settings.FORKLUCK_INTERNAL_SECRET}
            if secret
            else {}
        )
        return self.client.post(
            self.ROUTE.format(slug),
            data=body,
            content_type="application/json",
            **headers,
        )

    def raising(self, exc: Exception):
        def handler(user, body):
            raise exc

        handler.__name__ = "contract_probe"
        return mock.patch.dict(dispatch.ACTIONS, {"save-ingredient": handler})

    def test_unknown_action_is_404_with_error_payload(self):
        response = self.post("no-such-action")
        self.assertEqual(response.status_code, 404, CONTRACT_MESSAGE)
        self.assertEqual(response.json(), {"error": "Not found"}, CONTRACT_MESSAGE)

    def test_get_on_action_route_is_405(self):
        response = self.client.get(
            self.ROUTE.format("save-ingredient"),
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )
        self.assertEqual(response.status_code, 405, CONTRACT_MESSAGE)

    def test_missing_internal_secret_is_404(self):
        response = self.post("save-ingredient", secret=False)
        self.assertEqual(response.status_code, 404, CONTRACT_MESSAGE)
        self.assertEqual(response.json(), {"error": "Not found"}, CONTRACT_MESSAGE)

    def test_wrong_internal_secret_is_404(self):
        response = self.client.post(
            self.ROUTE.format("save-ingredient"),
            data="{}",
            content_type="application/json",
            HTTP_X_FORKLUCK_INTERNAL_SECRET="not-the-secret",
        )
        self.assertEqual(response.status_code, 404, CONTRACT_MESSAGE)

    def test_unauthenticated_with_valid_secret_is_401(self):
        self.client.logout()
        response = self.post("save-ingredient")
        self.assertEqual(response.status_code, 401, CONTRACT_MESSAGE)
        self.assertEqual(
            response.json(), {"error": "Authentication required"}, CONTRACT_MESSAGE
        )

    def test_invalid_json_body_is_400(self):
        response = self.post("save-ingredient", body="not json")
        self.assertEqual(response.status_code, 400, CONTRACT_MESSAGE)
        self.assertEqual(
            response.json(), {"error": "Invalid JSON body"}, CONTRACT_MESSAGE
        )

    def test_oversized_body_stays_inside_the_error_contract(self):
        # Django raises RequestDataTooBig from the body read itself and would
        # otherwise answer an HTML 400, which the frontend client cannot parse.
        with override_settings(DATA_UPLOAD_MAX_MEMORY_SIZE=16):
            response = self.post("save-ingredient", body=json.dumps({"a": "b" * 64}))
        self.assertEqual(response.status_code, 400, CONTRACT_MESSAGE)
        self.assertIn("too large", response.json()["error"], CONTRACT_MESSAGE)

    def test_non_object_json_body_is_400(self):
        response = self.post("save-ingredient", body="[1, 2, 3]")
        self.assertEqual(response.status_code, 400, CONTRACT_MESSAGE)
        self.assertEqual(
            response.json(),
            {"error": "JSON body must be an object"},
            CONTRACT_MESSAGE,
        )

    def test_value_error_becomes_400_with_its_message(self):
        with self.raising(ValueError("Pack price is required")):
            response = self.post("save-ingredient")
        self.assertEqual(response.status_code, 400, CONTRACT_MESSAGE)
        self.assertEqual(
            response.json(), {"error": "Pack price is required"}, CONTRACT_MESSAGE
        )

    def test_validation_error_becomes_400_with_first_message(self):
        with self.raising(ValidationError(["First problem", "Second problem"])):
            response = self.post("save-ingredient")
        self.assertEqual(response.status_code, 400, CONTRACT_MESSAGE)
        self.assertEqual(response.json(), {"error": "First problem"}, CONTRACT_MESSAGE)

    def test_integrity_error_becomes_a_generic_409(self):
        # The driver's message names tables, constraints, columns and the
        # conflicting values, so it must never reach the client.
        detail = 'duplicate key value violates unique constraint "forkluck_x_pkey"'
        with self.raising(IntegrityError(detail)):
            with self.assertLogs("forkluck.http.dispatch", level="ERROR") as logs:
                response = self.post("save-ingredient")
        self.assertEqual(response.status_code, 409, CONTRACT_MESSAGE)
        self.assertEqual(
            response.json(),
            {"error": "That change conflicts with existing data.", "code": "conflict"},
            CONTRACT_MESSAGE,
        )
        self.assertNotIn(detail, response.content.decode())
        self.assertIn(detail, "\n".join(logs.output))

    def test_token_crypto_error_becomes_a_generic_reconnect_message(self):
        # The real detail names key ids and env vars, so it must never reach
        # the client.
        with self.raising(TokenCryptoError("missing FORKLUCK_TOKEN_KEY_v3")):
            with self.assertLogs("forkluck.http.dispatch", level="ERROR"):
                response = self.post("save-ingredient")
        self.assertEqual(response.status_code, 400, CONTRACT_MESSAGE)
        self.assertEqual(
            response.json(),
            {
                "error": (
                    "Stored provider credentials could not be read. Reconnect "
                    "the channel in Settings."
                )
            },
            CONTRACT_MESSAGE,
        )

    def test_successful_action_returns_its_payload_verbatim(self):
        def handler(user, body):
            return {"ok": True, "echo": body}

        handler.__name__ = "contract_probe"
        with mock.patch.dict(dispatch.ACTIONS, {"save-ingredient": handler}):
            response = self.post("save-ingredient", body=json.dumps({"a": 1}))
        self.assertEqual(response.status_code, 200, CONTRACT_MESSAGE)
        self.assertEqual(
            response.json(), {"ok": True, "echo": {"a": 1}}, CONTRACT_MESSAGE
        )


class ContractDocumentTests(TestCase):
    def test_contract_doc_lists_exactly_the_registered_slugs(self):
        """The slug inventory in docs/CONTRACT.md is derived, not maintained.

        It was hand-written and had already drifted from ARCHITECTURE.md.
        Reading it back against the registry means the prose cannot fall behind
        the code without a test failing.
        """
        document = (REPO_ROOT / "docs" / "CONTRACT.md").read_text()
        actions_section = document.split("## Actions", 1)[1]
        registered = set(dispatch.ACTIONS)

        # The section backticks field names and literals too ("body", "0"), so
        # the inventory is the hyphenated tokens. Every slug carries a hyphen;
        # pinning that here keeps the extraction honest if one ever does not.
        self.assertEqual(
            {slug for slug in registered if "-" not in slug},
            set(),
            f"slug without a hyphen escapes this inventory. {CONTRACT_MESSAGE}",
        )
        documented = {
            token
            for token in re.findall(r"`([a-z0-9-]+)`", actions_section)
            if "-" in token
        }

        # Both directions: a renamed slug leaves its old name behind in the
        # prose, and comparing only one way lets that stale entry survive.
        self.assertEqual(
            documented - registered,
            set(),
            f"documented slugs that no longer exist. {CONTRACT_MESSAGE}",
        )
        self.assertEqual(
            registered - documented,
            set(),
            f"undocumented slugs. {CONTRACT_MESSAGE}",
        )


class PatchTargetInventoryTests(TestCase):
    """Modules the backend test suite reaches into by dotted path.

    Moving code out of one of these modules silently breaks every
    `mock.patch("forkluck.<module>....")` in the suite by turning it into a
    patch of a name the production path no longer imports. Freezing the list
    makes a domain extraction announce itself here first.
    """

    EXPECTED_PATCH_MODULES = [
        "domains",
        "integrations",
        "management",
        "verification",
    ]

    def test_patch_target_modules_are_frozen(self):
        app_dir = Path(__file__).resolve().parent
        found: set[str] = set()
        for path in sorted(app_dir.glob("test*.py")):
            if path.name == Path(__file__).name:
                continue
            found.update(re.findall(r'["\']forkluck\.([a-zA-Z_]+)', path.read_text()))
        self.assertEqual(sorted(found), self.EXPECTED_PATCH_MODULES, CONTRACT_MESSAGE)
