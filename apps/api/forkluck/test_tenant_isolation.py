"""Every id-taking internal read denies another tenant's object.

An object id is never authorization. Each of these routes takes an id straight
out of the URL, so one loop over all of them is the guard: user B asks for user
A's row and must be told it does not exist.

The second class asserts the guard is even reachable — a route added without
`internal_get` would publish an unauthenticated read, and freezing the route
table alone does not catch that.
"""

import json
import re
import secrets
import uuid
from datetime import date

from django.conf import settings
from django.test import Client

from . import internal_urls
from .domains.recipes.guest_links import hash_guest_token
from .domains.shared.activity import record_event
from .http import dispatch
from .models import (
    BenchCostRecipe,
    Employee,
    Ingredient,
    Invoice,
    Menu,
    Recipe,
    RecipeGuestLink,
    SalesChannelConnection,
    SalesImport,
    SyncRun,
    User,
)
from .testing import InternalApiTestCase

ANY_UUID = "00000000-0000-0000-0000-000000000000"


def _callback_for(path: str):
    """The view a stubbed path came from, so the guard loop can read its flags."""
    for entry in internal_urls.urlpatterns:
        if path == "/internal/v1/" + re.sub(r"<[^>]+>", ANY_UUID, str(entry.pattern)):
            return entry.callback
    return None


def routes() -> list[tuple[str, str]]:
    """Every internal route as (path, method), parameters filled with a stub."""
    found = []
    for entry in internal_urls.urlpatterns:
        path = "/internal/v1/" + re.sub(r"<[^>]+>", ANY_UUID, str(entry.pattern))
        # POST-only routes answer 405 before either guard runs, so ask them
        # the method they accept.
        post_only = entry.callback is dispatch.action or getattr(
            entry.callback, "post_only", False
        )
        method = "POST" if post_only else "GET"
        found.append((path, method))
    return found


class CrossTenantReadTests(InternalApiTestCase):
    @classmethod
    def setUpTestData(cls) -> None:
        cls.owner = User.objects.create_user(
            email="owner@example.com",
            password="a-long-test-passphrase-2468",
            name="Owner",
        )
        cls.stranger = User.objects.create_user(
            email="stranger@example.com",
            password="a-long-test-passphrase-1357",
            name="Stranger",
        )
        recipe = Recipe.objects.create(
            user=cls.owner, title="Croissant", code="R1", body="100 g Butter"
        )
        cost_recipe = BenchCostRecipe.objects.create(
            user=cls.owner, recipe=recipe, name="Croissant cost", batch_yield=12
        )
        employee = Employee.objects.create(
            user=cls.owner, name="Sam Baker", normalized_name="sam baker"
        )
        invoice = Invoice.objects.create(
            user=cls.owner,
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
        connection = SalesChannelConnection.objects.create(
            user=cls.owner,
            provider=SalesImport.Channel.SQUARE,
            provider_account_id="MERCHANT_1",
            access_token_encrypted="envelope",
        )
        sync_run = SyncRun.objects.create(
            user=cls.owner,
            connection=connection,
            provider=SalesImport.Channel.SQUARE,
            provider_account_id="MERCHANT_1",
            status=SyncRun.Status.SUCCEEDED,
            claim_token=uuid.uuid4(),
        )
        # The log line the invoice page reads back through resourceId.
        record_event(
            cls.owner,
            cls.owner,
            "invoice",
            "added",
            resource_id=invoice.id,
            name="Acme Foods · INV-1",
        )
        menu = Menu.objects.create(user=cls.owner, name="Spring")
        ingredient = Ingredient.objects.create(
            user=cls.owner,
            name="Butter",
            normalized_name="butter",
            purchase_cost_cents=1200,
            purchase_size=1.0,
            purchase_unit="kg",
        )
        cls.owned = {
            f"recipes/{recipe.public_id}/": {"item": None},
            f"recipes/{recipe.public_id}/nutrition/": {"item": None},
            f"cost-recipes/{cost_recipe.id}/": {"item": None},
            f"cost-for-recipe/{recipe.id}/": {"id": None},
            f"labor-employees/{employee.id}/": {"item": None},
            f"pos-sync-runs/{sync_run.id}/": {"error": "Not found"},
            f"invoices/{invoice.id}/lines/": {"error": "Invoice not found"},
            f"menu/{menu.public_id}/": {"error": "Menu not found"},
            # The id travels in the query string here, not the path, so the
            # loop's guard only holds if the view scopes what it reads there.
            f"menu-component-price/?ingredientId={ingredient.id}&unit=g": {
                "error": "Ingredient not found"
            },
            # Same shape: the id is a query filter, so the empty page is the
            # denial and only the user scope makes it empty.
            f"activity/?resourceId={invoice.id}": {
                "items": [],
                "nextBefore": None,
            },
        }

    def test_the_owner_reads_every_object(self):
        self.client.force_login(self.owner)
        for path in self.owned:
            with self.subTest(path=path):
                response = self.get_internal(path)
                self.assertEqual(response.status_code, 200)
                self.assertNotEqual(response.json(), self.owned[path])

    def test_another_tenant_reads_none_of_them(self):
        self.client.force_login(self.stranger)
        for path, denial in self.owned.items():
            with self.subTest(path=path):
                response = self.get_internal(path)
                self.assertIn(response.status_code, (200, 404))
                self.assertEqual(response.json(), denial)


class RouteGuardTests(InternalApiTestCase):
    """The internal-secret and session guards wrap every route, not most."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="guard@example.com",
            password="a-long-test-passphrase-2468",
            name="Guard",
        )

    def test_every_route_denies_its_existence_without_the_secret(self):
        self.client.force_login(self.user)
        for path, method in routes():
            with self.subTest(path=path):
                response = self.client.generic(method, path)
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), {"error": "Not found"})

    def test_every_route_requires_a_session(self):
        for path, method in routes():
            callback = _callback_for(path)
            if getattr(callback, "guest_capability", False) or getattr(
                callback, "system_capability", False
            ):
                continue
            with self.subTest(path=path):
                response = Client().generic(
                    method,
                    path,
                    HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
                )
                self.assertEqual(response.status_code, 401)
                self.assertEqual(
                    response.json(), {"error": "Authentication required"}
                )


class SystemRouteTests(InternalApiTestCase):
    """The routes the Next process calls as itself, with no session at all.

    Listed literally rather than derived from the flag, so adding one is a
    deliberate act reviewed here.
    """

    SYSTEM_ROUTES = [
        ("/internal/v1/auth-methods/", "GET", {}),
        (
            "/internal/v1/system/invoice-ai-usage/", "POST",
            {"userId": ANY_UUID, "operation": "reserve", "pages": 1, "attempts": 2},
        ),
        ("/internal/v1/system/drive-watch/", "GET", {}),
        ("/internal/v1/system/drive-watch/save/", "POST", {}),
        (
            "/internal/v1/system/drive-files/",
            "POST",
            {"userId": ANY_UUID, "files": []},
        ),
        # The same path answers the reader's GET; both halves are listed
        # because both are reachable with the secret alone.
        ("/internal/v1/system/drive-files/", "GET", {}),
        (
            "/internal/v1/system/invoice-line-status/",
            "POST",
            {"userId": ANY_UUID, "supplier": "acme", "lines": []},
        ),
        (
            "/internal/v1/system/drive-extractions/",
            "POST",
            {"userId": ANY_UUID, "driveFileId": "file-1", "document": {"a": 1}},
        ),
        (
            "/internal/v1/system/drive-extractions/failed/",
            "POST",
            {"userId": ANY_UUID, "driveFileId": "file-1", "reason": "unreadable"},
        ),
    ]

    def test_the_flagged_routes_are_exactly_the_listed_ones(self):
        flagged = {
            "/internal/v1/" + str(entry.pattern)
            for entry in internal_urls.urlpatterns
            if getattr(entry.callback, "system_capability", False)
        }
        self.assertEqual(flagged, {path for path, _, _ in self.SYSTEM_ROUTES})

    def test_the_secret_is_still_required(self):
        for path, method, body in self.SYSTEM_ROUTES:
            with self.subTest(path=path):
                response = Client().generic(
                    method, path, json.dumps(body), "application/json"
                )
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), {"error": "Not found"})

    def test_the_secret_alone_answers_without_a_session(self):
        # A missing folder is the only thing these may complain about; a 401
        # would mean a system view had reached for request.user.
        for path, method, body in self.SYSTEM_ROUTES:
            with self.subTest(path=path):
                response = Client().generic(
                    method,
                    path,
                    json.dumps(body),
                    "application/json",
                    HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
                )
                self.assertIn(response.status_code, (200, 404))
                self.assertNotEqual(
                    response.json(), {"error": "Authentication required"}
                )


class GuestRouteTests(InternalApiTestCase):
    """The one route the token authorizes instead of a session."""

    @classmethod
    def setUpTestData(cls) -> None:
        cls.owner = User.objects.create_user(
            email="guest-owner@example.com",
            password="a-long-test-passphrase-2468",
            name="Guest Owner",
        )
        cls.recipe = Recipe.objects.create(
            user=cls.owner, title="Shared loaf", code="G1"
        )
        cls.token = secrets.token_urlsafe(32)
        RecipeGuestLink.objects.create(
            recipe=cls.recipe,
            email="guest@example.com",
            token_hash=hash_guest_token(cls.token),
        )

    def test_the_secret_is_still_required(self):
        response = Client().get(f"/internal/v1/guest/recipes/{self.token}/")
        self.assertEqual(response.status_code, 404)

    def test_an_unknown_token_is_not_found(self):
        response = Client().get(
            "/internal/v1/guest/recipes/not-a-real-token/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json(), {"error": "Not found"})

    def test_the_token_reads_the_recipe_without_a_session(self):
        response = Client().get(
            f"/internal/v1/guest/recipes/{self.token}/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["item"]["title"], "Shared loaf")
