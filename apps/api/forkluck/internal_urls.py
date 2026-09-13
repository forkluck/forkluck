from django.urls import path
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from .domains.accounts import google
from .domains.accounts import views as account_views
from .domains.ingredients import views as ingredient_views
from .domains.invoices import drive_system
from .domains.invoices import views as invoice_views
from .domains.labor import views as labor_views
from .domains.primo import views as primo_views
from .domains.recipes import views as recipe_views
from .domains.sales import views as sales_views
from .domains.search import views as search_views
from .domains.workspace import views as workspace_views
from .http import dispatch
from .http.auth import internal_guest, internal_system, internal_user


def internal_get(view):
    """Wrap a plain domain read view for the internal route table.

    Keeps the guard order the decorators used to apply: Django's method
    check runs outside the internal-secret check, so a wrong method still
    answers 405 before the secret is considered.
    """
    return require_GET(internal_user(view))


def guest_get(view):
    """Same guard order, minus the session: the token in the URL authorizes."""
    wrapped = require_GET(internal_guest(view))
    # Set after composition so require_GET's wrapper carries it, which is the
    # callback the route table hands to the guard tests.
    wrapped.guest_capability = True
    return wrapped


def system_get(view):
    """A read the Next process makes as itself: the secret alone authorizes.

    No session is checked and the view never reads `request.user` — a system
    route's workspace is named in the payload, not in a cookie. Marked so the
    guard tests cover it under their own rule.
    """
    wrapped = require_GET(internal_system(view))
    wrapped.system_capability = True
    return wrapped


def system_post(view):
    """The write half of the same category. csrf_exempt because the caller is
    a server with a secret, not a browser with a cookie."""
    wrapped = csrf_exempt(require_POST(internal_system(view)))
    wrapped.system_capability = True
    # What test_tenant_isolation's route walk asks the route with.
    wrapped.post_only = True
    return wrapped


def system_get_post(view):
    """One system path that answers both methods. Django matches a path once,
    so `system/drive-files/` — where the watcher registers what it saw and
    reads back what it still owes a read — is a single entry that dispatches
    on the method itself."""
    wrapped = csrf_exempt(
        require_http_methods(["GET", "POST"])(internal_system(view))
    )
    wrapped.system_capability = True
    return wrapped


urlpatterns = [
    path("session/", internal_get(account_views.internal_session)),
    path("auth-methods/", system_get(google.auth_methods)),
    path("primo/conversations/", internal_get(primo_views.conversation_list)),
    path(
        "primo/conversations/<uuid:conversation_id>/",
        internal_get(primo_views.conversation_detail),
    ),
    path("newsletter/", internal_get(account_views.internal_newsletter)),
    path("search-index/", internal_get(search_views.search_index)),
    path("ingredients/", internal_get(ingredient_views.ingredients)),
    path(
        "ingredients/<str:ingredient_ref>/",
        internal_get(ingredient_views.ingredient_detail),
    ),
    path(
        "ingredient-options/",
        internal_get(ingredient_views.ingredient_options),
    ),
    path(
        "ingredient-tags/",
        internal_get(ingredient_views.ingredient_tags),
    ),
    path(
        "ingredient-categories/",
        internal_get(ingredient_views.ingredient_categories),
    ),
    path(
        "ingredient-measures/",
        internal_get(ingredient_views.ingredient_measures),
    ),
    path(
        "ingredient-duplicates/",
        internal_get(ingredient_views.ingredient_duplicates),
    ),
    path(
        "ingredient-imports/",
        internal_get(ingredient_views.ingredient_imports),
    ),
    path("matches/", internal_get(ingredient_views.matches)),
    path("pricing-entries/", internal_get(ingredient_views.pricing_entries)),
    path("recipes/", internal_get(recipe_views.recipes)),
    path("recipe-health/", internal_get(recipe_views.recipe_health)),
    path("recipes-export/", internal_get(recipe_views.recipes_export)),
    path("dashboard-overview/", internal_get(recipe_views.dashboard_overview)),
    path(
        "recipes/<str:recipe_ref>/cost-diff/",
        internal_get(recipe_views.recipe_cost_diff),
    ),
    path("recipes/<str:recipe_ref>/", internal_get(recipe_views.recipe_detail)),
    path(
        "recipes/<str:recipe_ref>/nutrition/",
        internal_get(recipe_views.recipe_nutrition),
    ),
    path("guest/recipes/<str:token>/", guest_get(recipe_views.guest_recipe)),
    path("guest/books/<str:token>/", guest_get(recipe_views.guest_book)),
    path("recipe-categories/", internal_get(recipe_views.recipe_categories)),
    path("cost-recipes/", internal_get(recipe_views.cost_recipes)),
    path(
        "cost-recipes/<str:recipe_ref>/",
        internal_get(recipe_views.cost_recipe_detail),
    ),
    path(
        "cost-for-recipe/<uuid:recipe_id>/",
        internal_get(recipe_views.cost_recipe_for_recipe),
    ),
    path("recipe-comparisons/", internal_get(recipe_views.saved_comparisons)),
    path(
        "recipe-comparisons/<str:comparison_ref>/",
        internal_get(recipe_views.saved_comparison_detail),
    ),
    path("menus/", internal_get(recipe_views.menus)),
    path("menu/<str:menu_ref>/", internal_get(recipe_views.menu_detail)),
    path(
        "menu/<str:menu_ref>/forecast/",
        internal_get(sales_views.menu_forecast),
    ),
    path("menu-sources/", internal_get(recipe_views.menu_sources)),
    path("menu-component-price/", internal_get(recipe_views.menu_component_price)),
    path("business-settings/", internal_get(workspace_views.business_settings)),
    path("activity/", internal_get(workspace_views.activity)),
    path("kitchen-members/", internal_get(workspace_views.kitchen_members)),
    path("labor-overview/", internal_get(labor_views.labor_overview)),
    path(
        "labor-employees/<uuid:employee_id>/",
        internal_get(labor_views.labor_employee_detail),
    ),
    path("sales-overview/", internal_get(sales_views.sales_overview)),
    path("sales-imports/", internal_get(sales_views.sales_imports)),
    path("pos-connections/", internal_get(sales_views.pos_connections)),
    path("pos-sync-runs/", internal_get(sales_views.pos_sync_runs)),
    path(
        "pos-sync-runs/<uuid:sync_run_id>/",
        internal_get(sales_views.pos_sync_run_detail),
    ),
    path("invoices-overview/", internal_get(invoice_views.invoices_overview)),
    path("invoice-suppliers/", internal_get(invoice_views.invoice_suppliers)),
    path(
        "invoice-line-options/",
        internal_get(invoice_views.invoice_line_options),
    ),
    path("payment-methods/", internal_get(invoice_views.payment_methods)),
    path(
        "invoices/<uuid:invoice_id>/lines/",
        internal_get(invoice_views.invoice_lines),
    ),
    path(
        "invoices/<str:public_id>/",
        internal_get(invoice_views.invoice_detail),
    ),
    path("ai-credential/", internal_get(invoice_views.ai_credential)),
    path("drive-folder/", internal_get(invoice_views.drive_folder)),
    path("drive-files/", internal_get(invoice_views.drive_files)),
    path("supplier-items/", internal_get(invoice_views.supplier_items)),
    path("connector-sync-runs/", internal_get(invoice_views.connector_sync_runs)),
    path(
        "connector-sync-runs/<uuid:run_id>/",
        internal_get(invoice_views.connector_sync_run),
    ),
    path("menu-overview/", internal_get(sales_views.menu_overview)),
    path("menu-items/", internal_get(sales_views.menu_items)),
    path(
        "menu-product-rows/",
        internal_get(sales_views.menu_product_rows),
    ),
    path("product/<str:product_ref>/", internal_get(sales_views.product_detail)),
    path("product-categories/", internal_get(sales_views.product_categories)),
    path(
        "sales-identity-lines/",
        internal_get(sales_views.sales_identity_lines),
    ),
    path("system/drive-watch/", system_get(drive_system.drive_watch)),
    path("system/invoice-ai-usage/", system_post(drive_system.invoice_ai_usage)),
    path(
        "system/drive-watch/save/",
        system_post(drive_system.save_drive_watch),
    ),
    path("system/drive-files/", system_get_post(drive_system.drive_files)),
    path(
        "system/invoice-line-status/",
        system_post(drive_system.invoice_line_status),
    ),
    path(
        "system/drive-extractions/",
        system_post(drive_system.save_drive_extraction),
    ),
    path(
        "system/drive-extractions/failed/",
        system_post(drive_system.fail_drive_extraction),
    ),
    path("actions/<slug:action_name>/", dispatch.action),
]
