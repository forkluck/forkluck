import json
import tempfile
from pathlib import Path
from typing import Any

from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError

from forkluck.domains.recipes.health import MILLILITERS_PER_UNIT
from forkluck.domains.shared import density
from forkluck.models import CatalogIngredient, CatalogIngredientMeasure
from forkluck.domains.shared.values import normalized_name

# Shared with the recipe parser, which reads the same rules to weigh a line
# before any catalog product is known.
DEFAULT_MANIFEST = density.MANIFEST

# The parser cross-converts inside the volume family, so one cup measure
# answers tsp, tbsp, ml, l and fl-oz too.
SEED_UNIT = "cup"
SOURCE_KIND = "seed"


class Command(BaseCommand):
    help = (
        "Give common pantry staples a volume-to-grams measure, so a recipe "
        "written in cups and tablespoons can be costed without a chef "
        "weighing each ingredient first."
    )

    def add_arguments(self, parser) -> None:
        parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
        parser.add_argument("--dry-run", action="store_true")
        parser.add_argument(
            "--show-unmatched",
            action="store_true",
            help="List rules that matched no catalog ingredient.",
        )

    def handle(self, *args, **options) -> None:
        rules = self._load_rules(options["manifest"])
        catalog = list(
            CatalogIngredient.objects.filter(is_active=True).only(
                "name", "normalized_name", "category"
            )
        )
        if not catalog:
            raise CommandError(
                "No catalog ingredients to measure. Import the price catalog first."
            )

        # A reviewed measure is better evidence than a reference density, and
        # the importer would clear a same-unit default to install this one.
        # Any volume unit counts: the resolver's direct-unit preference would
        # let a seeded cup outrank a reviewed tablespoon for cup recipes.
        reviewed = set(
            CatalogIngredientMeasure.objects.filter(
                unit__in=MILLILITERS_PER_UNIT, qualifier="", is_default=True
            )
            .exclude(source_kind=SOURCE_KIND)
            .values_list("ingredient_id", flat=True)
        )

        rows: list[dict[str, Any]] = []
        hits: dict[str, int] = {rule["key"]: 0 for rule in rules}
        renamed: list[str] = []
        seeded_ids: list[Any] = []
        renamed_ids: list[Any] = []
        preserved_ids: list[Any] = []
        for ingredient in catalog:
            rule = self._first_match(ingredient, rules)
            if rule is None:
                continue
            if ingredient.id in reviewed:
                preserved_ids.append(ingredient.id)
                continue
            # The importer creates a catalog row for a name it cannot find, so
            # a name that no longer normalizes to its key would mint a duplicate.
            if normalized_name(ingredient.name) != ingredient.normalized_name:
                renamed.append(ingredient.name)
                renamed_ids.append(ingredient.id)
                continue
            seeded_ids.append(ingredient.id)
            hits[rule["key"]] += 1
            rows.append(
                {
                    "ingredient": ingredient.name,
                    "unit": SEED_UNIT,
                    "amount": 1,
                    "grams": rule["gramsPerCup"],
                    "source_kind": SOURCE_KIND,
                    "source_ref": rule["key"],
                    # A reference density on a branded product is a guess.
                    "confidence": "low",
                    "is_default": True,
                }
            )

        # A seed installed on an earlier run is superseded the moment reviewed
        # evidence arrives: left in place, the resolver's direct-unit
        # preference would still pick the seeded cup over a reviewed
        # tablespoon. Retire it rather than merely declining to reinstall it.
        retired = 0
        if preserved_ids and not options["dry_run"]:
            retired, _ = CatalogIngredientMeasure.objects.filter(
                ingredient_id__in=preserved_ids, source_kind=SOURCE_KIND
            ).delete()

        # A manifest edit can strand a seed on an ingredient no current rule
        # matches; fresh installs never create it, so a rerun must not keep it
        # either. Renamed ingredients still match — they are only skipped from
        # re-import — and this runs only when the manifest matched something,
        # so a broken manifest cannot sweep every seed.
        orphaned = 0
        if (rows or preserved_ids) and not options["dry_run"]:
            orphaned, _ = (
                CatalogIngredientMeasure.objects.filter(source_kind=SOURCE_KIND)
                .exclude(
                    ingredient_id__in=[*seeded_ids, *renamed_ids, *preserved_ids]
                )
                .delete()
            )

        if not rows:
            if preserved_ids:
                self._report_cleanup(len(preserved_ids), retired, orphaned)
                return
            raise CommandError("No catalog ingredient matched any rule")

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "expanded.json"
            path.write_text(json.dumps(rows), encoding="utf-8")
            call_command(
                "import_ingredient_measures",
                path,
                dry_run=options["dry_run"],
                stdout=self.stdout,
            )

        covered = sum(1 for count in hits.values() if count)
        self.stdout.write(
            f"{len(rows)} measures from {covered}/{len(rules)} rules "
            f"across {len(catalog)} catalog ingredients."
        )
        for key, count in sorted(hits.items(), key=lambda item: -item[1]):
            if count:
                self.stdout.write(f"  {count:>4}  {key}")
        self._report_cleanup(len(preserved_ids), retired, orphaned)
        if renamed:
            self.stdout.write(
                self.style.WARNING(
                    f"Skipped {len(renamed)} rows whose name no longer normalizes to "
                    f"their stored key, e.g. {renamed[0]!r}"
                )
            )
        empty = [key for key, count in hits.items() if not count]
        if empty and options["show_unmatched"]:
            self.stdout.write(
                self.style.WARNING(f"Rules that matched nothing: {', '.join(empty)}")
            )
        elif empty:
            self.stdout.write(
                f"{len(empty)} rules matched nothing; --show-unmatched to list them."
            )

    def _report_cleanup(self, preserved: int, retired: int, orphaned: int) -> None:
        if preserved:
            self.stdout.write(
                f"Kept {preserved} reviewed default measures already in place."
            )
        if retired:
            self.stdout.write(f"Retired {retired} superseded seed measures.")
        if orphaned:
            self.stdout.write(f"Retired {orphaned} orphaned seed measures.")

    def _first_match(
        self, ingredient: CatalogIngredient, rules: list[dict[str, Any]]
    ) -> dict[str, Any] | None:
        return density.match_rule(
            ingredient.normalized_name.split(), rules, ingredient.category
        )

    def _load_rules(self, path: Path) -> list[dict[str, Any]]:
        try:
            return density.load_rules(path)
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
