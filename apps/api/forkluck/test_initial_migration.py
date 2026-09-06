"""The migration chain installs the complete public schema from scratch."""

from importlib import import_module
from pathlib import Path
import os
import sqlite3
import subprocess
import sys
import tempfile

from django.apps import apps
from django.db.migrations.loader import MigrationLoader
from django.test import SimpleTestCase


from .paths import API_ROOT, ROOT as REPO_ROOT

MANAGE_PY = API_ROOT / "manage.py"
INITIAL_NAME = "0001_initial"
INITIAL_MODULE = f"{__package__}.migrations.{INITIAL_NAME}"
# Every migration a fresh install records, in order. Listed rather than read
# off the directory so that an unintended migration — the kind `makemigrations`
# writes when a model and its schema have quietly drifted apart — fails here
# instead of installing itself.
# Retired from the model state but not yet dropped: a destructive change ships
# one release after the code stops naming the table (AGENTS.md, Migrations).
# Drop the table in the next release and take it off this list.
RETIRED_TABLES: set[str] = set()

RECORDED_ROWS = [
    INITIAL_NAME,
    "0002_recipe_nutrition_package",
    "0003_sales_product_identity",
    "0004_backfill_sales_product_public_ids",
    "0005_harden_sales_product_identity",
    "0006_sales_product_component",
    "0007_manual_sales_ledger",
    "0008_payroll_tax_and_unpaid_break",
    "0009_salesproduct_base_unit",
    "0010_rename_listing_models_to_variants",
    "0011_rename_listing_fields_to_variant",
    "0012_sales_product_component_product",
    "0013_backfill_bundle_products",
    "0014_remove_variant_kind_and_member_state",
    "0015_drop_variant_kind_and_member_table",
    "0016_sales_product_sku",
    "0017_backfill_sales_product_sku",
    "0018_remove_sales_product_sku_columns",
    "0019_menu_item_recipe",
    "0020_backfill_menu_item_recipe",
    "0021_remove_menu_item_component_state",
    "0022_drop_menu_item_component_table",
    "0023_billing_account_unlocked_default",
    "0024_fix_billing_locked",
    "0025_recipe_guest_link_role",
    "0026_kitchen_membership",
    "0027_invoice_line_item_key",
    "0028_backfill_invoice_line_item_key",
    "0029_drive_folder_source",
    "0030_expense_category_is_supply",
    "0031_backfill_supply_expense_categories",
    "0032_recipe_book",
    "0033_drive_file_registry",
    "0034_backfill_drive_files",
    "0035_remove_drive_file_skip_state",
    "0036_drive_folder_registered_at",
    "0037_supplier_item_pack_grams_nullable",
    "0038_backfill_supplier_item_pack_grams",
    "0039_drive_file_extraction",
    "0040_invoice_extraction",
    "0041_drop_drive_file_skip_table",
    "0042_invoice_document_fields",
    "0043_drive_file_extraction_parts",
    "0044_remove_catalogingredient_is_seed",
    "0045_invoice_document_key",
    "0046_primo_conversations",
    "0047_ingredient_invoice_price",
    "0048_backfill_ingredient_invoice_prices",
    "0049_fix_receipt_fingerprints",
    "0050_admin_plural_names",
    "0051_invoice_ai_read",
    "0052_receipt_feedback",
    "0053_primo_attachments_feedback",
    "0054_feedback_grant",
]
FINAL_CONNECTOR_MODELS = {
    "ConnectorAuthorizationSession",
    "ConnectorConnection",
    "ConnectorSyncRun",
}
FINAL_CONNECTOR_TABLES = {
    "forkluck_connectorauthorizationsession",
    "forkluck_connectorconnection",
    "forkluck_connectorsyncrun",
}


class InitialMigrationTests(SimpleTestCase):
    def test_migration_chain_state_matches_current_models(self):
        # Before the public baseline, `0001_initial` was the whole chain, so
        # comparing it alone to the models was the same check as comparing
        # the chain. Migrations added after v0.1.0 are preserved rather than
        # folded back into `0001`, so the chain is what a fresh install
        # applies and what the models must agree with.
        initial = import_module(INITIAL_MODULE).Migration(INITIAL_NAME, "forkluck")
        state = MigrationLoader(None, ignore_no_migrations=True).project_state()
        migration_models = {
            model_name
            for app_label, model_name in state.models
            if app_label == "forkluck"
        }
        current_models = {
            model._meta.model_name
            for model in apps.get_app_config("forkluck").get_models()
        }

        self.assertTrue(initial.initial)
        self.assertEqual(migration_models, current_models)
        self.assertTrue(
            {model.__name__ for model in apps.get_app_config("forkluck").get_models()}
            >= FINAL_CONNECTOR_MODELS
        )

    def test_fresh_install_uses_the_initial_migration_and_current_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "initial.sqlite3"
            environment = {
                **os.environ,
                "FORKLUCK_ACCEPTANCE": "1",
                "FORKLUCK_ACCEPTANCE_DB": str(database_path),
            }
            subprocess.run(
                [
                    sys.executable,
                    str(MANAGE_PY),
                    "migrate",
                    "forkluck",
                    "--settings=config.settings_acceptance",
                    "--noinput",
                ],
                check=True,
                cwd=REPO_ROOT,
                env=environment,
            )

            connection = sqlite3.connect(database_path)
            try:
                tables = {
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    )
                }
                rows = [
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM django_migrations "
                        "WHERE app = 'forkluck' ORDER BY name"
                    )
                ]
            finally:
                connection.close()

        expected_forkluck_tables = {
            model._meta.db_table
            for model in apps.get_app_config("forkluck").get_models(
                include_auto_created=True
            )
            if model._meta.managed
        }
        actual_forkluck_tables = {
            table for table in tables if table.startswith("forkluck_")
        } - RETIRED_TABLES

        self.assertTrue(FINAL_CONNECTOR_TABLES <= tables)
        self.assertEqual(actual_forkluck_tables, expected_forkluck_tables)
        self.assertEqual(rows, RECORDED_ROWS)
