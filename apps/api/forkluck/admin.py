import json

from django import forms
from django.contrib import admin, messages
from django.utils import timezone
from django.utils.html import format_html, format_html_join
from django.contrib.auth.admin import UserAdmin

from .domains.accounts.billing import delete_user_with_billing
from .domains.shared.locking import lock_workspace
from .models import (
    NutritionRequest,
    ReceiptFeedback,
    BenchCostRecipe,
    BenchCostSettings,
    BenchCostStep,
    BenchCostTiming,
    CatalogImportBatch,
    CatalogIngredient,
    CatalogIngredientAlias,
    CatalogIngredientAllergen,
    CatalogIngredientMeasure,
    CatalogPreparationMeasure,
    CatalogPreparationYield,
    CatalogPriceObservation,
    CatalogProduct,
    CatalogSource,
    CurrencyConversion,
    Employee,
    EmployeeHourlyRate,
    Ingredient,
    IngredientAllergenOverride,
    IngredientImport,
    IngredientImportItem,
    IngredientMeasure,
    IngredientPrice,
    IngredientTag,
    IngredientTagMembership,
    RecipeLineMatch,
    RecipeBatchSize,
    RecipeComment,
    RecipeEquivalency,
    RecipeItem,
    RecipeMedia,
    RecipeShare,
    RecipeStep,
    RecipeTag,
    RecipeTagMembership,
    RecipeTiming,
    LaborImport,
    Menu,
    MenuItem,
    Recipe,
    SalesProductVariant,
    SalesImport,
    SalesLine,
    SalesProduct,
    SalesProductComponent,
    SalesSkuIgnore,
    SyncRun,
    SupplierItem,
    SupplierItemIgnore,
    TimeEntry,
    User,
)


@admin.register(User)
class ForkluckUserAdmin(UserAdmin):
    ordering = ("email",)
    list_display = ("email", "name", "is_staff", "is_active", "date_joined")
    search_fields = ("email", "name")
    fieldsets = (
        (None, {"fields": ("email", "password")}),
        ("Profile", {"fields": ("name",)}),
        (
            "Permissions",
            {
                "fields": (
                    "is_active",
                    "is_staff",
                    "is_superuser",
                    "groups",
                    "user_permissions",
                )
            },
        ),
        ("Dates", {"fields": ("last_login", "date_joined")}),
    )
    add_fieldsets = (
        (
            None,
            {
                "classes": ("wide",),
                "fields": ("email", "name", "password1", "password2"),
            },
        ),
    )

    def delete_view(self, request, object_id, extra_context=None):
        # Django's default POST wrapper opens one transaction around
        # delete_model(). Billing cancellation is provider I/O, so this model's
        # lifecycle deliberately uses the same protected admin view without
        # that outer transaction; the domain command owns its short local
        # transactions before and after the external effects.
        return self._delete_view(request, object_id, extra_context)

    def delete_model(self, request, obj) -> None:
        delete_user_with_billing(obj)

    def delete_queryset(self, request, queryset) -> None:
        # QuerySet.delete() bypasses the provider lifecycle. Each account is a
        # separate recoverable command so a failure never deletes an uncancelled
        # user merely because it shared an admin bulk selection.
        for user in queryset.order_by("pk"):
            delete_user_with_billing(user)


@admin.register(Recipe)
class RecipeAdmin(admin.ModelAdmin):
    list_display = (
        "title",
        "category",
        "user",
        "yield_amount",
        "yield_unit",
        "updated_at",
    )
    search_fields = ("title", "user__email")
    list_filter = ("category", "yield_unit")


@admin.register(Ingredient)
class IngredientAdmin(admin.ModelAdmin):
    list_display = (
        "name",
        "user",
        "purchase_cost_cents",
        "purchase_size",
        "purchase_unit",
        "nutrition_source",
    )
    search_fields = ("name", "user__email")


@admin.register(ReceiptFeedback)
class ReceiptFeedbackAdmin(admin.ModelAdmin):
    list_display = ("file_name", "supplier_name", "rating", "reviewed", "user", "created_at")
    list_filter = ("rating", "reviewed", "extraction_model")
    search_fields = ("file_name", "supplier_name", "note", "user__email")
    readonly_fields = (
        "user", "rating", "note", "file_name", "supplier_name", "extraction_model",
        "changes", "original", "corrected", "extraction", "created_at", "updated_at",
    )
    fields = readonly_fields + ("reviewed",)

    def has_add_permission(self, request):
        return False

    @admin.display(description="Edits at submission")
    def changes(self, obj):
        changes = []

        def compare(before, after, label="", depth=0):
            if before == after:
                return
            if depth < 6 and isinstance(before, dict) and isinstance(after, dict):
                for key in dict.fromkeys([*before, *after]):
                    compare(before.get(key), after.get(key), f"{label} / {key}".strip(" /"), depth + 1)
            elif depth < 6 and isinstance(before, list) and isinstance(after, list):
                for index in range(max(len(before), len(after))):
                    compare(
                        before[index] if index < len(before) else None,
                        after[index] if index < len(after) else None,
                        f"{label} {index + 1}",
                        depth + 1,
                    )
            else:
                changes.append((label, json.dumps(before, ensure_ascii=False), json.dumps(after, ensure_ascii=False)))

        compare(obj.original, obj.corrected)
        if not changes:
            return "No edits were included. See the user's note for the reported problem."
        return format_html(
            "<table><thead><tr><th>Field</th><th>Original</th><th>At submission</th></tr></thead><tbody>{}</tbody></table>",
            format_html_join("", "<tr><td>{}</td><td>{}</td><td>{}</td></tr>", changes),
        )


@admin.register(NutritionRequest)
class NutritionRequestAdmin(admin.ModelAdmin):
    """Custom nutrition values waiting for support to apply."""

    list_display = ("ingredient", "user", "status", "created_at")
    list_filter = ("status",)
    search_fields = ("ingredient__name", "user__email")
    readonly_fields = ("values", "per_100g", "created_at", "resolved_at")
    actions = ("apply_requests", "apply_requests_overwriting", "dismiss_requests")

    def _apply(self, request, queryset, *, force: bool) -> None:
        applied = 0
        for row in queryset.filter(status=NutritionRequest.Status.PENDING):
            try:
                row.apply(force=force)
            except ValueError as exc:
                self.message_user(
                    request, f"{row.ingredient}: {exc}", level=messages.WARNING
                )
                continue
            applied += 1
        self.message_user(request, f"Applied {applied} request(s).")

    @admin.action(description="Apply to the ingredient")
    def apply_requests(self, request, queryset):
        self._apply(request, queryset, force=False)

    @admin.action(description="Apply, overwriting a newer link")
    def apply_requests_overwriting(self, request, queryset):
        self._apply(request, queryset, force=True)

    @admin.action(description="Dismiss")
    def dismiss_requests(self, request, queryset):
        count = queryset.filter(status=NutritionRequest.Status.PENDING).update(
            status=NutritionRequest.Status.DISMISSED, resolved_at=timezone.now()
        )
        self.message_user(request, f"Dismissed {count} request(s).")


admin.site.register(IngredientAllergenOverride)
admin.site.register(IngredientPrice)
admin.site.register(IngredientMeasure)
admin.site.register(IngredientTag)
admin.site.register(IngredientTagMembership)
admin.site.register(RecipeLineMatch)
admin.site.register(RecipeItem)
admin.site.register(RecipeStep)
admin.site.register(RecipeTiming)
admin.site.register(RecipeBatchSize)
admin.site.register(RecipeEquivalency)
admin.site.register(RecipeTag)
admin.site.register(RecipeTagMembership)
admin.site.register(RecipeShare)
admin.site.register(RecipeComment)
admin.site.register(RecipeMedia)
admin.site.register(SupplierItem)
admin.site.register(SupplierItemIgnore)
admin.site.register(IngredientImport)
admin.site.register(IngredientImportItem)
admin.site.register(CatalogSource)
admin.site.register(CatalogImportBatch)
admin.site.register(CatalogIngredient)
admin.site.register(CatalogIngredientAlias)
admin.site.register(CatalogIngredientAllergen)
admin.site.register(CatalogIngredientMeasure)
admin.site.register(CatalogPreparationMeasure)
admin.site.register(CatalogPreparationYield)
admin.site.register(CatalogProduct)
admin.site.register(CatalogPriceObservation)
admin.site.register(BenchCostSettings)
admin.site.register(BenchCostRecipe)
admin.site.register(BenchCostStep)
admin.site.register(BenchCostTiming)
admin.site.register(CurrencyConversion)
admin.site.register(Employee)
admin.site.register(EmployeeHourlyRate)
admin.site.register(LaborImport)
admin.site.register(TimeEntry)
admin.site.register(SalesImport)
admin.site.register(SalesProduct)


class SalesProductComponentForm(forms.ModelForm):
    def clean(self):
        cleaned = super().clean()
        product = cleaned.get("product")
        if product is not None:
            owners = {product.user_id: product.user}
            if not self.instance._state.adding:
                previous = self.instance.product
                owners[previous.user_id] = previous.user
            # The admin POST already owns a transaction. Lock before
            # ModelForm._post_clean calls the model's graph validation, and
            # retain it through save so staff and product editors agree.
            for owner_id in sorted(owners):
                lock_workspace(owners[owner_id])
        return cleaned


@admin.register(SalesProductComponent)
class SalesProductComponentAdmin(admin.ModelAdmin):
    form = SalesProductComponentForm


admin.site.register(Menu)
admin.site.register(MenuItem)
admin.site.register(SalesProductVariant)
admin.site.register(SalesLine)
admin.site.register(SalesSkuIgnore)
admin.site.register(SyncRun)
