from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class MenuLinkBackfillMigrationTests(TransactionTestCase):
    """0020 links a row whose whole composition was one recipe; nothing else."""

    migrate_from = ("forkluck", "0019_menu_item_recipe")
    migrate_to = ("forkluck", "0020_backfill_menu_item_recipe")

    def setUp(self) -> None:
        super().setUp()
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_from])
        apps = executor.loader.project_state([self.migrate_from]).apps
        User = apps.get_model("forkluck", "User")
        Recipe = apps.get_model("forkluck", "Recipe")
        Ingredient = apps.get_model("forkluck", "Ingredient")
        SalesProduct = apps.get_model("forkluck", "SalesProduct")
        Menu = apps.get_model("forkluck", "Menu")
        MenuItem = apps.get_model("forkluck", "MenuItem")
        MenuItemComponent = apps.get_model("forkluck", "MenuItemComponent")

        user = User.objects.create(
            email="menu-links@example.com",
            name="Links",
            password="!",
            first_name="",
            last_name="",
        )
        self.croissant = Recipe.objects.create(user=user, title="Croissant")
        scone = Recipe.objects.create(user=user, title="Scone")
        butter = Ingredient.objects.create(
            user=user, name="Butter", normalized_name="butter", purchase_cost_cents=0
        )
        product = SalesProduct.objects.create(
            user=user, name="Box", normalized_name="box"
        )
        menu = Menu.objects.create(user=user, name="Spring")

        def row(name, product=None):
            return MenuItem.objects.create(
                menu=menu,
                name=name,
                sell_price_cents=100,
                original_sell_price_cents=100,
                product=product,
            )

        def component(item, position, **link):
            MenuItemComponent.objects.create(
                item=item, position=position, quantity=1, **link
            )

        self.single = row("One recipe")
        component(self.single, 0, recipe=self.croissant)
        self.product_row = row("Product with a recipe copy", product=product)
        component(self.product_row, 0, recipe=self.croissant)
        self.pair = row("Two recipes")
        component(self.pair, 0, recipe=self.croissant)
        component(self.pair, 1, recipe=scone)
        self.pantry = row("One ingredient")
        component(self.pantry, 0, ingredient=butter, unit="g")
        self.bare = row("Nothing")

    def tearDown(self) -> None:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def test_only_a_lone_recipe_component_becomes_the_link(self) -> None:
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_to])
        MenuItem = executor.loader.project_state([self.migrate_to]).apps.get_model(
            "forkluck", "MenuItem"
        )
        links = dict(MenuItem.objects.values_list("name", "recipe_id"))
        self.assertEqual(
            links,
            {
                "One recipe": self.croissant.id,
                "Product with a recipe copy": None,
                "Two recipes": None,
                "One ingredient": None,
                "Nothing": None,
            },
        )
        self.assertIsNotNone(
            MenuItem.objects.get(name="Product with a recipe copy").product_id
        )
