"""Load `data/catalog/catalog.csv` into the shared catalog tables.

The file is open data kept in this repository; the shape rules here repeat
`data/catalog/scripts/validate.py` (which also owns the preparation
vocabulary) so a bad file fails before it writes anything.
"""

import csv
import hashlib
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from forkluck.models import (
    Allergen,
    CatalogImportBatch,
    CatalogIngredient,
    CatalogIngredientAlias,
    CatalogIngredientAllergen,
    CatalogIngredientMeasure,
    CatalogPreparationMeasure,
    CatalogPreparationYield,
    CatalogSource,
    IngredientAllergenStatus,
    IngredientMeasureConfidence,
    normalized_name,
)
from forkluck.units import MEASURE_UNIT_VALUES, unit_family

SOURCE_KEY = "catalog"
from ...paths import DATA_DIR

DEFAULT_PATH = DATA_DIR / "catalog" / "catalog.csv"
KEY_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")
COLUMNS = [
    "id",
    "name",
    "synonyms",
    "allergens",
    "preparation",
    "yield",
    "grams",
    "volume",
    "each",
    "estimated",
    "source",
]
# The catalog gained a brand-dependent column after the first releases, so a
# file without it still loads and every row reads as having no verify cell.
OPTIONAL_COLUMNS = ["verify"]


class Command(BaseCommand):
    help = "Load the open ingredient catalog from data/catalog/catalog.csv."

    def add_arguments(self, parser) -> None:
        parser.add_argument("path", nargs="?", type=Path, default=DEFAULT_PATH)
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **options) -> None:
        path: Path = options["path"]
        if not path.is_file():
            raise CommandError(f"Catalog file not found: {path}")
        raw = path.read_bytes()
        entries, row_count = self._parse(raw)
        digest = hashlib.sha256(raw).hexdigest()
        # The snapshot's name, for the provenance every yield row records.
        release = f"catalog:{digest[:12]}"
        counts = {
            "ingredients": 0,
            "aliases": 0,
            "measures": 0,
            "preparations": 0,
            "folded": 0,
        }

        with transaction.atomic():
            source, _ = CatalogSource.objects.get_or_create(key=SOURCE_KEY)
            batch, created = CatalogImportBatch.objects.get_or_create(
                source=source,
                content_sha256=digest,
                defaults={
                    "file_name": path.name,
                    "observed_at": timezone.now(),
                    "row_count": row_count,
                    "imported_count": len(entries),
                },
            )
            if not created:
                self.stdout.write(
                    self.style.SUCCESS("Catalog already imported; no changes.")
                )
                return
            self._supersede([entry["key"] for entry in entries])
            for entry in entries:
                self._write(entry, release, counts)
            if options["dry_run"]:
                transaction.set_rollback(True)

        mode = "Dry run" if options["dry_run"] else "Synced"
        self.stdout.write(
            self.style.SUCCESS(
                f"{mode} {release}: {counts['ingredients']} ingredients, "
                f"{counts['aliases']} aliases, {counts['measures']} measures, "
                f"{counts['preparations']} preparations"
                + (
                    f", {counts['folded']} legacy rows folded."
                    if counts["folded"]
                    else "."
                )
            )
        )

    def _parse(self, raw: bytes) -> tuple[list[dict[str, Any]], int]:
        reader = csv.DictReader(raw.decode("utf-8-sig").splitlines())
        # The verify column sits beside allergens in the shipped file, and an
        # older file has no verify at all; only the set of names is pinned.
        fields = list(reader.fieldnames or [])
        without_verify = [name for name in fields if name != "verify"]
        if without_verify != COLUMNS or len(fields) - len(without_verify) > 1:
            raise CommandError(
                f"Catalog columns must be {','.join(COLUMNS)}, with one "
                f"optional {','.join(OPTIONAL_COLUMNS)} column"
            )
        entries: dict[str, dict[str, Any]] = {}
        seen: set[tuple[str, str, str]] = set()
        row_count = 0
        for position, row in enumerate(reader, 2):
            row_count += 1
            key = (row["id"] or "").strip()
            if not KEY_PATTERN.match(key) or len(key) > 64:
                raise CommandError(f"Row {position} has an invalid id: {row['id']!r}")
            entry = entries.get(key)
            if entry is None:
                entry = entries[key] = self._identity(key, row, position)
            elif any(
                (row.get(column) or "").strip()
                for column in ("name", "synonyms", "allergens", "verify")
            ):
                raise CommandError(
                    f"Row {position} repeats id {key!r}: only its first row carries "
                    "name, synonyms, allergens and verify"
                )
            preparation = row["preparation"].strip()
            estimated = row["estimated"].strip().lower()
            if estimated not in {"yes", "no"}:
                raise CommandError(f"Row {position} estimated must be yes or no")
            source_ref = row["source"].strip()
            if estimated == "no" and not source_ref:
                raise CommandError(
                    f"Row {position} is not estimated and needs a source"
                )
            if len(source_ref) > 120:
                raise CommandError(f"Row {position} source exceeds 120 characters")
            confidence = (
                IngredientMeasureConfidence.HIGH
                if estimated == "no"
                else IngredientMeasureConfidence.LOW
            )
            grams = row["grams"].strip()
            yield_raw = row["yield"].strip()
            cells = [
                (row[column], family)
                for column, family in (("volume", "volume"), ("each", "count"))
                if row[column].strip()
            ]
            if grams and yield_raw:
                raise CommandError(
                    f"Row {position} carries both grams and a yield: write the "
                    "yield on its own row"
                )
            if (grams and not cells) or (
                not grams and (cells or not preparation or not yield_raw)
            ):
                raise CommandError(
                    f"Row {position} is neither grams plus volume/each nor a "
                    "preparation with only a yield"
                )
            measures = [
                self._measure(raw_cell, family, grams, confidence, source_ref, position)
                for raw_cell, family in cells
            ]
            for measure in measures:
                signature = (key, preparation, measure["unit"])
                if signature in seen:
                    raise CommandError(
                        f"Row {position} repeats {key} {preparation or 'default'} "
                        f"in {measure['unit']}"
                    )
                seen.add(signature)
            if not preparation:
                entry["measures"].extend(measures)
                continue
            prep = entry["preparations"].setdefault(
                normalized_name(preparation),
                {
                    "name": preparation,
                    "yield_percent": Decimal("100"),
                    "confidence": confidence,
                    "source_ref": source_ref,
                    "measures": [],
                },
            )
            prep["measures"].extend(measures)
            if yield_raw:
                prep["yield_percent"] = self._yield(yield_raw, position)
                prep["confidence"] = confidence
                prep["source_ref"] = source_ref
        if not entries:
            raise CommandError("Catalog file contains no rows")
        names: dict[str, str] = {}
        for key, entry in entries.items():
            if not entry["measures"]:
                raise CommandError(f"Catalog entry {key!r} has no default equivalence")
            # Identities are unique by normalized name as well as by key.
            other = names.setdefault(normalized_name(entry["name"]), key)
            if other != key:
                raise CommandError(f"Entries {other!r} and {key!r} share a name")
        return list(entries.values()), row_count

    def _identity(self, key: str, row: dict[str, str], position: int) -> dict[str, Any]:
        name = row["name"].strip()
        if not name or len(name) > 120:
            raise CommandError(f"Row {position} needs a name of 1-120 characters")
        synonyms = [
            value.strip() for value in row["synonyms"].split("|") if value.strip()
        ]
        if any(len(value) > 200 for value in synonyms):
            raise CommandError(f"Row {position} synonym exceeds 200 characters")
        allergens = [
            value.strip().lower()
            for value in row["allergens"].split("|")
            if value.strip()
        ]
        unknown = set(allergens) - set(Allergen.values)
        if unknown:
            raise CommandError(
                f"Row {position} has unknown allergens: {sorted(unknown)}"
            )
        verify = [
            value.strip().lower()
            for value in (row.get("verify") or "").split("|")
            if value.strip()
        ]
        unknown = set(verify) - set(Allergen.values)
        if unknown:
            raise CommandError(
                f"Row {position} has unknown verify tags: {sorted(unknown)}"
            )
        both = sorted(set(verify) & set(allergens))
        if both:
            raise CommandError(f"Row {position} both asserts and defers on: {both}")
        return {
            "key": key,
            "name": name,
            "synonyms": synonyms,
            "allergens": allergens,
            "verify": verify,
            "measures": [],
            "preparations": {},
        }

    def _measure(
        self,
        raw: str,
        family: str,
        grams: str,
        confidence: str,
        source_ref: str,
        position: int,
    ) -> dict[str, Any]:
        parts = raw.split()
        if len(parts) != 2:
            raise CommandError(
                f"Row {position} measure must read 'amount unit': {raw!r}"
            )
        amount = self._decimal(parts[0], "amount", position)
        unit = parts[1]
        if unit not in MEASURE_UNIT_VALUES:
            raise CommandError(f"Row {position} has an unknown unit: {unit!r}")
        actual = unit_family(unit)
        if family == "volume" and actual != "volume":
            raise CommandError(f"Row {position} volume unit {unit!r} is not a volume")
        if family == "count" and actual not in {"count", "dimensionless"}:
            raise CommandError(f"Row {position} each unit {unit!r} is not a count")
        weight = self._decimal(grams, "grams", position)
        if amount <= 0 or weight <= 0:
            raise CommandError(f"Row {position} amount and grams must be positive")
        return {
            "unit": unit,
            "amount": amount,
            "grams": weight,
            "confidence": confidence,
            "source_ref": source_ref,
        }

    def _yield(self, raw: str, position: int) -> Decimal:
        value = self._decimal(raw, "yield", position)
        if not 0 < value <= 1000:
            raise CommandError(f"Row {position} yield must be between 0 and 1000")
        return value

    def _decimal(self, raw: str, field: str, position: int) -> Decimal:
        try:
            return Decimal(raw)
        except InvalidOperation:
            raise CommandError(
                f"Row {position} has an invalid {field}: {raw!r}"
            ) from None

    def _supersede(self, keys: list[str]) -> None:
        """Everything this source wrote before is stale until the file rewrites it."""
        CatalogIngredientAlias.objects.filter(provenance=SOURCE_KEY).update(
            is_active=False
        )
        CatalogIngredientMeasure.objects.filter(source_kind=SOURCE_KEY).update(
            is_active=False, is_default=False
        )
        CatalogPreparationMeasure.objects.filter(source_kind=SOURCE_KEY).update(
            is_active=False, is_default=False
        )
        CatalogPreparationYield.objects.filter(source_kind=SOURCE_KEY).update(
            is_active=False, is_default=False
        )
        CatalogIngredientAllergen.objects.filter(source_kind=SOURCE_KEY).update(
            is_active=False
        )
        CatalogIngredient.objects.filter(key__isnull=False).exclude(
            key__in=keys
        ).update(is_active=False)

    def _write(
        self, entry: dict[str, Any], release: str, counts: dict[str, int]
    ) -> None:
        ingredient = CatalogIngredient.objects.filter(key=entry["key"]).first()
        if ingredient is None:
            # A row that predates keys — Water from the baseline migration —
            # is adopted rather than duplicated under a second identity.
            ingredient = CatalogIngredient.objects.filter(
                key__isnull=True, normalized_name=normalized_name(entry["name"])
            ).first()
        if ingredient is None:
            ingredient = CatalogIngredient(name=entry["name"])
        taken = (
            CatalogIngredient.objects.filter(
                normalized_name=normalized_name(entry["name"])
            )
            .exclude(pk=ingredient.pk)
            .first()
        )
        if taken is not None and taken.key is None:
            # A row from before keys sits on the name this entry now takes —
            # "Mustard Greens" beside the keyed "Mustard green" it was renamed
            # to. It is the same thing under an older spelling: whatever points
            # at it moves to the keyed row, and it goes, taking its measures
            # and aliases with it; the entry restates what the catalog says.
            taken.tenant_ingredients.update(catalog_ingredient=ingredient)
            taken.products.update(ingredient=ingredient)
            taken.delete()
            counts["folded"] += 1
        elif taken is not None:
            raise CommandError(
                f"Entry {entry['key']!r} is named like catalog row {taken.key or taken.name!r}"
            )
        ingredient.key = entry["key"]
        ingredient.name = entry["name"]
        ingredient.is_active = True
        ingredient.save()
        counts["ingredients"] += 1

        for synonym in entry["synonyms"]:
            CatalogIngredientAlias.objects.update_or_create(
                ingredient=ingredient,
                provenance=SOURCE_KEY,
                normalized_text=normalized_name(synonym),
                defaults={"text": synonym, "is_active": True},
            )
            counts["aliases"] += 1
        statuses = [
            (entry["allergens"], IngredientAllergenStatus.CONTAINS),
            # Brand-dependent: the catalog will not assert either way, so the
            # ingredient screen asks the kitchen to read its own package.
            (entry["verify"], IngredientAllergenStatus.CHECK_LABEL),
        ]
        for keys, status in statuses:
            for allergen in keys:
                CatalogIngredientAllergen.objects.update_or_create(
                    ingredient=ingredient,
                    allergen=allergen,
                    defaults={
                        "status": status,
                        "source_kind": SOURCE_KEY,
                        "source_ref": entry["key"],
                        "is_active": True,
                    },
                )
        for measure in entry["measures"]:
            # The catalog outranks any locally seeded density for the same
            # unit, and only one default may exist per unit.
            CatalogIngredientMeasure.objects.filter(
                ingredient=ingredient,
                unit=measure["unit"],
                qualifier="",
                is_default=True,
            ).exclude(source_kind=SOURCE_KEY).update(is_default=False)
            CatalogIngredientMeasure.objects.update_or_create(
                ingredient=ingredient,
                unit=measure["unit"],
                qualifier="",
                source_kind=SOURCE_KEY,
                source_ref=measure["source_ref"],
                defaults={
                    "amount": measure["amount"],
                    "grams": measure["grams"],
                    "confidence": measure["confidence"],
                    "is_default": True,
                    "is_active": True,
                },
            )
            counts["measures"] += 1
        for key, prep in entry["preparations"].items():
            prep_yield, _ = CatalogPreparationYield.objects.update_or_create(
                ingredient=ingredient,
                normalized_name=key,
                source_kind=SOURCE_KEY,
                source_ref=prep["source_ref"],
                defaults={
                    "name": prep["name"],
                    "yield_percent": prep["yield_percent"],
                    "source_release": release,
                    "derivation": SOURCE_KEY,
                    "evidence_count": 1,
                    "confidence": prep["confidence"],
                    "is_default": True,
                    "is_active": True,
                },
            )
            counts["preparations"] += 1
            for measure in prep["measures"]:
                CatalogPreparationMeasure.objects.update_or_create(
                    preparation_yield=prep_yield,
                    unit=measure["unit"],
                    qualifier="",
                    source_kind=SOURCE_KEY,
                    source_ref=measure["source_ref"],
                    defaults={
                        "amount": measure["amount"],
                        "grams": measure["grams"],
                        "confidence": measure["confidence"],
                        "is_default": True,
                        "is_active": True,
                    },
                )
                counts["measures"] += 1
