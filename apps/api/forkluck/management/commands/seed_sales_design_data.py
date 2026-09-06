"""Populate the local demo workspace with believable sales for design work."""

from collections import defaultdict
from datetime import datetime, time, timedelta
from decimal import Decimal
import random
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from django.db.models import Count, Sum
from django.utils import timezone

from forkluck.demo_data import DEMO_EMAIL
from forkluck.domains.sales.core import group_key_part, item_object_match_key
from forkluck.models import (
    Ingredient,
    Menu,
    MenuItem,
    Recipe,
    SalesImport,
    SalesLine,
    SalesProduct,
    SalesProductComponent,
    SalesProductSku,
    SalesProductVariant,
    User,
    normalized_name,
)


SAMPLE_PRODUCTS = [
    ("Latte", "LATTE", 550, "Beverages"),
    ("Cold Brew", "COLD-BREW", 625, "Beverages"),
    ("Focaccia slice", "FOCACCIA", 575, "Savory"),
    ("Chocolate Cream Tart box", "TART-BOX", 3200, "Pastry"),
    ("Brown Butter Cookie", "COOKIE-BB", 425, "Pastry"),
    ("Lemon Poppyseed Loaf", "LOAF-LEMON", 750, "Pastry"),
]
UNMATCHED_ITEMS = [
    ("Sparkling water", "WATER-SPARK", 325, "Beverages"),
    ("Catering delivery", "CATERING-DELIVERY", 1800, "Services"),
]
# (channel, variation title) per product; the drinks come in two sizes.
SAMPLE_VARIANTS = {
    "LATTE": [("square", "Small"), ("square", "Large"), ("shopify", "")],
    "COLD-BREW": [("square", "Small"), ("square", "Large")],
    "FOCACCIA": [("square", "")],
    "TART-BOX": [("square", ""), ("shopify", "")],
    "COOKIE-BB": [("square", ""), ("shopify", "")],
    "LOAF-LEMON": [("shopify", "")],
}
# (pack SKU, units per sale) per product, sold on Square under its own code so
# the product page shows the auto link the pack SKU makes.
SAMPLE_PACK_SKUS = {"COOKIE-BB": [("COOKIE-BB-6", "6")]}
# (kind, name, quantity, unit) per product; "supply" takes any non-edible
# ingredient. Names missing from the demo workspace are skipped.
SAMPLE_COMPONENTS = {
    "LATTE": [
        ("ingredient", "Whole Milk", "200", "ml"),
        ("recipe", "Espresso", "1", ""),
        ("supply", "", "1", "each"),
    ],
    "COLD-BREW": [
        ("ingredient", "Coffee", "20", "g"),
        ("ingredient", "Whole Milk", "30", "ml"),
    ],
    "FOCACCIA": [
        ("recipe", "Focaccia", "1", ""),
        ("ingredient", "Unsalted Butter", "10", "g"),
    ],
    "TART-BOX": [
        ("product", "Brown Butter Cookie", "6", ""),
        ("supply", "", "1", "each"),
    ],
    "COOKIE-BB": [("recipe", "Sea Salt Chocolate Chip Cookies", "1", "")],
    "LOAF-LEMON": [
        ("recipe", "Lemon Poppyseed Loaf", "1", ""),
        ("ingredient", "Whole Eggs", "2", "each"),
    ],
}
SAMPLE_PREFIX = "design-sample-"
IMPORT_PREFIX = "[Design sample]"
MENU_NAME = "Design cafe menu"
# (recipe title, sell price cents, qty sold) rows typed by hand on the menu;
# product rows read their units from sales instead.
MENU_RECIPE_ROWS = [
    ("Buttermilk Biscuits", 450, 60),
    ("Roasted Tomato Soup", 1400, 24),
]


class Command(BaseCommand):
    help = "Create or refresh local fake sales history for Sales-page design"

    def add_arguments(self, parser):
        parser.add_argument("--email", default=DEMO_EMAIL)

    def handle(self, *args, **options):
        if not settings.FORKLUCK_ALLOW_DEMO_ACCOUNT:
            raise CommandError(
                "Design sales seeding is disabled. Set FORKLUCK_ALLOW_DEMO_ACCOUNT=1 "
                "only in local development."
            )
        if connection.vendor != "sqlite":
            raise CommandError("Design sales seeding is restricted to local SQLite.")

        email = options["email"].strip().lower()
        user = User.objects.filter(email=email).first()
        if user is None:
            raise CommandError(f"No local user exists for {email}.")

        with transaction.atomic():
            # Re-running is intentional during design work. Only data created
            # by this command is replaced; real imports remain untouched.
            SalesLine.objects.filter(
                user=user, source_fingerprint__startswith=SAMPLE_PREFIX
            ).delete()
            SalesImport.objects.filter(
                user=user, file_name__startswith=IMPORT_PREFIX
            ).delete()

            products = {
                sku: self.sales_product(user, name, sku, price, category)
                for name, sku, price, category in SAMPLE_PRODUCTS
            }
            for sku, product in products.items():
                self.sales_components(user, product, sku)
            self.demo_menu(user, products)
            imports: dict[tuple[str, int], SalesImport] = {}
            positions: defaultdict[tuple[str, int], int] = defaultdict(int)
            lines: list[SalesLine] = []
            randomizer = random.Random(20260809)
            today = timezone.localdate()

            for day_offset in range(83, -1, -1):
                sold_on = today - timedelta(days=day_offset)
                week = day_offset // 7
                orders = 4 + randomizer.randrange(4)
                if sold_on.weekday() >= 4:
                    orders += 3
                for order_number in range(orders):
                    channel = "square" if randomizer.random() < 0.68 else "shopify"
                    import_key = (channel, week)
                    sales_import = imports.get(import_key)
                    if sales_import is None:
                        period_end = sold_on + timedelta(days=6)
                        sales_import = SalesImport.objects.create(
                            user=user,
                            file_name=(
                                f"{IMPORT_PREFIX} {channel.title()} week of "
                                f"{sold_on:%b %-d, %Y}"
                            ),
                            source=SalesImport.Source.API,
                            channel=channel,
                            timezone="America/New_York",
                            currency_code="USD",
                            period_start=sold_on,
                            period_end=min(period_end, today),
                        )
                        imports[import_key] = sales_import

                    order_id = f"DS-{channel[:2].upper()}-{sold_on:%Y%m%d}-{order_number:02d}"
                    item_count = 2 if randomizer.random() < 0.34 else 1
                    for item_number in range(item_count):
                        is_unmatched = randomizer.random() < 0.07
                        choices = UNMATCHED_ITEMS if is_unmatched else SAMPLE_PRODUCTS
                        name, sku, unit_price, category = randomizer.choice(choices)
                        quantity = 1 if randomizer.random() < 0.84 else 2
                        discount = (
                            round(unit_price * quantity * 0.1)
                            if randomizer.random() < 0.13
                            else 0
                        )
                        gross = unit_price * quantity
                        tax = round((gross - discount) * 0.08875)
                        net = gross - discount - tax
                        is_refund = randomizer.random() < 0.025
                        if is_refund:
                            quantity *= -1
                            gross *= -1
                            discount *= -1
                            tax *= -1
                            net *= -1

                        positions[import_key] += 1
                        sold_at = datetime.combine(
                            sold_on,
                            time(
                                hour=7 + randomizer.randrange(12),
                                minute=randomizer.choice((5, 15, 25, 35, 45, 55)),
                            ),
                            tzinfo=ZoneInfo("America/New_York"),
                        )
                        lines.append(
                            SalesLine(
                                user=user,
                                sales_import=sales_import,
                                product=None if is_unmatched else products[sku],
                                channel=channel,
                                source_position=positions[import_key],
                                source_fingerprint=(
                                    f"{SAMPLE_PREFIX}{channel}-{order_id}-{item_number}"
                                ),
                                external_order_id=order_id,
                                sold_at=sold_at,
                                timezone="America/New_York",
                                sku=sku,
                                item_name=name,
                                group_key=f"sku:{sku}",
                                external_object_id=f"design-{sku.lower()}",
                                external_category=category,
                                quantity=Decimal(str(quantity)),
                                gross_cents=gross,
                                discount_cents=discount,
                                net_sales_cents=net,
                                tax_cents=tax,
                                refund_cents=abs(net) if is_refund else 0,
                                currency_code="USD",
                                location="Design cafe",
                                employee_name=randomizer.choice(
                                    ("Avery", "Jordan", "Sam", "Riley")
                                ),
                                order_source=randomizer.choice(
                                    ("In person", "Online", "Phone")
                                ),
                                financial_status="REFUNDED" if is_refund else "COMPLETED",
                                fulfillment_status="COMPLETED",
                                source_payload={"designSample": True},
                            )
                        )

            SalesLine.objects.bulk_create(lines, batch_size=500)
            for sales_import in imports.values():
                totals = sales_import.lines.aggregate(
                    imported_count=Count("id"),
                    gross_cents=Sum("gross_cents"),
                    discount_cents=Sum("discount_cents"),
                    net_sales_cents=Sum("net_sales_cents"),
                    tax_cents=Sum("tax_cents"),
                    refund_cents=Sum("refund_cents"),
                )
                sales_import.total_rows = totals["imported_count"] or 0
                sales_import.imported_count = totals["imported_count"] or 0
                sales_import.order_count = sales_import.lines.values(
                    "channel", "external_order_id"
                ).distinct().count()
                sales_import.gross_cents = totals["gross_cents"] or 0
                sales_import.discount_cents = totals["discount_cents"] or 0
                sales_import.net_sales_cents = totals["net_sales_cents"] or 0
                sales_import.tax_cents = totals["tax_cents"] or 0
                sales_import.refund_cents = totals["refund_cents"] or 0
                sales_import.save()

        self.stdout.write(
            self.style.SUCCESS(
                f"Seeded {len(lines)} design sales lines across "
                f"{len(imports)} local sample imports for {email}."
            )
        )

    @staticmethod
    def sales_product(
        user: User, name: str, sku: str, price: int, category: str
    ) -> SalesProduct:
        product = SalesProduct.objects.filter(
            user=user, normalized_name=normalized_name(name)
        ).first()
        if product is None:
            product = SalesProduct.objects.create(
                user=user, name=name, normalized_name=normalized_name(name)
            )
        # Fill in what the catalog columns read, without overwriting edits.
        if not product.category:
            product.category = category
        if not product.sell_price_cents:
            product.sell_price_cents = price
        product.save(update_fields=["category", "sell_price_cents"])
        for channel, title in SAMPLE_VARIANTS.get(sku, []):
            object_id = f"{SAMPLE_PREFIX}{sku}-{title or 'default'}".lower()
            SalesProductVariant.objects.get_or_create(
                user=user,
                channel=channel,
                provider_account_id="",
                match_key=item_object_match_key(channel, object_id),
                defaults={
                    "product": product,
                    "sku": f"{sku}-{title[:1]}" if title else sku,
                    "external_name": name,
                    "external_variant_title": title,
                    "external_object_id": object_id,
                },
            )
        skus = [(sku, "1"), *SAMPLE_PACK_SKUS.get(sku, [])]
        for position, (code, units) in enumerate(skus):
            SalesProductSku.objects.get_or_create(
                user=user,
                normalized_sku=group_key_part(code),
                defaults={
                    "product": product,
                    "sku": code,
                    "quantity_multiplier": Decimal(units),
                    "position": position,
                },
            )
        for code, units in SAMPLE_PACK_SKUS.get(sku, []):
            object_id = f"{SAMPLE_PREFIX}{code}".lower()
            SalesProductVariant.objects.get_or_create(
                user=user,
                channel="square",
                provider_account_id="",
                match_key=item_object_match_key("square", object_id),
                defaults={
                    "product": product,
                    "sku": code,
                    "external_name": f"{name} ({units})",
                    "external_object_id": object_id,
                    "quantity_multiplier": Decimal(units),
                    "link_source": SalesProductVariant.LinkSource.AUTO_SKU,
                },
            )
        return product

    @staticmethod
    def demo_menu(user: User, products: dict[str, SalesProduct]) -> None:
        # The worksheet is the merchant's once edited, so rows only go into
        # an empty menu.
        menu, _ = Menu.objects.get_or_create(user=user, name=MENU_NAME)
        if menu.items.exists():
            return
        items = [
            MenuItem(
                menu=menu,
                name=product.name,
                category=product.category,
                sell_price_cents=product.sell_price_cents,
                original_sell_price_cents=product.sell_price_cents,
                product=product,
            )
            for product in products.values()
        ]
        for title, price, qty in MENU_RECIPE_ROWS:
            recipe = (
                Recipe.objects.filter(user=user, title=title)
                .select_related("category")
                .first()
            )
            if recipe is None:
                continue
            items.append(
                MenuItem(
                    menu=menu,
                    name=recipe.title,
                    category=recipe.category.name if recipe.category_id else "",
                    sell_price_cents=price,
                    qty_sold=qty,
                    original_sell_price_cents=price,
                    original_qty_sold=qty,
                    recipe=recipe,
                )
            )
        for position, item in enumerate(items):
            item.position = position
        MenuItem.objects.bulk_create(items)

    @staticmethod
    def sales_components(user: User, product: SalesProduct, sku: str) -> None:
        # Composition is the merchant's once edited, so only an empty one is seeded.
        if product.components.exists():
            return
        position = 0
        for kind, name, quantity, unit in SAMPLE_COMPONENTS.get(sku, []):
            fields = {}
            if kind == "recipe":
                fields["recipe"] = Recipe.objects.filter(user=user, title=name).first()
            elif kind == "ingredient":
                fields["ingredient"] = Ingredient.objects.filter(
                    user=user, normalized_name=normalized_name(name)
                ).first()
            elif kind == "supply":
                fields["ingredient"] = Ingredient.objects.filter(
                    user=user, non_edible=True
                ).first()
            else:
                fields["component_product"] = SalesProduct.objects.filter(
                    user=user, normalized_name=normalized_name(name)
                ).first()
            if next(iter(fields.values())) is None:
                continue
            SalesProductComponent.objects.create(
                product=product,
                position=position,
                quantity=Decimal(quantity),
                unit=unit,
                **fields,
            )
            position += 1
