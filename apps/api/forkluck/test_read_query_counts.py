"""Pinned query counts for the reads that assemble a tenant-wide snapshot.

Each of these builds one fixed-size picture of a workspace and is the place an
accidental per-row query hides: a `.filter()` chained onto an already
prefetched manager clones the cache away and re-queries. An exact count with a
message is the cheapest guard, and Django prints every captured statement when
it fails.
"""

from datetime import date, timedelta
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from .domains.invoices.views import (
    drive_files,
    drive_folder,
    invoices_overview,
    supplier_items,
)
from .domains.labor.views import labor_overview
from .domains.ingredients.views import ingredient_detail, ingredient_tags, ingredients
from .domains.recipes.health import (
    RecipeHealthReadModel,
    catalog_measure_sources,
    dashboard_overview_json,
)
from .domains.recipes.serializers import cost_recipe_json
from .domains.recipes.views import cost_queryset
from .domains.search.views import search_index
from .domains.workspace.views import kitchen_members
from .models import (
    BenchCostRecipe,
    BenchCostSettings,
    BenchCostStep,
    BenchCostTiming,
    DriveFile,
    DriveFileExtraction,
    Employee,
    EmployeeHourlyRate,
    Ingredient,
    IngredientTag,
    KitchenInvite,
    KitchenMembership,
    Invoice,
    InvoiceLine,
    RecipeLineMatch,
    IngredientMeasure,
    LaborImport,
    Recipe,
    RecipeCategory,
    SupplierItem,
    TimeEntry,
    User,
)
from .testing import internal_payload


class ReadQueryCountTests(TestCase):
    @classmethod
    def setUpTestData(cls) -> None:
        cls.user = User.objects.create_user(
            email="read-counts@example.com",
            password="a-long-test-passphrase-2468",
            name="Read Counts",
        )
        BenchCostSettings.objects.create(user=cls.user)
        category = RecipeCategory.objects.create(
            user=cls.user, name="Pastry", normalized_name="pastry"
        )
        for index in range(4):
            ingredient = Ingredient.objects.create(
                user=cls.user,
                name=f"Butter {index}",
                normalized_name=f"butter {index}",
                purchase_cost_cents=1200,
                purchase_size=1.0,
                purchase_unit="kg",
            )
            RecipeLineMatch.objects.create(
                user=cls.user, text=f"beurre {index}", ingredient=ingredient
            )
            IngredientMeasure.objects.create(
                ingredient=ingredient,
                unit="cup",
                amount=Decimal("1"),
                grams=Decimal("227"),
            )
        for index in range(2):
            Recipe.objects.create(
                user=cls.user,
                title=f"Butter blend {index}",
                code=f"C{index}",
                kind=Recipe.KIND_COMPONENT,
                body=f"200 g Butter {index}",
                yield_amount=200.0,
                yield_unit="g",
            )
        for index in range(4):
            recipe = Recipe.objects.create(
                user=cls.user,
                title=f"Croissant {index}",
                code=f"R{index}",
                category=category,
                body=f"100 g Butter {index}\n50 g Butter blend {index % 2}",
                yield_amount=1200.0,
                yield_unit="g",
                menu_price_cents=450,
            )
            cost_recipe = BenchCostRecipe.objects.create(
                user=cls.user, recipe=recipe, name=recipe.title, batch_yield=12
            )
            for position in range(2):
                step = BenchCostStep.objects.create(
                    recipe=cost_recipe,
                    name=f"Step {position}",
                    covers=1,
                    position=position,
                )
                for seconds in (300, 600):
                    BenchCostTiming.objects.create(
                        step=step, seconds=seconds, yield_count=12
                    )
        labor_import = LaborImport.objects.create(
            user=cls.user, file_name="hours.csv", timezone="America/New_York"
        )
        clock_in = timezone.now() - timedelta(days=2)
        for index in range(3):
            employee = Employee.objects.create(
                user=cls.user, name=f"Baker {index}", normalized_name=f"baker {index}"
            )
            EmployeeHourlyRate.objects.create(
                employee=employee,
                hourly_rate_cents=2500,
                effective_from=date(2026, 1, 1),
            )
            for shift in range(2):
                TimeEntry.objects.create(
                    user=cls.user,
                    employee=employee,
                    labor_import=labor_import,
                    source_position=index * 2 + shift,
                    source_fingerprint=f"fp-{index}-{shift}",
                    clock_in=clock_in + timedelta(hours=shift * 12),
                    clock_out=clock_in + timedelta(hours=shift * 12 + 6),
                    paid_seconds=21600,
                    hourly_rate_cents=2500,
                    labor_cost_cents=15000,
                )
        # The shared measure table is read once per process behind an
        # lru_cache, so whichever test ran first would otherwise own that
        # query.
        catalog_measure_sources()

    def test_recipe_health_read_model_construction(self):
        with self.assertNumQueries(
            8,
            msg="The costing snapshot reads settings, recipes, pantry, the "
            "pantry's preparations, matches and measures once each. The "
            "preparations are a second query because an ingredient has many "
            "of them: joining them onto the pantry row would multiply it",
        ):
            RecipeHealthReadModel(self.user)

    def test_recipe_health_rows_do_not_query_per_row(self):
        model = RecipeHealthReadModel(self.user)
        # The same queryset shape the view pages: the read model must not
        # re-fetch anything the browse query already joined.
        page = list(Recipe.objects.filter(user=self.user).select_related("category"))
        with self.assertNumQueries(
            3,
            msg="Costing a page of rows reads the bench-cost rows, their steps and "
            "their timings once each",
        ):
            model.rows(page)

    def test_dashboard_overview_payload(self):
        with self.assertNumQueries(
            13,
            msg="The landing page must not scale with the recipe table: it "
            "loads every recipe, so a per-recipe query here is unbounded. The "
            "tenth is the one prefetch of the pantry's preparations, and the "
            "normalized item/step prefetches keep authoritative costing flat "
            "in the number of recipes",
        ):
            dashboard_overview_json(RecipeHealthReadModel(self.user, dashboard=True))

    def test_cost_recipes_read(self):
        with self.assertNumQueries(
            3,
            msg="Cost rows prefetch steps and timings; a filter chained onto "
            "either prefetched manager re-queries per step",
        ):
            [cost_recipe_json(row) for row in cost_queryset(self.user)]

    def test_labor_overview_payload(self):
        with self.assertNumQueries(
            15,
            msg="employee_rate_on falls back to a query whenever the rates are "
            "not prefetched, which is what made the import O(rows). Three "
            "resolve the workspace timezone — settings row, newest sale, "
            "newest shift — none growing with rows; a stored zone stops at "
            "the first.",
        ):
            internal_payload(labor_overview, self.user)

    def test_kitchen_members_payload(self):
        member = User.objects.create_user(
            email="kitchen-member@example.com",
            password="a-long-test-passphrase-1357",
            name="Kitchen Member",
            email_verified_at=timezone.now(),
        )
        KitchenMembership.objects.create(owner=self.user, member=member)
        KitchenInvite.objects.create(owner=self.user, email="pending@example.com")
        with self.assertNumQueries(
            2,
            msg="The members dialog reads memberships and invites once each; "
            "reading a member's name off the row rather than through the "
            "select_related would make it one query per member",
        ):
            internal_payload(kitchen_members, self.user)

    def drive_files(self, status: str, count: int) -> None:
        DriveFile.objects.bulk_create(
            DriveFile(
                user=self.user,
                drive_file_id=f"{status}-{index}",
                name=f"{status}-{index}.pdf",
                status=status,
                seen_at=timezone.now(),
            )
            for index in range(count)
        )

    def test_drive_folder_payload(self):
        self.drive_files(DriveFile.Status.SKIPPED, 5)
        with self.assertNumQueries(
            3,
            msg="The Drive card reads the connected folder, the skip list and "
            "the poller's state in one query each, however many files were "
            "skipped",
        ):
            internal_payload(drive_folder, self.user)

    def test_drive_files_payload(self):
        self.drive_files(DriveFile.Status.NEW, 5)
        with self.assertNumQueries(
            2,
            msg="The Drive screen reads one page and the status total; "
            "serializing a row must not reach back for its invoice",
        ):
            internal_payload(drive_files, self.user, query={"status": "new"})

    def test_drive_files_ready_page_joins_the_parts(self):
        self.drive_files(DriveFile.Status.READY, 5)
        DriveFileExtraction.objects.bulk_create(
            DriveFileExtraction(
                drive_file=row,
                document={"supplier": "harbor"},
                extracted_at=timezone.now(),
            )
            for row in DriveFile.objects.filter(user=self.user)
        )
        with self.assertNumQueries(
            3,
            msg="The inbox reads one page, the parts of every row on it and "
            "the document total. Three rather than two since a file may hold "
            "several receipts: what the watcher read is a prefetch for the "
            "whole page, still never one query per file, and the total counts "
            "ready documents in one count of its own",
        ):
            internal_payload(drive_files, self.user, query={"status": "ready"})

    def test_invoices_overview_counts_drive_files_once(self):
        self.drive_files(DriveFile.Status.NEW, 5)
        with self.assertNumQueries(
            36,
            msg="The invoices overview is a fixed set of aggregates plus one "
            "COUNT for each Drive badge — waiting to be read, and read and "
            "waiting to be confirmed; a per-row Drive read would grow the "
            "count with the registry. One additional aggregate reads the "
            "monthly AI usage; billing is disabled in this fixture",
        ):
            internal_payload(invoices_overview, self.user)

    def test_supplier_items_page_is_flat_in_page_size(self):
        ingredient = Ingredient.objects.filter(user=self.user).first()
        invoice = Invoice.objects.create(
            user=self.user,
            supplier="acme",
            supplier_name="Acme Foods",
            invoice_date=date(2026, 1, 15),
            total_cents=1000,
            source_fingerprint="supplier-items-fp",
            file_name="acme.pdf",
        )
        for index in range(6):
            item = SupplierItem.objects.create(
                user=self.user,
                ingredient=ingredient,
                supplier="acme",
                external_id=f"ACME-{index}",
                title=f"Butter {index}",
                raw_size="1 kg",
                pack_price_cents=1200,
                pack_grams=1000,
                pack_amount=Decimal("1"),
                pack_unit="kg",
            )
            InvoiceLine.objects.create(
                user=self.user,
                invoice=invoice,
                position=index,
                sku=item.external_id,
                description=item.title,
                line_amount_cents=1200,
                supplier_item=item,
            )
        for limit in ("2", "6"):
            with self.assertNumQueries(
                4,
                msg="The mapping table reads the supplier names, the page, its "
                "count and one usage aggregate over the page — never one "
                "query per row",
            ):
                internal_payload(
                    supplier_items, self.user, query={"limit": limit}
                )

    def test_search_index_payload(self):
        with self.assertNumQueries(
            2, msg="App-wide search reads recipes and ingredients without separate match-row fetches"
        ):
            internal_payload(search_index, self.user)

    def test_ingredient_list_payload_is_flat_in_row_count(self):
        with self.assertNumQueries(
            10,
            msg="Ingredient browse assembles facets and summaries with fixed joins; "
            "adding pantry rows must not create serializer queries",
        ):
            internal_payload(ingredients, self.user)

    def test_ingredient_tag_vocabulary_is_one_tenant_query(self):
        IngredientTag.objects.create(user=self.user, name="Produce")
        with self.assertNumQueries(
            1,
            msg="The tag picker reads the tenant vocabulary in one ordered query",
        ):
            internal_payload(ingredient_tags, self.user)

    def test_ingredient_detail_payload_joins_profile_relations_once(self):
        ingredient = Ingredient.objects.filter(user=self.user).first()
        with self.assertNumQueries(
            10,
            msg="Ingredient detail prefetches history, suppliers, preparations, "
            "invoice-price references, tags, effective allergens and the custom "
            "nutrition requests "
            "without per-relation queries, and reads the recipe lines naming "
            "it in one more; the products holding the ingredient are a ninth "
            "existing query, the other half of the detail page's Used in. The "
            "invoice shelf is one separate fixed prefetch because it is another "
            "reverse collection; "
            "text-resolved usage is deliberately deferred until delete "
            "confirmation",
        ):
            internal_payload(
                ingredient_detail,
                self.user,
                ingredient_ref=ingredient.public_id,
            )
