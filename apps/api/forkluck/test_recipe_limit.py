"""The Free plan's recipe cap: what counts against it, and who is exempt."""

from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext

from .demo_data import DEMO_EMAIL
from .domains.recipes.actions import (
    action_save_recipe,
    action_update_recipe_statuses,
)
from .domains.shared.billing import EntitlementError
from .models import BillingAccount, Recipe, RecipeShare, User
from .testing import InternalApiTestCase

PASSWORD = "a-long-test-passphrase-2468"
LIMIT_MESSAGE = (
    "You've reached the 10-recipe limit on the Free plan. "
    "Upgrade to create unlimited recipes."
)

BILLING_ON = override_settings(STRIPE_BILLING_ENABLED=True)


def make_user(email: str) -> User:
    return User.objects.create_user(email=email, name="Chef", password=PASSWORD)


def create(user: User, title: str) -> dict:
    return action_save_recipe(user, {"id": None, "title": title})


def fill(user: User, count: int, **fields) -> None:
    Recipe.objects.bulk_create(
        Recipe(user=user, title=f"Recipe {number}", code=f"RCP-{number:04d}", **fields)
        for number in range(1, count + 1)
    )


@BILLING_ON
class RecipeLimitTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = make_user("free@example.com")

    def test_the_tenth_recipe_saves_and_the_eleventh_is_refused(self):
        fill(self.user, 9)
        create(self.user, "Number ten")
        self.assertEqual(Recipe.objects.filter(user=self.user).count(), 10)

        with self.assertRaises(EntitlementError) as caught:
            create(self.user, "Number eleven")
        self.assertEqual(str(caught.exception), LIMIT_MESSAGE)
        self.assertEqual(caught.exception.code, "recipe_limit_reached")
        self.assertEqual(Recipe.objects.filter(user=self.user).count(), 10)

    def test_the_refusal_reaches_the_frontend_as_a_403_with_its_code(self):
        fill(self.user, 10)
        self.client.force_login(self.user)
        response = self.post_internal("save-recipe", {"id": None, "title": "Eleven"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(
            response.json(),
            {"error": LIMIT_MESSAGE, "code": "recipe_limit_reached"},
        )

    def test_archiving_frees_nothing_but_deleting_frees_a_slot(self):
        fill(self.user, 10)
        action_update_recipe_statuses(
            self.user,
            {
                "recipeIds": [str(Recipe.objects.filter(user=self.user).first().id)],
                "status": Recipe.STATUS_ARCHIVED,
            },
        )
        with self.assertRaises(EntitlementError):
            create(self.user, "After archiving")

        Recipe.objects.filter(user=self.user).first().delete()
        create(self.user, "After deleting")
        self.assertEqual(Recipe.objects.filter(user=self.user).count(), 10)

    def test_components_count_against_the_cap(self):
        fill(self.user, 10, kind=Recipe.KIND_COMPONENT)
        with self.assertRaises(EntitlementError):
            create(self.user, "Eleven")

    def test_recipes_shared_to_the_user_do_not_count(self):
        owner = make_user("sharer@example.com")
        fill(owner, 10)
        for recipe in Recipe.objects.filter(user=owner):
            RecipeShare.objects.create(
                recipe=recipe, recipient=self.user, role=RecipeShare.EDITOR
            )
        create(self.user, "My own first")
        self.assertEqual(Recipe.objects.filter(user=self.user).count(), 1)

    def test_an_over_limit_account_keeps_editing_and_archiving_what_it_owns(self):
        fill(self.user, 27)
        BillingAccount.objects.create(user=self.user, status="canceled")
        with self.assertRaises(EntitlementError):
            create(self.user, "Twenty eight")

        owned = Recipe.objects.filter(user=self.user).first()
        action_save_recipe(self.user, {"id": str(owned.id), "title": "Renamed"})
        action_update_recipe_statuses(
            self.user,
            {"recipeIds": [str(owned.id)], "status": Recipe.STATUS_ARCHIVED},
        )
        owned.refresh_from_db()
        self.assertEqual(owned.title, "Renamed")
        self.assertEqual(owned.status, Recipe.STATUS_ARCHIVED)

    def test_paid_staff_and_demo_accounts_create_past_the_cap(self):
        paid = make_user("paid@example.com")
        BillingAccount.objects.create(user=paid, status="active")
        staff = make_user("staff@example.com")
        staff.is_staff = True
        staff.save(update_fields=["is_staff"])
        demo = make_user(DEMO_EMAIL)
        with override_settings(FORKLUCK_ALLOW_DEMO_ACCOUNT=True):
            for user in (paid, staff, demo):
                fill(user, 10)
                create(user, "Eleven")
                self.assertEqual(Recipe.objects.filter(user=user).count(), 11)

    @override_settings(STRIPE_BILLING_ENABLED=False)
    def test_a_self_hosted_install_has_no_cap(self):
        fill(self.user, 10)
        create(self.user, "Eleven")
        self.assertEqual(Recipe.objects.filter(user=self.user).count(), 11)

    def test_the_count_runs_under_the_owner_row_lock_before_the_insert(self):
        # SQLite serializes writers, so the race this guards against only
        # exists on PostgreSQL, where the lock statement carries FOR UPDATE.
        fill(self.user, 5)
        with CaptureQueriesContext(connection) as captured:
            create(self.user, "Locked create")
        statements = [entry["sql"] for entry in captured.captured_queries]
        lock = next(
            index
            for index, sql in enumerate(statements)
            if 'FROM "forkluck_user"' in sql
        )
        count = next(
            index
            for index, sql in enumerate(statements)
            if "COUNT" in sql.upper() and "forkluck_recipe" in sql
        )
        insert = next(
            index
            for index, sql in enumerate(statements)
            if sql.startswith('INSERT INTO "forkluck_recipe"')
        )
        self.assertLess(lock, count)
        self.assertLess(count, insert)
        if connection.features.has_select_for_update:
            self.assertIn("FOR UPDATE", statements[lock])

    def test_an_uncapped_plan_never_takes_the_lock_or_counts(self):
        BillingAccount.objects.create(user=self.user, status="active")
        fill(self.user, 5)
        with CaptureQueriesContext(connection) as captured:
            create(self.user, "Unlocked create")
        statements = [entry["sql"] for entry in captured.captured_queries]
        self.assertFalse([sql for sql in statements if "FOR UPDATE" in sql])
        self.assertFalse(
            [
                sql
                for sql in statements
                if "COUNT" in sql.upper() and "forkluck_recipe" in sql
            ]
        )
