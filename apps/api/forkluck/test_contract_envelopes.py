"""Key-path pins for the composite payloads the views assemble themselves.

The per-serializer pins in `test_contract.py` cover the rows; these cover the
envelope around them. Six of the largest reads are consumed with a bare
`djangoGet<T>` and no runtime schema, so before this file a renamed or moved
top-level key was caught by nothing.

The last test closes the same gap from the other side: it reads the zod shapes
in `apps/web/lib/backend/schemas.ts` and demands they equal the Python payloads, so
"update the pin, the TypeScript type and the doc together" is enforced rather
than remembered.
"""

import json
import re
import secrets
import uuid
from datetime import date, datetime, timedelta, timezone as datetime_timezone
from decimal import Decimal

from django.db import transaction
from django.test import RequestFactory, TestCase
from django.utils import timezone

from .domains.accounts import google
from .domains.accounts import views as account_views
from .domains.ingredients import actions as ingredient_actions
from .domains.ingredients import views as ingredient_views
from .domains.invoices import drive_system
from .domains.invoices import views as invoice_views
from .domains.labor import serializers as labor
from .domains.labor import views as labor_views
from .domains.primo import views as primo_views
from .domains.recipes import views as recipe_views
from .domains.recipes.guest_links import hash_guest_token
from .domains.sales.core import (
    MENU_OVERVIEW_SECTIONS,
    menu_overview_payload,
    sales_overview_payload,
)
from .domains.sales.forecast import menu_forecast_payload
from .domains.sales import views as sales_views
from .domains.sales.connections import pos_connections_payload
from .domains.sales.pos_sync import sync_run_json, sync_runs_payload
from .domains.shared.activity import record_event
from .domains.search import views as search_views
from .domains.workspace import views as workspace_views
from .models import (
    ConnectorConnection,
    ConnectorSyncRun,
    CatalogIngredient,
    CatalogIngredientAlias,
    CatalogIngredientAllergen,
    CatalogPreparationYield,
    Employee,
    EmployeeHourlyRate,
    ExpenseCategory,
    Ingredient,
    IngredientAllergenOverride,
    IngredientAllergenStatus,
    IngredientCategory,
    IngredientConversion,
    IngredientMeasure,
    IngredientInvoicePrice,
    IngredientPrice,
    IngredientTag,
    Invoice,
    InvoiceLine,
    KitchenInvite,
    KitchenMembership,
    LaborImport,
    Menu,
    MenuItem,
    Preparation,
    PrimoConversation,
    PrimoMessage,
    Recipe,
    RecipeBatchSize,
    RecipeCategory,
    RecipeComment,
    RecipeEquivalency,
    RecipeExternalRef,
    RecipeBook,
    RecipeBookRecipe,
    RecipeGuestLink,
    RecipeItem,
    RecipeLineMatch,
    RecipeMedia,
    RecipeShare,
    RecipeStep,
    RecipeTag,
    RecipeTagMembership,
    RecipeTiming,
    SalesChannelConnection,
    SalesProductVariant,
    SalesImport,
    SalesLine,
    SalesProduct,
    SalesProductComponent,
    SalesProductSku,
    DriveFile,
    DriveFileExtraction,
    DriveFolderSource,
    DriveWatchState,
    Supplier,
    SupplierItem,
    SupplierItemIgnore,
    SyncRun,
    TimeEntry,
    User,
)
from .testing import CONTRACT_MESSAGE, ShapeAssertions, internal_payload, key_paths

from .paths import ROOT as REPO_ROOT, WEB_ROOT  # noqa: F401


def _strip_comments(source: str) -> str:
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return re.sub(r"//[^\n]*", "", source)


def _split_top_level(text: str) -> list[str]:
    parts, depth, current = [], 0, ""
    for char in text:
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        if char == "," and depth == 0:
            parts.append(current)
            current = ""
            continue
        current += char
    return [part.strip() for part in [*parts, current] if part.strip()]


def _inside(expr: str, opener: str) -> str:
    start = expr.index(opener) + len(opener)
    depth = 1
    for index in range(start, len(expr)):
        if expr[index] in "([{":
            depth += 1
        elif expr[index] in ")]}":
            depth -= 1
            if depth == 0:
                return expr[start:index]
    raise ValueError(f"unbalanced zod expression: {expr[:60]}")


def zod_definitions(source: str) -> dict[str, str]:
    """Every `const name = <zod expression>` in schemas.ts, by name."""
    source = _strip_comments(source)
    starts = [
        (match.group(1), match.end(), match.start())
        for match in re.finditer(r"^(?:export )?const (\w+) = ", source, re.M)
    ]
    found = {}
    for index, (name, value_at, _) in enumerate(starts):
        ends_at = starts[index + 1][2] if index + 1 < len(starts) else len(source)
        found[name] = source[value_at:ends_at].strip()
    return found


def zod_paths(
    expr: str,
    definitions: dict[str, str],
    prefix: str = "",
    optional: set[str] | None = None,
) -> list[str]:
    """The key paths a zod expression describes, in key_paths() form."""
    if optional is None:
        optional = set()
    expr = expr.strip()
    if expr.startswith("z.strictObject("):
        found: list[str] = []
        fields = (
            _inside(expr, "z.strictObject(").strip().removeprefix("{").removesuffix("}")
        )
        for entry in _split_top_level(fields):
            if entry.startswith("..."):
                spread = entry[3:].removesuffix(".shape").strip()
                found.extend(
                    zod_paths(definitions[spread], definitions, prefix, optional)
                )
                continue
            key, _, value = entry.partition(":")
            child = f"{prefix}.{key.strip()}" if prefix else key.strip()
            if value.strip().endswith(".optional()"):
                optional.add(child)
            found.extend(zod_paths(value, definitions, child, optional))
        return sorted(found)
    if expr.startswith("z.array("):
        return zod_paths(
            _inside(expr, "z.array("), definitions, f"{prefix}[]", optional
        )
    reference = re.match(r"^(\w+)(?:\.\w+\(\))*$", expr)
    if reference is not None and reference.group(1) in definitions:
        return zod_paths(definitions[reference.group(1)], definitions, prefix, optional)
    return [prefix]


# Schema name -> the Python payload it claims to describe. Nested schemas are
# checked through the root that embeds them; the assertion below fails if a new
# export appears in neither list.
SCHEMA_PAYLOADS = {
    "authMethodsSchema": lambda case: internal_payload(google.auth_methods, case.user),
    "sessionPayloadSchema": lambda case: internal_payload(
        account_views.internal_session, case.user
    ),
    # Ghost is unconfigured under test, which is one of the shapes: both keys
    # are present either way.
    "newsletterStatusSchema": lambda case: internal_payload(
        account_views.internal_newsletter, case.user
    ),
    # Name order, not the page default: the pin reads the first row only, and
    # the fixture's richest ingredient is the one that leads alphabetically.
    "ingredientsPayloadSchema": lambda case: internal_payload(
        ingredient_views.ingredients, case.user, query={"order": "name"}
    ),
    "ingredientPayloadSchema": lambda case: internal_payload(
        ingredient_views.ingredient_detail,
        case.user,
        ingredient_ref=case.ingredient.public_id,
    ),
    "ingredientCategoriesPayloadSchema": lambda case: internal_payload(
        ingredient_views.ingredient_categories, case.user
    ),
    "ingredientTagsPayloadSchema": lambda case: internal_payload(
        ingredient_views.ingredient_tags, case.user
    ),
    "pricingEntriesPayloadSchema": lambda case: internal_payload(
        ingredient_views.pricing_entries, case.user
    ),
    "recipesPayloadSchema": lambda case: internal_payload(
        recipe_views.recipes, case.user
    ),
    "recipeCategoriesPayloadSchema": lambda case: internal_payload(
        recipe_views.recipe_categories, case.user
    ),
    "recipePayloadSchema": lambda case: internal_payload(
        recipe_views.recipe_detail,
        case.user,
        recipe_ref=case.recipe.public_id,
    ),
    "recipeCostDiffPayloadSchema": lambda case: case.recipe_cost_diff_contract(),
    "recipeNutritionPayloadSchema": lambda case: case.recipe_nutrition_both_states(),
    "guestRecipePayloadSchema": lambda case: case.guest_recipe_with_a_linked_line(),
    "guestBookPayloadSchema": lambda case: case.guest_book_with_a_linked_line(),
    "invoiceSuppliersPayloadSchema": lambda case: internal_payload(
        invoice_views.invoice_suppliers, case.user
    ),
    "supplierItemsPayloadSchema": lambda case: internal_payload(
        invoice_views.supplier_items, case.user
    ),
    "supplierItemIgnoresPayloadSchema": lambda case: case.supplier_item_ignores(),
    "driveFolderPayloadSchema": lambda case: case.drive_folder(),
    "driveFilesPayloadSchema": lambda case: case.drive_files(),
    "driveWatchPayloadSchema": lambda case: case.drive_watch(),
    "invoiceDetailPayloadSchema": lambda case: internal_payload(
        invoice_views.invoice_detail, case.user, public_id=case.invoice.public_id
    ),
    "searchIndexPayloadSchema": lambda case: internal_payload(
        search_views.search_index, case.user
    ),
    "catalogIngredientsPayloadSchema": lambda case: case.catalog_search(),
    "catalogActivationSchema": lambda case: case.catalog_activation(),
    "salesOverviewSchema": lambda case: case.sales_overview_both_granularities(),
    "posConnectionsPayloadSchema": lambda case: pos_connections_payload(case.user),
    "posSyncRunsPayloadSchema": lambda case: sync_runs_payload(case.user),
    "posSyncRunPayloadSchema": lambda case: {
        "syncRun": sync_run_json(case.pos_sync_run)
    },
    "connectorSyncRunPayloadSchema": lambda case: case.connector_sync_run(),
    "connectorSyncRunsPayloadSchema": lambda case: case.connector_sync_runs(),
    "menuDetailPayloadSchema": lambda case: case.menu_detail_with_nested_rows(),
    "menuItemsPayloadSchema": lambda case: case.menu_items_with_nested_rows(),
    "menuProductRowsPayloadSchema": lambda case: (
        case.menu_product_rows_with_nested_rows()
    ),
    "productDetailPayloadSchema": lambda case: internal_payload(
        sales_views.product_detail,
        case.user,
        product_ref=case.product_detail.public_id,
        query={"start": "2026-03-01", "end": "2026-03-31"},
    ),
    "productCategoriesPayloadSchema": lambda case: case.product_categories(),
    "menuForecastPayloadSchema": lambda case: case.menu_forecast_with_nested_rows(),
    "activityPayloadSchema": lambda case: case.activity(),
    "kitchenMembersPayloadSchema": lambda case: internal_payload(
        workspace_views.kitchen_members, case.user
    ),
    "primoConversationListSchema": lambda case: case.primo_conversation_list(),
    "primoConversationSchema": lambda case: case.primo_conversation_detail(),
}

NESTED_IN_A_PINNED_SCHEMA = {
    "expansionIssueSchema",
    "supplierItemRowSchema",
    "supplierItemIgnoreRowSchema",
    "driveFolderSchema",
    "driveFileSkipSchema",
    "driveFileRowSchema",
    "driveFilePartSchema",
    "driveWatchSummarySchema",
    "driveWatchFolderSchema",
    "invoiceDetailSchema",
    "invoicePaymentMethodSchema",
    "allergenHintsSchema",
    "dailySalesSchema",
    "salesProductVariantSchema",
    "salesProductSchema",
    "productSkuSchema",
    "catalogIngredientSuggestionSchema",
    "connectorSyncRunSchema",
    "ingredientNutritionSchema",
    "ingredientPriceSchema",
    "ingredientSchema",
    "ingredientSummarySchema",
    "ingredientTagSchema",
    "netSalesTrendSchema",
    "nutritionCompositionSchema",
    "paginationSchema",
    "periodProductSalesSchema",
    "productDetailSchema",
    "productDetailSalesSchema",
    "productComponentSchema",
    "ingredientConversionSchema",
    "preparationSchema",
    "recipeSummarySchema",
    "recipeDetailSchema",
    "recipeNutritionSchema",
    "recipeNutritionLineSchema",
    "nutrientsSchema",
    "salesImportSchema",
    "posConnectionSchema",
    "posSyncReceiptSchema",
    "posSyncRunSchema",
    "primoConversationSummarySchema",
    "supplierItemSchema",
    "supplierSummarySchema",
    "activityResourceTypeSchema",
    "activityEventKindSchema",
}


class EnvelopeContractTests(ShapeAssertions, TestCase):
    """One workspace with a row in every table these payloads read."""

    @classmethod
    def setUpTestData(cls) -> None:
        cls.user = User.objects.create_user(
            email="envelope@example.com",
            password="a-long-test-passphrase-2468",
            name="Envelope Chef",
            # Verified, because a membership is dormant until the address is:
            # an unverified fixture would pin an empty `kitchens` list.
            email_verified_at=timezone.now(),
        )
        category = RecipeCategory.objects.create(
            user=cls.user, name="Pastry", normalized_name="pastry"
        )
        cls.recipe = Recipe.objects.create(
            user=cls.user,
            title="Croissant",
            code="R1",
            category=category,
            body="100 g Butter",
            yield_amount=1200.0,
            yield_unit="g",
            menu_price_cents=450,
        )
        cls.ingredient = ingredient = Ingredient.objects.create(
            user=cls.user,
            name="Butter",
            normalized_name="butter",
            purchase_cost_cents=0,
            purchase_size=None,
            purchase_unit=None,
            nutrition_source="usda_fdc",
            nutrition_source_id="123",
            nutrition_description="Butter, without salt",
            # A package text and, below, a brand-dependent catalog row, so
            # every allergenHints list is pinned with a key in it.
            nutrition_package_ingredients=(
                "CREAM, SALT, WHEAT STARCH. CONTAINS: MILK, WHEAT. "
                "MAY CONTAIN ALMONDS."
            ),
            nutrition_per_100g={
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
            },
            nutrition_updated_at=timezone.now(),
        )
        # Packaging, so a product component exercises the non-edible branch
        # without making the recipe's only nutrition source inedible.
        cls.packaging = packaging = Ingredient.objects.create(
            user=cls.user,
            name="Pastry box",
            normalized_name="pastry box",
            purchase_cost_cents=0,
            purchase_size=None,
            purchase_unit=None,
            non_edible=True,
        )
        IngredientPrice.objects.create(
            ingredient=ingredient,
            purchase_cost_cents=1200,
            purchase_size=1.0,
            purchase_unit="kg",
            effective_at=timezone.now(),
        )
        SupplierItem.objects.create(
            user=cls.user,
            ingredient=ingredient,
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
            is_preferred=False,
        )
        IngredientConversion.objects.create(
            user=cls.user,
            ingredient=ingredient,
            average_weight=False,
            weight_amount=Decimal("1000"),
            weight_unit="Gram (g)",
            volume_amount=Decimal("4.2"),
            volume_unit="Cup (c)",
            each_amount=Decimal("1"),
            each_unit="Each (ea)",
        )
        Preparation.objects.create(
            user=cls.user,
            ingredient=ingredient,
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
        IngredientMeasure.objects.create(
            ingredient=ingredient,
            unit="cup",
            amount=Decimal("1"),
            grams=Decimal("227"),
        )
        tag = IngredientTag.objects.create(
            user=cls.user, name="Dairy", normalized_name="dairy"
        )
        ingredient.tags.add(tag)
        ingredient.category = IngredientCategory.objects.create(
            user=cls.user, name="Dairy", normalized_name="dairy"
        )
        ingredient.save(update_fields=["category", "updated_at"])
        IngredientAllergenOverride.objects.create(
            ingredient=ingredient, allergen="milk", status="contains"
        )
        envelope_butter = CatalogIngredient.objects.create(
            name="Envelope butter", normalized_name="envelope butter", key="envelope-butter"
        )
        CatalogIngredientAllergen.objects.create(
            ingredient=envelope_butter,
            allergen="soy",
            status=IngredientAllergenStatus.CHECK_LABEL,
            source_kind="catalog",
            source_ref="envelope-butter",
        )
        ingredient.catalog_ingredient = envelope_butter
        ingredient.save(update_fields=["catalog_ingredient", "updated_at"])
        RecipeItem.objects.create(
            recipe=cls.recipe,
            kind=RecipeItem.INGREDIENT,
            position=0,
            display_name="Butter",
            quantity=Decimal("100"),
            unit="g",
            ingredient=ingredient,
        )
        recipe_tag = RecipeTag.objects.create(
            user=cls.user, name="Breakfast", normalized_name="breakfast"
        )
        RecipeTagMembership.objects.create(recipe=cls.recipe, tag=recipe_tag)
        RecipeBatchSize.objects.create(
            recipe=cls.recipe, label="Original", scale=1, is_original=True
        )
        RecipeEquivalency.objects.create(
            recipe=cls.recipe,
            mass_amount=100,
            mass_unit="g",
            volume_amount=1,
            volume_unit="cup",
            count_amount=1,
            count_unit="pcs",
            standard=False,
        )
        step = RecipeStep.objects.create(
            recipe=cls.recipe,
            kind=RecipeStep.INSTRUCTION,
            title="Laminate",
            body="Fold the dough",
            labor_kind="active",
            position=0,
        )
        RecipeTiming.objects.create(step=step, seconds=60, yield_count=1)
        RecipeMedia.objects.create(
            recipe=cls.recipe,
            url="https://example.com/croissant.jpg",
            alt_text="Croissant",
        )
        RecipeComment.objects.create(
            recipe=cls.recipe, author=cls.user, body="Keep chilled"
        )
        RecipeExternalRef.objects.create(
            user=cls.user,
            recipe=cls.recipe,
            system=RecipeExternalRef.SYSTEM_SQUARE,
            ref_kind=RecipeExternalRef.KIND_ITEM,
            external_id="croissant",
        )
        collaborator = User.objects.create_user(
            email="recipe-collaborator@example.com",
            password="a-long-test-passphrase-8642",
            name="Recipe Collaborator",
            email_verified_at=timezone.now(),
        )
        RecipeShare.objects.create(
            recipe=cls.recipe,
            recipient=collaborator,
            role=RecipeShare.EDITOR,
        )
        # Three membership rows, one for each direction the payloads read.
        # The kitchen `cls.user` belongs to has no recipes of its own, so
        # every other pinned payload stays byte-identical while the session's
        # `kitchens` list is non-empty.
        KitchenMembership.objects.create(
            owner=User.objects.create_user(
                email="envelope-kitchen-owner@example.com",
                password="a-long-test-passphrase-7531",
                name="Envelope Kitchen Owner",
                email_verified_at=timezone.now(),
            ),
            member=cls.user,
            role=RecipeShare.VIEWER,
        )
        KitchenMembership.objects.create(
            owner=cls.user, member=collaborator, role=RecipeShare.EDITOR
        )
        KitchenInvite.objects.create(
            owner=cls.user,
            email="envelope-invitee@example.com",
            role=RecipeShare.EDITOR,
        )
        cls.guest_token = secrets.token_urlsafe(32)
        RecipeGuestLink.objects.create(
            recipe=cls.recipe,
            email="guest@example.com",
            token_hash=hash_guest_token(cls.guest_token),
        )
        cls.book_token = secrets.token_urlsafe(32)
        # One book holding the fixture recipe, so recipe detail's `bookLinks`
        # is non-empty and the guest book has something to serve.
        book = RecipeBook.objects.create(
            user=cls.user,
            email="guest@example.com",
            title="Envelope book",
            token_hash=hash_guest_token(cls.book_token),
        )
        RecipeBookRecipe.objects.create(book=book, recipe=cls.recipe, position=0)
        parent = Recipe.objects.create(user=cls.user, title="Pastry cream")
        # A parent line so recipe detail's `usedIn` is non-empty.
        RecipeItem.objects.create(
            recipe=parent,
            kind=RecipeItem.SUBRECIPE,
            position=0,
            display_name="Croissant",
            quantity=Decimal("1"),
            unit="pcs",
            subrecipe=cls.recipe,
        )
        RecipeLineMatch.objects.create(
            user=cls.user, text="beurre", ingredient=ingredient
        )
        labor_import = LaborImport.objects.create(
            user=cls.user, file_name="hours.csv", timezone="America/New_York"
        )
        employee = Employee.objects.create(
            user=cls.user, name="Sam Baker", normalized_name="sam baker"
        )
        EmployeeHourlyRate.objects.create(
            employee=employee,
            hourly_rate_cents=2500,
            effective_from=date(2026, 1, 1),
        )
        clock_in = timezone.now() - timedelta(days=1)
        TimeEntry.objects.create(
            user=cls.user,
            employee=employee,
            labor_import=labor_import,
            source_position=0,
            source_fingerprint="fp-1",
            clock_in=clock_in,
            clock_out=clock_in + timedelta(hours=6),
            paid_seconds=21600,
            hourly_rate_cents=2500,
            labor_cost_cents=15000,
        )
        expense_category = ExpenseCategory.objects.create(
            user=cls.user, name="Dairy", normalized_name="dairy", is_ingredient=True
        )
        Supplier.objects.create(
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
            invoice_date=timezone.localdate(),
            total_cents=12000,
            line_count=1,
            matched_line_count=1,
            source_fingerprint="invoice-fp-1",
            file_name="invoice.pdf",
            payment_method="card",
            tax_cents=900,
        )
        invoice_line = InvoiceLine.objects.create(
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
            category=expense_category,
            ingredient=ingredient,
        )
        IngredientInvoicePrice.objects.create(
            user=cls.user,
            ingredient=ingredient,
            invoice_line=invoice_line,
            purchase_size=Decimal("1"),
            purchase_unit="kg",
        )
        connection = SalesChannelConnection.objects.create(
            user=cls.user,
            provider=SalesImport.Channel.SQUARE,
            provider_account_id="MERCHANT_1",
            access_token_encrypted="envelope",
        )
        cls.pos_sync_run = SyncRun.objects.create(
            user=cls.user,
            connection=connection,
            provider=SalesImport.Channel.SQUARE,
            provider_account_id="MERCHANT_1",
            status=SyncRun.Status.SUCCEEDED,
            claim_token=uuid.uuid4(),
            progress={"phase": "succeeded"},
            cursor={"watermark": None, "continuationPasses": 1},
            result={
                "receipt": {
                    "provider": "square",
                    "batchId": None,
                    "batchIds": ["00000000-0000-0000-0000-000000000000"],
                    "imported": 0,
                    "updated": 0,
                    "deduplicated": 0,
                    "trackedLines": 0,
                    "pendingLines": 0,
                    "ignoredLines": 0,
                    "pendingIdentities": 0,
                    "ignoredIdentities": 0,
                    "skippedMalformed": 0,
                    "modifierOccurrences": 0,
                    "modifierOccurrencesAttached": 0,
                    "modifierOccurrencesPending": 0,
                    "pendingModifierIdentities": 0,
                    "skippedModifiersMalformed": 0,
                    "skippedUnmatched": 0,
                    "skippedIgnored": 0,
                    "warnings": 0,
                    "partial": False,
                    "pagesProcessed": 0,
                    "linesFetched": 0,
                    "categoriesBackfilled": 0,
                    "catalogItemCount": 0,
                    "ruleIgnoredIdentities": 0,
                    "periodStart": None,
                    "periodEnd": None,
                }
            },
        )
        sales_import = SalesImport.objects.create(
            user=cls.user,
            file_name="sales.csv",
            channel=SalesImport.Channel.SQUARE,
            provider_account_id="MERCHANT_1",
            timezone="UTC",
        )
        cls.sales_product = product = SalesProduct.objects.create(
            user=cls.user, name="Croissant", normalized_name="croissant"
        )
        SalesProductSku.objects.create(
            user=cls.user, product=product, sku="CROISSANT", normalized_sku="croissant"
        )
        cls.product_detail = detail_product = SalesProduct.objects.create(
            user=cls.user, name="Detail croissant", normalized_name="detail croissant"
        )
        SalesProductSku.objects.create(
            user=cls.user,
            product=detail_product,
            sku="DETAIL-6",
            normalized_sku="detail-6",
            quantity_multiplier=Decimal("6"),
        )
        SalesProductComponent.objects.create(
            product=detail_product,
            recipe=cls.recipe,
            quantity=Decimal("1"),
            position=0,
        )
        SalesProductComponent.objects.create(
            product=detail_product,
            ingredient=packaging,
            quantity=Decimal("1"),
            unit="g",
            position=1,
        )
        # A bundle member, so the product arm of the component row is on the
        # wire the strict TypeScript schema parses.
        SalesProductComponent.objects.create(
            product=detail_product,
            component_product=product,
            quantity=Decimal("2"),
            position=2,
        )
        # A product holding the fixture ingredient directly, so ingredient
        # detail's `usedInProducts` is non-empty.
        SalesProductComponent.objects.create(
            product=detail_product,
            ingredient=ingredient,
            quantity=Decimal("2"),
            unit="g",
            position=3,
        )
        SalesProductVariant.objects.create(
            user=cls.user,
            product=detail_product,
            channel=SalesImport.Channel.SQUARE,
            provider_account_id="MERCHANT_1",
            match_key="square:item:DETAIL_CROISSANT",
            sku="detail-croissant",
            external_name="Detail Croissant",
        )
        manual_import = SalesImport.objects.create(
            user=cls.user,
            file_name="Manual sales 2026-03",
            channel=SalesImport.Channel.MANUAL,
            source=SalesImport.Source.MANUAL,
            timezone="UTC",
            period_start=date(2026, 3, 1),
            period_end=date(2026, 3, 31),
        )
        manual_variant = SalesProductVariant.objects.create(
            user=cls.user,
            product=detail_product,
            channel=SalesImport.Channel.MANUAL,
            match_key=f"manual:item:{detail_product.id}",
            external_name=detail_product.name,
            link_source=SalesProductVariant.LinkSource.SYSTEM,
        )
        SalesLine.objects.create(
            user=cls.user,
            sales_import=manual_import,
            product=detail_product,
            variant=manual_variant,
            channel=SalesImport.Channel.MANUAL,
            source_position=1,
            source_fingerprint="manual-detail-2026-03-10",
            external_order_id="manual-detail-2026-03-10",
            sold_at=datetime(2026, 3, 10, 12, tzinfo=datetime_timezone.utc),
            timezone="UTC",
            item_name=detail_product.name,
            group_key=manual_variant.match_key,
            match_key=manual_variant.match_key,
            quantity=Decimal("1"),
            source_payload={"manual": True, "netProvided": False},
        )
        variant = SalesProductVariant.objects.create(
            user=cls.user,
            product=product,
            channel=SalesImport.Channel.SQUARE,
            provider_account_id="MERCHANT_1",
            match_key="square:item:CROISSANT",
            sku="croissant",
            external_name="Croissant",
        )
        SalesLine.objects.create(
            user=cls.user,
            sales_import=sales_import,
            variant=variant,
            channel=SalesImport.Channel.SQUARE,
            provider_account_id="MERCHANT_1",
            source_position=0,
            source_fingerprint="line-1",
            external_order_id="1",
            sold_at=timezone.now(),
            item_name="Croissant",
            group_key=variant.match_key,
            quantity=Decimal("1"),
            gross_cents=500,
            net_sales_cents=450,
        )
        cls.employee = employee

    def menu_items_with_nested_rows(self) -> dict:
        """The browse page with every nested collection filled.

        An empty list collapses to a bare leaf, so a product with no recipe
        link would stop guarding that shape.
        """
        self._croissant_with_a_recipe()
        return internal_payload(
            sales_views.menu_items, self.user, query={"order": "name"}
        )

    def _croissant_with_a_recipe(self) -> SalesProduct:
        """The fixture product, composed. Both pins want it, so it is idempotent."""
        product = SalesProduct.objects.get(user=self.user, name="Croissant")
        SalesProductComponent.objects.get_or_create(
            product=product,
            recipe=Recipe.objects.filter(user=self.user).first(),
            defaults={"quantity": Decimal("1")},
        )
        return product

    def menu_detail_with_nested_rows(self) -> dict:
        """The worksheet with a product row; its picker sources travel with it.

        The first product by name has to contain another product, or the
        `componentProductIds` list collapses to a bare leaf.
        """
        SalesProductComponent.objects.get_or_create(
            product=self._croissant_with_a_recipe(),
            component_product=self.product_detail,
            defaults={"quantity": Decimal("1")},
        )
        menu = Menu.objects.create(
            user=self.user,
            name="Detail contract",
            period_start=date(2026, 3, 1),
            period_end=date(2026, 3, 31),
        )
        MenuItem.objects.create(
            menu=menu,
            name=self.product_detail.name,
            product=self.product_detail,
            position=0,
            sell_price_cents=450,
            original_sell_price_cents=450,
        )
        return internal_payload(
            recipe_views.menu_detail, self.user, menu_ref=menu.public_id
        )

    def menu_product_rows_with_nested_rows(self) -> dict:
        """The menu worksheet's picker, over the same richly nested rows.

        It answers `{items}` only, and the busiest product leads, which is the
        one the browse fixture fills — key_paths() reads a list's shape from
        its first element.
        """
        self._croissant_with_a_recipe()
        return internal_payload(sales_views.menu_product_rows, self.user)

    def product_categories(self) -> dict:
        """The vocabulary is the categories products carry, so one must."""
        SalesProduct.objects.filter(id=self.sales_product.id).update(
            category="Pastry"
        )
        return internal_payload(sales_views.product_categories, self.user)

    def menu_forecast_with_nested_rows(self) -> dict:
        Ingredient.objects.filter(
            id__in=[self.ingredient.id, self.packaging.id]
        ).update(
            purchase_size=Decimal("1000"),
            purchase_unit="g",
        )
        menu = Menu.objects.create(user=self.user, name="Forecast contract")
        MenuItem.objects.create(
            menu=menu,
            name=self.product_detail.name,
            product=self.product_detail,
            position=0,
            sell_price_cents=0,
            original_sell_price_cents=0,
        )
        MenuItem.objects.create(
            menu=menu,
            name="Unlinked contract row",
            position=1,
            sell_price_cents=0,
            original_sell_price_cents=0,
        )
        return menu_forecast_payload(
            self.user, menu, today=date(2026, 3, 17)
        )

    def recipe_nutrition_both_states(self) -> dict:
        """One payload carrying a built preview and the issues of a blocked one.

        Totals are null while an issue stands, so no single state fills both
        the nutrient shapes and the issue lists. The ready state is the
        fixture recipe with a serving; the blocked state adds an unlinked
        line and drops the serving, and only its issues are spliced in.
        """
        IngredientAllergenOverride.objects.update_or_create(
            ingredient=self.ingredient,
            allergen="egg",
            defaults={"status": "mayContain"},
        )
        Recipe.objects.filter(id=self.recipe.id).update(
            nutrition_serving_amount=Decimal("100"), nutrition_serving_unit="g"
        )
        ready = internal_payload(
            recipe_views.recipe_nutrition, self.user, recipe_ref=self.recipe.public_id
        )
        unlinked = Ingredient.objects.create(
            user=self.user,
            name="Envelope sprinkles",
            normalized_name="envelope sprinkles",
            purchase_cost_cents=0,
        )
        RecipeItem.objects.create(
            recipe=self.recipe,
            kind=RecipeItem.INGREDIENT,
            position=9,
            display_name="Sprinkles",
            quantity=Decimal("1"),
            unit="g",
            ingredient=unlinked,
        )
        Recipe.objects.filter(id=self.recipe.id).update(
            nutrition_serving_amount=None, nutrition_serving_unit=""
        )
        blocked = internal_payload(
            recipe_views.recipe_nutrition, self.user, recipe_ref=self.recipe.public_id
        )
        ready["item"]["issues"] = blocked["item"]["issues"]
        return ready

    def guest_recipe_with_a_linked_line(self) -> dict:
        """The guest read, linked line first.

        key_paths() takes a list's shape from its first element, so the
        sub-recipe block is only pinned when the first line carries one. The
        rows are rolled back because a linked line changes what the other
        pinned reads report, and every builder shares one transaction.
        """
        with transaction.atomic():
            payload = self._guest_recipe_with_a_linked_line()
            transaction.set_rollback(True)
        return payload

    def _guest_recipe_with_a_linked_line(self) -> dict:
        filling = Recipe.objects.create(
            user=self.user,
            title="Almond filling",
            yield_amount=200.0,
            yield_unit="g",
        )
        RecipeItem.objects.create(
            recipe=filling,
            kind=RecipeItem.INGREDIENT,
            position=0,
            display_name="Almond",
            quantity=Decimal("50"),
            unit="g",
        )
        RecipeItem.objects.filter(recipe=self.recipe, position=0).update(position=8)
        RecipeItem.objects.create(
            recipe=self.recipe,
            kind=RecipeItem.SUBRECIPE,
            position=0,
            display_name="Almond filling",
            quantity=Decimal("50"),
            unit="g",
            subrecipe=filling,
        )
        return internal_payload(
            recipe_views.guest_recipe, None, token=self.guest_token
        )

    def guest_book_with_a_linked_line(self) -> dict:
        """The guest book, its one recipe carrying a linked line first.

        Same rollback trick as the single-recipe read, and for the same
        reason: the rows a sub-recipe block needs change what the other
        pinned reads report, and every builder shares one transaction.
        """
        with transaction.atomic():
            # Called for the rows it writes; the book serves the same recipe.
            self._guest_recipe_with_a_linked_line()
            payload = internal_payload(
                recipe_views.guest_book, None, token=self.book_token
            )
            transaction.set_rollback(True)
        return payload

    def sales_overview_both_granularities(self) -> dict:
        """One payload carrying both trend series.

        A request is hourly or daily, never both, so neither payload alone can
        exercise the two series the schema declares.
        """
        today = timezone.localdate()
        payload = sales_overview_payload(self.user)
        ranged = sales_overview_payload(
            self.user, trend_date=today - timedelta(days=1), trend_end_date=today
        )
        payload["netSalesTrend"]["days"] = ranged["netSalesTrend"]["days"]
        return payload

    def catalog_row(self, name):
        # Two rows: activating one moves it into the pantry, which the search
        # then rightly stops offering.
        onion, created = CatalogIngredient.objects.get_or_create(
            normalized_name=name.lower(),
            defaults={"name": name, "key": name.lower().replace(" ", "-")},
        )
        if created:
            CatalogPreparationYield.objects.create(
                ingredient=onion,
                name="diced",
                normalized_name="diced",
                yield_percent=100,
                source_kind="catalog",
                source_ref="usda:170000",
                source_release="v-test",
                derivation="catalog",
                evidence_count=1,
            )
        return onion

    def catalog_search(self):
        leek = self.catalog_row("Envelope leek")
        # A synonym on the row, so the aliases key is pinned with a value in
        # it rather than as an empty list.
        CatalogIngredientAlias.objects.get_or_create(
            ingredient=leek,
            provenance="catalog",
            normalized_text="envelope scallion",
            defaults={"text": "Envelope scallion"},
        )
        return ingredient_actions.action_search_catalog_ingredients(
            self.user, {"query": "envelope leek"}
        )

    def catalog_activation(self):
        return ingredient_actions.action_activate_catalog_ingredient(
            self.user, {"catalogIngredientId": str(self.catalog_row("Envelope chive").id)}
        )

    def activity(self):
        # An empty context: a populated one would pin this workspace's own
        # context keys as though the log declared them.
        record_event(
            self.user,
            self.user,
            "recipe",
            "edited",
            resource_id=self.recipe.id,
            name=self.recipe.title,
        )
        return internal_payload(workspace_views.activity, self.user)

    def recipe_cost_diff_contract(self):
        recipe = Recipe.objects.create(
            user=self.user,
            title="Temporal contract recipe",
            yield_amount=1,
            yield_unit="pcs",
        )
        RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient,
            display_name=self.ingredient.name,
            quantity=Decimal("100"),
            unit="g",
            position=0,
        )
        RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.INGREDIENT,
            display_name="Unresolved contract line",
            quantity=Decimal("1"),
            unit="each",
            position=1,
        )
        return internal_payload(
            recipe_views.recipe_cost_diff,
            self.user,
            recipe_ref=recipe.public_id,
        )

    def supplier_item_ignores(self):
        SupplierItemIgnore.objects.get_or_create(
            user=self.user,
            supplier="acme",
            external_id="acme-napkins",
            defaults={"title": "Napkins 500ct", "raw_size": ""},
        )
        return internal_payload(
            invoice_views.supplier_items, self.user, query={"tab": "ignored"}
        )

    def drive_folder(self):
        DriveFolderSource.objects.get_or_create(
            user=self.user,
            defaults={"folder_id": "folder-1", "folder_name": "kitchen-receipts"},
        )
        DriveFile.objects.get_or_create(
            user=self.user,
            drive_file_id="file-1",
            defaults={
                "name": "linen-bill.pdf",
                "status": DriveFile.Status.SKIPPED,
                "seen_at": timezone.now(),
            },
        )
        # The card's watch line only appears once the poller has saved state.
        DriveWatchState.objects.update_or_create(
            pk=DriveWatchState.SINGLETON_PK,
            defaults={"page_token": "token-1", "polled_at": timezone.now()},
        )
        return internal_payload(invoice_views.drive_folder, self.user)

    def drive_watch(self):
        # The system read: no session, so it is called with a bare request.
        self.drive_folder()
        DriveFolderSource.objects.filter(user=self.user).update(
            registered_at=timezone.now()
        )
        response = drive_system.drive_watch(RequestFactory().get("/"))
        return json.loads(response.content)

    def drive_files(self):
        """Read at `ready`, the one status whose rows carry an extraction: a
        `new` row would pin `extraction` as a bare null and stop guarding the
        shape inside it."""
        row, _ = DriveFile.objects.get_or_create(
            user=self.user,
            drive_file_id="file-new",
            defaults={
                "name": "harbor-2026-08.pdf",
                "mime_type": "application/pdf",
                "size_bytes": 4096,
                "modified_time": timezone.now(),
                "web_view_link": "https://drive.example/file-new",
                "folder_path": "2026-08",
                "status": DriveFile.Status.READY,
                "seen_at": timezone.now(),
            },
        )
        DriveFileExtraction.objects.get_or_create(
            drive_file=row,
            # Empty on purpose: the document is opaque to Django and pinned as
            # one leaf, exactly as the zod schema describes it.
            defaults={
                "document": {},
                "model": "claude-sonnet",
                "extracted_at": timezone.now(),
            },
        )
        return internal_payload(
            invoice_views.drive_files, self.user, query={"status": "ready"}
        )

    def connector_sync_run(self):
        run = self._connector_sync_run()
        return internal_payload(invoice_views.connector_sync_run, self.user, run_id=run.id)

    def _primo_conversation(self) -> PrimoConversation:
        conversation, _ = PrimoConversation.objects.get_or_create(
            user=self.user,
            title="Production planning",
            defaults={"last_message_at": timezone.now()},
        )
        PrimoMessage.objects.get_or_create(
            conversation=conversation,
            user=self.user,
            message_id="envelope-user",
            defaults={
                "role": "user",
                "parts": [{}],
                "text": "Plan mooncakes",
                "metadata": {},
            },
        )
        return conversation

    def primo_conversation_list(self):
        self._primo_conversation()
        return internal_payload(primo_views.conversation_list, self.user)

    def primo_conversation_detail(self):
        conversation = self._primo_conversation()
        return internal_payload(
            primo_views.conversation_detail,
            self.user,
            conversation_id=conversation.id,
        )

    def connector_sync_runs(self):
        self._connector_sync_run()
        return internal_payload(invoice_views.connector_sync_runs, self.user)

    def _connector_sync_run(self) -> ConnectorSyncRun:
        now = timezone.now()
        # Both connector cases run against the same user in one transaction, and
        # a user has at most one connection per provider.
        connection, _ = ConnectorConnection.objects.get_or_create(
            user=self.user,
            provider_key="acme",
            defaults={
                "remote_connection_id": f"connection-{secrets.token_hex(8)}",
                "access_token_encrypted": "opaque-token-envelope",
                "status": ConnectorConnection.Status.CONNECTED,
            },
        )
        run = ConnectorSyncRun.objects.create(
            user=self.user,
            connection=connection,
            remote_run_id=f"run-{secrets.token_hex(8)}",
            status=ConnectorSyncRun.Status.SUCCEEDED,
            progress={
                "pagesDone": 1,
                "documentsSeen": 1,
                "documentsImported": 1,
                "documentsSkipped": 0,
                "linesNeedingReview": 0,
            },
            started_at=now,
            heartbeat_at=now,
            finished_at=now,
        )
        return run

    def test_typescript_schemas_match_the_python_payloads(self):
        """apps/web/lib/backend/schemas.ts describes the same keys Python emits.

        The instruction to "update the pin, the type and the doc together" was
        a docstring; this reads the zod shapes back and makes it a test.
        """
        source = (WEB_ROOT / "lib" / "backend" / "schemas.ts").read_text()
        definitions = zod_definitions(source)
        exported = set(re.findall(r"^export const (\w+Schema) = ", source, re.M))
        self.assertEqual(
            exported,
            set(SCHEMA_PAYLOADS) | NESTED_IN_A_PINNED_SCHEMA,
            f"a zod schema is checked against no Python payload. {CONTRACT_MESSAGE}",
        )
        for name, build in sorted(SCHEMA_PAYLOADS.items()):
            with self.subTest(schema=name):
                optional: set[str] = set()
                declared = set(
                    zod_paths(definitions[name], definitions, optional=optional)
                )
                emitted = set(key_paths(build(self)))
                self.assertEqual(
                    emitted - optional, declared - optional, CONTRACT_MESSAGE
                )

    def test_labor_overview(self):
        self.assertShape(
            internal_payload(labor_views.labor_overview, self.user),
            [
                "comparisonSummary.employeeCount",
                "comparisonSummary.payrollTaxCents",
                "comparisonSummary.totalLaborCostCents",
                "comparisonSummary.totalSeconds",
                "comparisonSummary.uncostedCount",
                "comparisonSummary.uncostedSeconds",
                "comparisonSummary.unpaidBreakSeconds",
                "employees[].currentHourlyRateCents",
                "employees[].currentRateEffectiveFrom",
                "employees[].excludedFromCost",
                "employees[].firstShiftAt",
                "employees[].id",
                "employees[].isActive",
                "employees[].laborCostCents",
                "employees[].lastShiftAt",
                "employees[].name",
                "employees[].normalizedName",
                "employees[].payrollTaxCents",
                "employees[].rateHistory[].effectiveFrom",
                "employees[].rateHistory[].hourlyRateCents",
                "employees[].rateHistory[].id",
                "employees[].shiftCount",
                "employees[].totalSeconds",
                "employees[].uncostedCount",
                "employees[].unpaidBreakSeconds",
                "imports[].canUndo",
                "imports[].createdAt",
                "imports[].createdEmployeeCount",
                "imports[].duplicateCount",
                "imports[].excludedCount",
                "imports[].fileName",
                "imports[].id",
                "imports[].importedCount",
                "imports[].periodEnd",
                "imports[].periodStart",
                "imports[].skippedCount",
                "imports[].source",
                "imports[].timezone",
                "imports[].totalLaborCostCents",
                "imports[].totalRows",
                "imports[].totalSeconds",
                "imports[].uncostedCount",
                "imports[].undoneAt",
                "overtime.byEmployee",
                "overtime.weeklyThresholdMinutes",
                "period.availableDates[]",
                "period.comparison",
                "period.comparisonEnd",
                "period.comparisonStart",
                "period.end",
                "period.start",
                "period.timezone",
                "policy.payrollTaxPercent",
                "policy.unpaidBreakMinutes",
                "policy.unpaidBreakPerHours",
                "summary.employeeCount",
                "summary.payrollTaxCents",
                "summary.totalLaborCostCents",
                "summary.totalSeconds",
                "summary.uncostedCount",
                "summary.uncostedSeconds",
                "summary.unpaidBreakSeconds",
            ],
        )

    def test_labor_employee_detail(self):
        # Pin the reporting period around the seeded shift (clocked in at
        # now - 1 day): the view's previous-week default excludes it on
        # Mondays, which emptied shifts[] and broke the shape every Monday.
        payload = internal_payload(
            labor_views.labor_employee_detail,
            self.user,
            query={
                "start": (timezone.now() - timedelta(days=8)).date().isoformat(),
                "end": timezone.now().date().isoformat(),
            },
            employee_id=self.employee.id,
        )
        self.assertShape(
            payload,
            [
                "item.employee.currentHourlyRateCents",
                "item.employee.currentRateEffectiveFrom",
                "item.employee.excludedFromCost",
                "item.employee.firstShiftAt",
                "item.employee.id",
                "item.employee.isActive",
                "item.employee.laborCostCents",
                "item.employee.lastShiftAt",
                "item.employee.name",
                "item.employee.normalizedName",
                "item.employee.payrollTaxCents",
                "item.employee.rateHistory[].effectiveFrom",
                "item.employee.rateHistory[].hourlyRateCents",
                "item.employee.rateHistory[].id",
                "item.employee.shiftCount",
                "item.employee.totalSeconds",
                "item.employee.uncostedCount",
                "item.employee.unpaidBreakSeconds",
                "item.pagination.limit",
                "item.pagination.page",
                "item.pagination.pages",
                "item.pagination.total",
                "item.period.end",
                "item.period.start",
                "item.period.timezone",
                "item.shifts[].breakSeconds",
                "item.shifts[].unpaidBreakSeconds",
                "item.shifts[].clockIn",
                "item.shifts[].clockOut",
                "item.shifts[].comment",
                "item.shifts[].earningsAdjustmentCents",
                "item.shifts[].employeeId",
                "item.shifts[].employeeName",
                "item.shifts[].hourlyRateCents",
                "item.shifts[].id",
                "item.shifts[].importId",
                "item.shifts[].importTimezone",
                "item.shifts[].laborCostCents",
                "item.shifts[].paidSeconds",
                "item.shifts[].timeAdjustmentSeconds",
            ],
        )

    def test_labor_employee_detail_employee_matches_employee_json(self):
        # The view hand-builds this dict while apps/web/lib/backend/types.ts declares it
        # as EmployeeRow, the shape employee_json produces. They cannot be
        # merged — the view's counts are window-scoped SQL aggregates — so they
        # are pinned to each other instead.
        payload = internal_payload(
            labor_views.labor_employee_detail,
            self.user,
            employee_id=self.employee.id,
        )
        self.assertEqual(
            key_paths(payload["item"]["employee"]),
            key_paths(
                labor.employee_json(
                    Employee.objects.prefetch_related("hourly_rates").get(
                        id=self.employee.id
                    )
                )
            ),
            CONTRACT_MESSAGE,
        )

    def test_invoices_overview(self):
        self.assertShape(
            internal_payload(invoice_views.invoices_overview, self.user),
            [
                "aiKey.configured",
                "aiKey.hint",
                "aiUsage.usedPages",
                "aiUsage.maxPages",
                "aiUsage.resetsOn",
                "aiUsage.exhausted",
                "byCategory[].categoryId",
                "byCategory[].currencyCode",
                "byCategory[].lineCount",
                "byCategory[].name",
                "byCategory[].totalCents",
                "bySupplier[].currencyCode",
                "bySupplier[].invoiceCount",
                "bySupplier[].supplier",
                "bySupplier[].supplierName",
                "bySupplier[].totalCents",
                "categories[].id",
                "categories[].isIngredient",
                "categories[].isSupply",
                "categories[].name",
                "categories[].position",
                "connectors.configured",
                "connectors.connections",
                "connectors.providers",
                "driveNewCount",
                "driveReadyCount",
                "invoices[].createdAt",
                "invoices[].currencyCode",
                "invoices[].documentType",
                "invoices[].driveFileId",
                "invoices[].driveWebViewLink",
                "invoices[].fileName",
                "invoices[].id",
                "invoices[].invoiceDate",
                "invoices[].invoiceNumber",
                "invoices[].issueKind",
                "invoices[].lineCount",
                "invoices[].matchedLineCount",
                "invoices[].publicId",
                "invoices[].source",
                "invoices[].supplier",
                "invoices[].supplierName",
                "invoices[].taxCents",
                "invoices[].totalCents",
                "invoices[].totalDeltaCents",
                "invoices[].unresolvedLineCount",
                "invoices[].updatedAt",
                "month",
                "months[].month",
                "months[].totals[].currencyCode",
                "months[].totals[].totalCents",
                "needsReviewCount",
                "summary[].creditCents",
                "summary[].currencyCode",
                "summary[].invoiceCount",
                "summary[].lineCount",
                "summary[].totalCents",
            ],
        )

    def test_invoice_detail(self):
        self.assertShape(
            internal_payload(
                invoice_views.invoice_detail,
                self.user,
                public_id=self.invoice.public_id,
            ),
            [
                "item.createdAt",
                "item.currencyCode",
                "item.documentKey",
                "item.documentType",
                "item.driveFileId",
                "item.driveFilePart",
                "item.driveWebViewLink",
                "item.dueDate",
                "item.editVersion",
                "item.fileName",
                "item.id",
                "item.invoiceDate",
                "item.invoiceNumber",
                "item.lineCount",
                "item.lines[].categoryId",
                "item.lines[].categoryName",
                "item.lines[].currencyCode",
                "item.lines[].description",
                "item.lines[].id",
                "item.lines[].ingredientId",
                "item.lines[].ingredientName",
                "item.lines[].lineAmountCents",
                "item.lines[].needsReview",
                "item.lines[].packSize",
                "item.lines[].position",
                "item.lines[].priceUpdated",
                "item.lines[].quantity",
                "item.lines[].sku",
                "item.lines[].unit",
                "item.lines[].unitPriceCents",
                "item.matchedLineCount",
                "item.notes",
                "item.paymentMethod",
                "item.publicId",
                "item.source",
                "item.subtotalCents",
                "item.supplier",
                "item.supplierName",
                "item.taxCents",
                "item.totalCents",
                "item.unresolvedLineCount",
            ],
        )

    def test_menu_overview(self):
        self.assertShape(
            menu_overview_payload(self.user, sorted(MENU_OVERVIEW_SECTIONS)),
            [
                "items[].baseUnit",
                "items[].category",
                "items[].components",
                "items[].costed",
                "items[].createdAt",
                "items[].description",
                "items[].editVersion",
                "items[].id",
                "items[].isActive",
                "items[].variants[].attributionPercent",
                "items[].variants[].channel",
                "items[].variants[].externalName",
                "items[].variants[].externalObjectId",
                "items[].variants[].externalVariantTitle",
                "items[].variants[].id",
                "items[].variants[].identityKind",
                "items[].variants[].matchKey",
                "items[].variants[].productExternalObjectId",
                "items[].variants[].providerAccountId",
                "items[].variants[].quantityMultiplier",
                "items[].variants[].sku",
                "items[].name",
                "items[].normalizedName",
                "items[].publicId",
                "items[].recipeLinks",
                "items[].sales.asSoldNetSalesCents",
                "items[].sales.attributedNetSalesCents",
                "items[].sales.discountCents",
                "items[].sales.grossCents",
                "items[].sales.lineCount",
                "items[].sales.netSalesCents",
                "items[].sales.quantity",
                "items[].sales.refundCents",
                "items[].sales.sharedToMembers",
                "items[].sales.splitBasis",
                "items[].sales.taxCents",
                "items[].sales.totalQuantity",
                "items[].sellPriceCents",
                "items[].sku",
                "items[].skus[].id",
                "items[].skus[].position",
                "items[].skus[].quantityMultiplier",
                "items[].skus[].sku",
                "items[].updatedAt",
                "modifierCatalog.lists",
                "modifierCatalog.squareConnected",
                "modifierCatalog.squareNeedsReconnect",
                "modifierCatalog.squareSalesSyncedAt",
                "modifierCatalog.squareSyncedAt",
                "modifierCatalog.unassignedRecords",
                "recipes[].id",
                "recipes[].publicId",
                "recipes[].title",
                "review.categories",
                "review.ignoredCount",
                "review.ignoredItemCount",
                "review.ignoredItems",
                "review.ignoredModifierCount",
                "review.ignoredModifiers",
                "review.items",
                "review.modifierReviewCount",
                "review.modifiers",
                "review.reviewCount",
                "review.reviewMatchCount",
                "rules",
            ],
        )

    def test_menu_overview_recipes_section_stands_alone(self):
        """The create dialog's recipe picker is the whole reason a page hits
        this endpoint without rendering products."""
        recipes_only = menu_overview_payload(self.user, ["recipes"])
        self.assertEqual(recipes_only["items"], [], CONTRACT_MESSAGE)
        self.assertTrue(recipes_only["recipes"], CONTRACT_MESSAGE)

        with_items = menu_overview_payload(self.user, ["items"])
        self.assertEqual(
            with_items["recipes"], recipes_only["recipes"], CONTRACT_MESSAGE
        )

    def test_pos_sync_runs(self):
        self.assertShape(
            sync_runs_payload(self.user),
            [
                "items[].attempts",
                "items[].availableAt",
                "items[].connectionGeneration",
                "items[].cursor.continuationPasses",
                "items[].cursor.watermark",
                "items[].error",
                "items[].finishedAt",
                "items[].heartbeatAt",
                "items[].id",
                "items[].maxAttempts",
                "items[].progress.phase",
                "items[].provider",
                "items[].providerAccountId",
                "items[].queuedAt",
                "items[].result.receipt.batchId",
                "items[].result.receipt.batchIds[]",
                "items[].result.receipt.catalogItemCount",
                "items[].result.receipt.categoriesBackfilled",
                "items[].result.receipt.deduplicated",
                "items[].result.receipt.ignoredIdentities",
                "items[].result.receipt.ignoredLines",
                "items[].result.receipt.imported",
                "items[].result.receipt.linesFetched",
                "items[].result.receipt.modifierOccurrences",
                "items[].result.receipt.modifierOccurrencesAttached",
                "items[].result.receipt.modifierOccurrencesPending",
                "items[].result.receipt.pagesProcessed",
                "items[].result.receipt.partial",
                "items[].result.receipt.pendingIdentities",
                "items[].result.receipt.pendingLines",
                "items[].result.receipt.pendingModifierIdentities",
                "items[].result.receipt.periodEnd",
                "items[].result.receipt.periodStart",
                "items[].result.receipt.provider",
                "items[].result.receipt.ruleIgnoredIdentities",
                "items[].result.receipt.skippedIgnored",
                "items[].result.receipt.skippedMalformed",
                "items[].result.receipt.skippedModifiersMalformed",
                "items[].result.receipt.skippedUnmatched",
                "items[].result.receipt.trackedLines",
                "items[].result.receipt.updated",
                "items[].result.receipt.warnings",
                "items[].startedAt",
                "items[].status",
            ],
        )

    def test_sales_overview(self):
        self.assertShape(
            sales_overview_payload(self.user),
            [
                "dailySales[].channel",
                "dailySales[].currencyCode",
                "dailySales[].discountCents",
                "dailySales[].grossCents",
                "dailySales[].id",
                "dailySales[].itemName",
                "dailySales[].netSalesCents",
                "dailySales[].productId",
                "dailySales[].productName",
                "dailySales[].quantity",
                "dailySales[].refundCents",
                "dailySales[].sku",
                "dailySales[].soldOn",
                "dailySales[].taxCents",
                "imports[].canUndo",
                "imports[].channel",
                "imports[].createdAt",
                "imports[].currencyCode",
                "imports[].discountCents",
                "imports[].duplicateCount",
                "imports[].fileName",
                "imports[].grossCents",
                "imports[].id",
                "imports[].ignoredCount",
                "imports[].importedCount",
                "imports[].netSalesCents",
                "imports[].orderCount",
                "imports[].periodEnd",
                "imports[].periodStart",
                "imports[].providerAccountId",
                "imports[].refundCents",
                "incompleteManualRevenue",
                "imports[].skippedCount",
                "imports[].source",
                "imports[].taxCents",
                "imports[].timezone",
                "imports[].totalRows",
                "imports[].undoneAt",
                "netSalesTrend.availableDates[]",
                "netSalesTrend.comparison",
                "netSalesTrend.comparisonDate",
                "netSalesTrend.comparisonEnd",
                "netSalesTrend.comparisonStart",
                "netSalesTrend.currencyCode",
                "netSalesTrend.currentDate",
                "netSalesTrend.days",
                "netSalesTrend.financials.currentInvoiceCents",
                "netSalesTrend.financials.currentInvoiceCount",
                "netSalesTrend.financials.currentLaborCents",
                "netSalesTrend.financials.previousInvoiceCents",
                "netSalesTrend.financials.previousInvoiceCount",
                "netSalesTrend.financials.previousLaborCents",
                "netSalesTrend.granularity",
                "netSalesTrend.hours[].currentShopifyCents",
                "netSalesTrend.hours[].currentManualCents",
                "netSalesTrend.hours[].currentSquareCents",
                "netSalesTrend.hours[].hour",
                "netSalesTrend.hours[].previousShopifyCents",
                "netSalesTrend.hours[].previousManualCents",
                "netSalesTrend.hours[].previousSquareCents",
                "netSalesTrend.periodEnd",
                "netSalesTrend.periodStart",
                "netSalesTrend.previousDate",
                "netSalesTrend.timezone",
                "scope.currencyCode",
                "scope.excludedSkuCount",
                "scope.ignoredLineCount",
                "scope.ignoredNetSalesCents",
                "scope.ignoredSkuCount",
                "scope.pendingLineCount",
                "scope.pendingModifierCount",
                "scope.pendingModifierOccurrenceCount",
                "scope.pendingNetSalesCents",
                "scope.pendingSkuCount",
                "summary.currencyCode",
                "summary.discountCents",
                "summary.excludedLineCount",
                "summary.grossCents",
                "summary.lineCount",
                "summary.netSalesCents",
                "summary.orderCount",
                "summary.quantity",
                "summary.refundCents",
                "summary.taxCents",
                "topProducts[].channel",
                "topProducts[].netSalesCents",
                "topProducts[].productId",
                "topProducts[].productName",
                "topProducts[].quantity",
                "topProducts[].sharedToMembers",
            ],
        )
