"""One search rule, checked on the ingredient list, the recipe list and the
palette rather than once on whichever endpoint was edited: tokens, fields,
rank before the slice, one row per row, and tenant scoping."""

from .models import (
    Ingredient,
    RecipeLineMatch,
    Recipe,
    RecipeCategory,
    SupplierItem,
    User,
)
from .testing import InternalApiTestCase


class SearchRuleTests(InternalApiTestCase):
    @classmethod
    def setUpTestData(cls) -> None:
        cls.user = User.objects.create_user(
            email="search@example.com",
            name="Search Chef",
            password="a-long-test-passphrase-2468",
        )
        cls.other_user = User.objects.create_user(
            email="other-search@example.com",
            name="Other Chef",
            password="another-long-passphrase-2468",
        )

    def setUp(self) -> None:
        self.client.force_login(self.user)

    def ingredient(self, name: str, *, user: User | None = None) -> Ingredient:
        return Ingredient.objects.create(
            user=user or self.user,
            name=name,
            purchase_cost_cents=1000,
            purchase_size=1,
            purchase_unit="kg",
        )

    def supplier_item(self, ingredient: Ingredient, **fields) -> SupplierItem:
        return SupplierItem.objects.create(
            user=fields.pop("user", self.user),
            ingredient=ingredient,
            supplier=fields.pop("supplier", "acme"),
            external_id=fields.pop("external_id", "SKU-1"),
            title=fields.pop("title", "Supplier wording"),
            raw_size="1 kg",
            pack_price_cents=1000,
            pack_grams=1000,
            pack_amount=1,
            pack_unit="kg",
        )

    def labels(self, path: str, query: str) -> list[str]:
        response = self.get_internal(path, {"q": query})
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        rows = payload["items"]
        if path == "search-index/":
            return [row["label"] for row in rows]
        key = "title" if path.startswith("recipes") else "name"
        return [row[key] for row in rows]

    # --- tokens ------------------------------------------------------------

    def test_every_word_must_be_found_but_the_order_does_not_matter(self):
        self.ingredient("Flour, bread")
        self.ingredient("Almond flour")
        self.assertEqual(self.labels("ingredients/", "bread flour"), ["Flour, bread"])
        self.assertEqual(self.labels("ingredients/", "flour bread"), ["Flour, bread"])
        # A word that is nowhere rules the row out, rather than being ignored.
        self.assertEqual(self.labels("ingredients/", "bread rye"), [])

    def test_tokens_may_land_in_different_fields(self):
        salt = self.ingredient("Sea salt")
        self.supplier_item(salt, title="Maldon flakes", external_id="MALD-1")
        # "maldon" is only on the supplier row, "salt" only on the name.
        self.assertEqual(self.labels("ingredients/", "maldon salt"), ["Sea salt"])

    def test_punctuation_and_accents_fold_on_both_sides(self):
        self.ingredient("Crème fraîche")
        Recipe.objects.create(user=self.user, title="Crème brûlée")
        self.assertEqual(self.labels("ingredients/", "creme"), ["Crème fraîche"])
        self.assertEqual(self.labels("ingredients/", "crème"), ["Crème fraîche"])
        # A recipe title has no normalized twin, so only the typed spelling
        # matches it.
        self.assertEqual(self.labels("recipes/", "crème"), ["Crème brûlée"])
        self.assertEqual(self.labels("recipes/", "creme brulee"), [])

    def test_a_query_of_pure_punctuation_is_not_a_search(self):
        self.ingredient("Sugar")
        self.assertEqual(self.labels("ingredients/", " - "), ["Sugar"])

    # --- rank --------------------------------------------------------------

    def test_relevance_leads_and_survives_the_page_slice(self):
        for name in ("Almond flour", "Flour", "Flour, bread", "Unbleached flour"):
            self.ingredient(name)
        # Alphabetically the exact match is third, so a one-row page proves
        # the ranking ran before the slice.
        first = self.get_internal("ingredients/", {"q": "flour", "limit": "1"})
        self.assertEqual([row["name"] for row in first.json()["items"]], ["Flour"])
        # Both word-start matches, so they tie and fall back to alphabetical.
        self.assertEqual(
            self.labels("ingredients/", "flour"),
            ["Flour", "Flour, bread", "Almond flour", "Unbleached flour"],
        )

    def test_a_chosen_column_outranks_relevance(self):
        for name in ("Almond flour", "Flour"):
            self.ingredient(name)
        chosen = self.get_internal(
            "ingredients/", {"q": "flour", "order": "-name"}
        )
        self.assertEqual(
            [row["name"] for row in chosen.json()["items"]],
            ["Flour", "Almond flour"],
        )

    def test_asking_for_the_default_order_does_not_override_relevance(self):
        # `order=-updatedAt` is a page default, not a merchant's choice.
        for name in ("Almond flour", "Flour"):
            self.ingredient(name)
        defaulted = self.get_internal(
            "ingredients/", {"q": "flour", "order": "-updatedAt"}
        )
        self.assertEqual(
            [row["name"] for row in defaulted.json()["items"]],
            ["Flour", "Almond flour"],
        )

    def test_recipes_rank_the_same_way(self):
        for title in ("Banana bread", "Bread", "Bread, seeded"):
            Recipe.objects.create(user=self.user, title=title)
        self.assertEqual(
            self.labels("recipes/", "bread"),
            ["Bread", "Bread, seeded", "Banana bread"],
        )

    # --- fields and palette parity ----------------------------------------

    def test_the_palette_finds_what_the_lists_find(self):
        pantry = self.ingredient("Sea salt")
        self.supplier_item(pantry, title="Maldon flakes", external_id="MALD-7")
        RecipeLineMatch.objects.create(
            user=self.user, text="finishing salt", ingredient=pantry
        )
        category = RecipeCategory.objects.create(user=self.user, name="Breads")
        Recipe.objects.create(
            user=self.user, title="Sourdough", code="RCP-100", category=category
        )

        for query in ("maldon", "finishing", "sea"):
            self.assertEqual(
                self.labels("ingredients/", query), ["Sea salt"], msg=query
            )
            self.assertEqual(
                self.labels("search-index/", query), ["Sea salt"], msg=query
            )
        for query in ("breads", "rcp-100", "sourdough"):
            self.assertEqual(self.labels("recipes/", query), ["Sourdough"], msg=query)
            self.assertEqual(
                self.labels("search-index/", query), ["Sourdough"], msg=query
            )

    def test_the_palette_keeps_recipes_first_and_ranking_within_a_type(self):
        for title in ("Banana bread", "Bread"):
            Recipe.objects.create(user=self.user, title=title)
        for name in ("Bread flour", "Bread"):
            self.ingredient(name)
        self.assertEqual(
            self.labels("search-index/", "bread"),
            ["Bread", "Banana bread", "Bread", "Bread flour"],
        )

    # --- identity and tenancy ---------------------------------------------

    def test_many_matching_aliases_still_return_one_row(self):
        pantry = self.ingredient("Sea salt")
        for alias in ("salt flakes", "salt coarse", "salt fine"):
            RecipeLineMatch.objects.create(
                user=self.user, text=alias, ingredient=pantry
            )
        self.assertEqual(self.labels("ingredients/", "salt"), ["Sea salt"])
        self.assertEqual(self.labels("search-index/", "salt"), ["Sea salt"])

    def test_another_accounts_wording_never_matches(self):
        mine = self.ingredient("Sea salt")
        theirs = self.ingredient("Their salt", user=self.other_user)
        RecipeLineMatch.objects.create(
            user=self.other_user, text="maldon", ingredient=mine
        )
        self.supplier_item(
            mine,
            title="Their wording",
            external_id="THEIRS-1",
            user=self.other_user,
        )
        self.supplier_item(
            theirs,
            title="Their wording",
            external_id="THEIRS-2",
            user=self.other_user,
        )
        for path in ("ingredients/", "search-index/"):
            self.assertEqual(self.labels(path, "maldon"), [], msg=path)
            self.assertEqual(self.labels(path, "wording"), [], msg=path)

    def test_a_recipe_is_not_found_through_another_accounts_category(self):
        theirs = RecipeCategory.objects.create(
            user=self.other_user, name="Secret category"
        )
        Recipe.objects.create(user=self.user, title="Misfiled", category=theirs)
        for path in ("recipes/", "search-index/"):
            self.assertEqual(self.labels(path, "secret"), [], msg=path)
