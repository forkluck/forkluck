from django.urls import reverse
from django.utils.text import slugify

from .verification import ForkluckAdminSite


class MommyAdminSite(ForkluckAdminSite):
    """The staff console at /mommy/.

    Uses the existing admin email-code permission gate. The admin AppConfig
    loads this site after the app registry is ready.

    Django's index lists every table alphabetically under one "Forkluck"
    heading, which reads as fifty links. Support works by task, so the same
    tables are dealt into these sections, in this order, each with a sentence
    saying what it holds. Names are model class names; a test pins that every
    table admin.py registers sits in exactly one section.
    """

    index_template = "admin/mommy_index.html"

    sections = (
        (
            "Support requests",
            "What users have asked support to do. A nutrition request holds "
            "the label values a user typed for an ingredient no USDA record "
            "matched. Select it and run Apply to make them the ingredient's "
            "nutrition. Receipt feedback includes the original read, the user's "
            "note and their edits at submission; filter thumbs down to investigate problems.",
            ("NutritionRequest", "ReceiptFeedback"),
        ),
        (
            "Accounts",
            "Everyone who can sign in. Staff status is what opens this "
            "console. Deleting a user here also cancels their billing.",
            ("User",),
        ),
        (
            "Sales and POS",
            "Sales pulled in from Square, Shopify or a CSV: each import with "
            "its totals, and the sales lines it created. A sync run is one "
            "requested POS pull and how it ended, so start there when a user "
            "says a sync is stuck. Products are what a kitchen sells, variants "
            "tie POS items to them, components say what a product is made of, "
            "and SKU ignores are POS items a user dismissed.",
            (
                "SalesImport",
                "SalesLine",
                "SyncRun",
                "SalesProduct",
                "SalesProductVariant",
                "SalesProductComponent",
                "SalesSkuIgnore",
            ),
        ),
        (
            "Supplier price lists",
            "Price lists a kitchen uploaded. A supplier item is one pack "
            "matched to one of its ingredients, an ignore is a pack the user "
            "told us to stop offering, and an import is the upload receipt "
            "with the rows it created or updated.",
            (
                "SupplierItem",
                "SupplierItemIgnore",
                "IngredientImport",
                "IngredientImportItem",
            ),
        ),
        (
            "Recipes",
            "A kitchen's recipes and the rows that hang off each one: "
            "ingredient lines, steps and their timings, batch sizes, mass and "
            "volume equivalents, tags, shares with other users, comments and "
            "photos. A recipe line match remembers which pantry ingredient or "
            "component recipe a pasted line resolved to.",
            (
                "Recipe",
                "RecipeItem",
                "RecipeStep",
                "RecipeTiming",
                "RecipeBatchSize",
                "RecipeEquivalency",
                "RecipeTag",
                "RecipeTagMembership",
                "RecipeShare",
                "RecipeComment",
                "RecipeMedia",
                "RecipeLineMatch",
            ),
        ),
        (
            "Bench cost",
            "A recipe's costing record: ingredient and packaging cost, batch "
            "and sellable yield, and the active and passive steps timed to "
            "cost its labor.",
            ("BenchCostRecipe", "BenchCostStep", "BenchCostTiming"),
        ),
        (
            "Pantry",
            "A kitchen's own ingredients: each one's price history and where "
            "every price came from, its household measures, its tags, and any "
            "allergen the kitchen set differently from the catalog.",
            (
                "Ingredient",
                "IngredientPrice",
                "IngredientMeasure",
                "IngredientTag",
                "IngredientTagMembership",
                "IngredientAllergenOverride",
            ),
        ),
        (
            "Menus",
            "Menu worksheets. A menu is a named list for a period. Each item "
            "is one recipe or one product with its sell price and units sold.",
            ("Menu", "MenuItem"),
        ),
        (
            "Labor",
            "Timesheets: employees, their hourly rates over time, the imports "
            "the shifts came from, and each shift as a time entry.",
            ("Employee", "EmployeeHourlyRate", "LaborImport", "TimeEntry"),
        ),
        (
            "Workspace settings",
            "One settings row per kitchen, whatever the name says: wage, "
            "currency, measurement system, food-cost target, overtime and "
            "break rules, and time zone. A currency conversion is the record "
            "of one currency change and the rows it converted.",
            ("BenchCostSettings", "CurrencyConversion"),
        ),
        (
            "Shared catalog",
            "The supplier-neutral catalog every kitchen sees, so an edit here "
            "reaches everyone: approved ingredient identities with their "
            "aliases, allergens, household measures and preparation yields, "
            "plus the products and price history imported from each source.",
            (
                "CatalogSource",
                "CatalogImportBatch",
                "CatalogIngredient",
                "CatalogIngredientAlias",
                "CatalogIngredientAllergen",
                "CatalogIngredientMeasure",
                "CatalogPreparationMeasure",
                "CatalogPreparationYield",
                "CatalogProduct",
                "CatalogPriceObservation",
            ),
        ),
    )

    def get_app_list(self, request, app_label=None):
        app_list = super().get_app_list(request, app_label)
        forkluck = [app for app in app_list if app["app_label"] == "forkluck"]
        if not forkluck:
            return app_list
        app = forkluck[0]
        by_name = {model["object_name"]: model for model in app["models"]}
        index_url = reverse("admin:index", current_app=self.name)
        sections = []
        for title, description, names in self.sections:
            # A table is missing when this staff member holds no permission on
            # it, and a section with nothing left to show is dropped with it.
            models = [by_name[name] for name in names if name in by_name]
            if not models:
                continue
            anchor = slugify(title)
            sections.append(
                {
                    **app,
                    "name": title,
                    "description": description,
                    "anchor": anchor,
                    # The sidebar links each heading to its explanation on the
                    # index. A fragment also keeps the stock "current app"
                    # highlight from lighting every section at once.
                    "app_url": f"{index_url}#{anchor}",
                    "models": models,
                }
            )
        # Django sorts apps by name, which would put Groups above the support
        # queue; the sections lead and the stock apps follow.
        return sections + [app for app in app_list if app is not forkluck[0]]

    def app_index(self, request, app_label, extra_context=None):
        # The page behind the "Forkluck" breadcrumb shows the same sections as
        # the index; the stock title would name only the first of them.
        if app_label == "forkluck":
            extra_context = {"title": "Forkluck administration", **(extra_context or {})}
        return super().app_index(request, app_label, extra_context)
