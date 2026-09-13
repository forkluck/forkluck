"""Saved comparisons: recipes read side by side, kept by name in the saver's tenant."""

from django.utils import timezone

from .domains.recipes.actions import (
    action_delete_comparison,
    action_save_comparison,
)
from .domains.recipes.views import saved_comparison_detail, saved_comparisons
from .domains.shared.versioning import StaleWriteError
from .models import Recipe, RecipeShare, SavedComparison, User
from .testing import InternalApiTestCase, internal_payload

LIST_QUERIES = 2


class SavedComparisonTests(InternalApiTestCase):
    @classmethod
    def setUpTestData(cls) -> None:
        cls.user = User.objects.create_user(
            email="baker@example.com",
            password="a-long-test-passphrase-2468",
            name="Baker",
        )
        cls.stranger = User.objects.create_user(
            email="stranger@example.com",
            password="a-long-test-passphrase-1357",
            name="Stranger",
        )
        cls.loaf = Recipe.objects.create(
            user=cls.user, title="Country loaf", code="R1", body="500 g Flour"
        )
        cls.brioche = Recipe.objects.create(
            user=cls.user, title="Brioche", code="R2", body="500 g Flour"
        )
        cls.theirs = Recipe.objects.create(
            user=cls.stranger, title="Their bun", code="R3", body="500 g Flour"
        )

    def save(self, **overrides):
        body = {
            "title": "Loaves",
            "view": "formula",
            "baselinePosition": 0,
            "columns": [
                {"recipeId": self.loaf.public_id},
                {"recipeId": self.brioche.public_id},
                {"pastedTitle": "From the book", "pastedText": "500 g flour"},
            ],
        }
        body.update(overrides)
        return action_save_comparison(self.user, body)

    def test_saves_and_reads_back_in_order(self):
        payload = self.save()
        self.assertTrue(payload["publicId"].startswith("cmp_"))
        self.assertEqual(payload["title"], "Loaves")
        self.assertEqual(payload["baselinePosition"], 0)
        self.assertEqual(payload["missingCount"], 0)
        self.assertEqual(
            [
                column["recipe"]["publicId"] if column["recipe"] else None
                for column in payload["columns"]
            ],
            [self.loaf.public_id, self.brioche.public_id, None],
        )
        self.assertEqual(payload["columns"][2]["pastedTitle"], "From the book")
        self.assertEqual(payload["columns"][2]["pastedText"], "500 g flour")
        detail = internal_payload(
            saved_comparison_detail, self.user, comparison_ref=payload["publicId"]
        )
        self.assertEqual(detail, payload)

    def test_a_later_save_replaces_the_columns_and_bumps_the_version(self):
        first = self.save()
        second = action_save_comparison(
            self.user,
            {
                "id": first["id"],
                "expectedEditVersion": first["editVersion"],
                "title": "Loaves, spec",
                "view": "spec",
                "baselinePosition": None,
                "columns": [{"recipeId": self.brioche.public_id}],
            },
        )
        self.assertEqual(second["editVersion"], first["editVersion"] + 1)
        self.assertEqual(second["view"], "spec")
        self.assertIsNone(second["baselinePosition"])
        self.assertEqual(len(second["columns"]), 1)
        with self.assertRaises(StaleWriteError):
            action_save_comparison(
                self.user,
                {
                    "id": first["id"],
                    "expectedEditVersion": first["editVersion"],
                    "title": "Stale",
                    "columns": [{"recipeId": self.loaf.public_id}],
                },
            )

    def test_refuses_more_than_four_columns_or_none(self):
        with self.assertRaisesMessage(ValueError, "at most 4"):
            self.save(
                columns=[{"recipeId": self.loaf.public_id}] * 1
                + [{"pastedTitle": "", "pastedText": f"{n} g flour"} for n in range(4)]
            )
        with self.assertRaisesMessage(ValueError, "at least one"):
            self.save(columns=[])
        with self.assertRaisesMessage(ValueError, "outside the allowed range"):
            self.save(baselinePosition=3)

    def test_refuses_a_recipe_the_saver_cannot_open(self):
        with self.assertRaisesMessage(ValueError, "Recipe not found"):
            self.save(columns=[{"recipeId": self.theirs.public_id}])
        # A recipe shared in is fine to save.
        RecipeShare.objects.create(
            recipe=self.theirs,
            recipient=self.user,
            role=RecipeShare.VIEWER,
        )
        self.user.email_verified_at = timezone.now()
        self.user.save(update_fields=["email_verified_at"])
        payload = self.save(columns=[{"recipeId": self.theirs.public_id}])
        self.assertEqual(payload["columns"][0]["recipe"]["title"], "Their bun")

    def test_a_share_withdrawn_after_the_save_reads_as_a_missing_column(self):
        share = RecipeShare.objects.create(
            recipe=self.theirs,
            recipient=self.user,
            role=RecipeShare.VIEWER,
        )
        self.user.email_verified_at = timezone.now()
        self.user.save(update_fields=["email_verified_at"])
        payload = self.save(
            columns=[
                {"recipeId": self.loaf.public_id},
                {"recipeId": self.theirs.public_id},
            ]
        )
        share.delete()
        detail = internal_payload(
            saved_comparison_detail, self.user, comparison_ref=payload["publicId"]
        )
        self.assertEqual(detail["missingCount"], 1)
        self.assertIsNone(detail["columns"][1]["recipe"])

    def test_the_list_is_two_queries_and_only_the_readers_own(self):
        self.save()
        self.save(title="Buns")
        action_save_comparison(
            self.stranger,
            {"title": "Theirs", "columns": [{"recipeId": self.theirs.public_id}]},
        )
        with self.assertNumQueries(
            LIST_QUERIES,
            msg="1 comparisons + 1 prefetch of columns with recipes; a row must "
            "never fetch its own columns, which would make the list O(rows)",
        ):
            payload = internal_payload(saved_comparisons, self.user)
        self.assertEqual(
            [row["title"] for row in payload["comparisons"]], ["Buns", "Loaves"]
        )
        self.assertEqual(
            payload["comparisons"][0]["columnTitles"],
            ["Country loaf", "Brioche", "From the book"],
        )
        self.assertEqual(payload["comparisons"][0]["columnCount"], 3)

    def test_delete_is_owner_only(self):
        payload = self.save()
        with self.assertRaisesMessage(ValueError, "Comparison not found"):
            action_delete_comparison(self.stranger, {"id": payload["id"]})
        action_delete_comparison(self.user, {"id": payload["id"]})
        self.assertFalse(SavedComparison.objects.filter(id=payload["id"]).exists())

    def test_the_detail_route_is_owner_only(self):
        payload = self.save()
        self.client.force_login(self.stranger)
        response = self.get_internal(f"recipe-comparisons/{payload['publicId']}/")
        self.assertEqual(response.status_code, 404)

    def test_deleting_a_recipe_drops_its_column(self):
        payload = self.save()
        self.brioche.delete()
        detail = internal_payload(
            saved_comparison_detail, self.user, comparison_ref=payload["publicId"]
        )
        self.assertEqual(len(detail["columns"]), 2)
