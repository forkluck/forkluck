"""Read an unstated added sugars line as zero on already-linked staples.

Linking a Foundation or SR Legacy record stores zero added sugars when USDA
states none, since the analyzed staples carry none and a sweetener is declared
by the pantry flag. Records linked before that rule keep the blank, which reads
as unknown on every label the ingredient is part of. This walks those links
once, asks USDA which kind of record each one is, and fills the zero in. It is
the same rule the link path applies, so running it twice fills nothing the
first run missed.
"""

from django.core.management.base import BaseCommand

from ...integrations.food_data import (
    ASSUMES_NO_ADDED_SUGARS,
    FoodDataError,
    get_food_data_type,
)
from ...models import Ingredient, NutritionSource


class Command(BaseCommand):
    help = "Store zero added sugars on linked USDA staples whose record states none."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Name the ingredients that would change without saving them.",
        )

    def handle(self, *args, **options):
        rows = (
            Ingredient.objects.filter(nutrition_source=NutritionSource.USDA_FDC)
            .exclude(nutrition_per_100g=None)
            .order_by("nutrition_source_id", "created_at")
        )
        # One record serves every pantry that linked it.
        data_types: dict[str, str | None] = {}
        filled = 0
        unavailable = 0
        for row in rows.iterator():
            snapshot = row.nutrition_per_100g
            if (
                not isinstance(snapshot, dict)
                or snapshot.get("addedSugars") is not None
            ):
                continue
            fdc_id = row.nutrition_source_id
            if fdc_id not in data_types:
                try:
                    data_types[fdc_id] = get_food_data_type(int(fdc_id))
                except (FoodDataError, ValueError):
                    data_types[fdc_id] = None
            data_type = data_types[fdc_id]
            if data_type is None:
                unavailable += 1
                self.stderr.write(f"{row.public_id}: record {fdc_id} unavailable")
                continue
            if data_type not in ASSUMES_NO_ADDED_SUGARS:
                continue
            filled += 1
            self.stdout.write(
                f"{row.public_id} {row.name}: {row.nutrition_description}"
            )
            if options["dry_run"]:
                continue
            row.nutrition_per_100g = {**snapshot, "addedSugars": 0.0}
            row.save(update_fields=["nutrition_per_100g"])
        verb = "would fill" if options["dry_run"] else "filled"
        self.stdout.write(
            self.style.SUCCESS(
                f"{verb} {filled} ingredients, {unavailable} unavailable"
            )
        )
