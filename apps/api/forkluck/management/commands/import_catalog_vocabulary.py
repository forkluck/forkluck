"""Import a small, reviewed catalog identity vocabulary.

The command intentionally accepts only the vocabulary shape used by the
repository's synthetic fixtures: canonical names, pipe-separated synonyms,
and explicit base/preparation conversions. It never reads the research tree.
"""

import csv
import hashlib
import json
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
)
from forkluck.units import MEASURE_UNIT_VALUES, measure_unit_choices
from forkluck.models import normalized_name


class Command(BaseCommand):
    help = "Import canonical ingredient identities and reviewed vocabulary conversions."

    def add_arguments(self, parser) -> None:
        parser.add_argument("path", type=Path)
        parser.add_argument("--source-key", required=True)
        parser.add_argument("--private-label", default="")
        parser.add_argument(
            "--conversions",
            "--conversion-file",
            dest="conversions",
            type=Path,
            help="Optional CSV of base/preparation conversions keyed by canonical name.",
        )
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **options) -> None:
        path: Path = options["path"]
        if not path.is_file():
            raise CommandError(f"Vocabulary file not found: {path}")
        raw = path.read_bytes()
        rows = self._read_rows(path, raw)
        conversions_path: Path | None = options.get("conversions")
        conversions_raw = b""
        if conversions_path is not None:
            if not conversions_path.is_file():
                raise CommandError(f"Conversions file not found: {conversions_path}")
            conversions_raw = conversions_path.read_bytes()
        self._merge_conversion_rows(rows, conversions_path)
        if not rows:
            raise CommandError("Vocabulary file contains no rows")
        prepared = [self._prepare_row(row, i) for i, row in enumerate(rows, 1)]
        # Companion conversion content is part of the snapshot. Otherwise a
        # grams/yield-only edit would incorrectly hit the exact-batch no-op.
        digest = hashlib.sha256(
            raw + b"\0catalog-conversions\0" + conversions_raw
        ).hexdigest()
        source_key = options["source_key"]
        if not source_key or len(source_key) > 64:
            raise CommandError("source key must be 1-64 characters")
        counts = {"ingredients": 0, "aliases": 0, "measures": 0, "preparations": 0}
        source_ref = f"{options['source_key']}:{path.name}"
        if len(source_ref) > 120:
            raise CommandError("source key and file name must fit the 120-character provenance field")

        with transaction.atomic():
            source, _ = CatalogSource.objects.get_or_create(
                key=source_key,
                defaults={"private_label": options["private_label"], "is_active": True},
            )
            if source.private_label != options["private_label"]:
                source.private_label = options["private_label"]
                source.save(update_fields=["private_label", "updated_at"])
            batch, created = CatalogImportBatch.objects.get_or_create(
                source=source,
                content_sha256=digest,
                defaults={
                    "file_name": path.name,
                    "observed_at": timezone.now(),
                    "row_count": len(prepared),
                },
            )
            if not created:
                self.stdout.write(self.style.SUCCESS("Vocabulary already imported; no changes."))
                return
            self._deactivate_superseded(source_key)
            for row in prepared:
                ingredient, _ = CatalogIngredient.objects.get_or_create(
                    normalized_name=row["normalized_name"],
                    defaults={"name": row["name"], "category": row["category"]},
                )
                counts["ingredients"] += 1
                for synonym in row["synonyms"]:
                    alias = CatalogIngredientAlias.objects.filter(
                        ingredient=ingredient,
                        normalized_text=normalized_name(synonym),
                        provenance=source_ref,
                    ).first()
                    if alias is None:
                        CatalogIngredientAlias.objects.create(
                            ingredient=ingredient,
                            text=synonym,
                            provenance=source_ref,
                            is_active=True,
                        )
                    else:
                        alias.text = synonym
                        alias.is_active = True
                        alias.save(update_fields=["text", "is_active", "updated_at"])
                    counts["aliases"] += 1
                for measure in row["measures"]:
                    self._upsert_base_measure(ingredient, measure, source_ref)
                    counts["measures"] += 1
                for prep in row["preparations"]:
                    prep_yield, _ = CatalogPreparationYield.objects.update_or_create(
                        ingredient=ingredient,
                        normalized_name=prep["normalized_name"],
                        source_kind=source_key,
                        source_ref=source_ref,
                        defaults={
                            "name": prep["name"],
                            "yield_percent": prep["yield_percent"],
                            "low_percent": prep["low_percent"],
                            "high_percent": prep["high_percent"],
                            "source_release": prep.get("source_release", source_key),
                            "derivation": prep.get("derivation", "imported"),
                            "evidence_count": prep.get("evidence_count", 1),
                            "confidence": prep.get("confidence", "medium"),
                            "is_default": prep.get("is_default", False),
                            "is_active": True,
                        },
                    )
                    counts["preparations"] += 1
                    for measure in prep["measures"]:
                        self._upsert_prep_measure(prep_yield, measure, source_ref)
                        counts["measures"] += 1
                for allergen, status in row["allergens"].items():
                    CatalogIngredientAllergen.objects.update_or_create(
                        ingredient=ingredient,
                        allergen=allergen,
                        defaults={
                            "status": status,
                            "source_kind": source_key,
                            "source_ref": source_ref,
                            "is_active": True,
                        },
                    )
            batch.imported_count = counts["ingredients"]
            batch.row_count = len(prepared)
            batch.save(update_fields=["imported_count", "row_count", "updated_at"])
            if options["dry_run"]:
                transaction.set_rollback(True)

        mode = "Dry run" if options["dry_run"] else "Imported"
        self.stdout.write(
            self.style.SUCCESS(
                f"{mode}: {counts['ingredients']} identities, {counts['aliases']} aliases, "
                f"{counts['measures']} measures, {counts['preparations']} preparations."
            )
        )

    def _read_rows(self, path: Path, raw: bytes) -> list[dict[str, Any]]:
        if path.suffix.lower() == ".csv":
            return list(csv.DictReader(raw.decode("utf-8-sig").splitlines()))
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise CommandError(f"Vocabulary file is not valid JSON: {exc}") from exc
        if isinstance(payload, dict):
            payload = payload.get("ingredients", payload.get("items"))
        if not isinstance(payload, list) or not all(isinstance(row, dict) for row in payload):
            raise CommandError("Vocabulary JSON must be an array of ingredient objects")
        return payload

    def _merge_conversion_rows(self, rows: list[dict[str, Any]], path: Path | None) -> None:
        if path is None:
            return
        if not path.is_file():
            raise CommandError(f"Conversions file not found: {path}")
        conversion_rows = list(csv.DictReader(path.read_text(encoding="utf-8-sig").splitlines()))
        by_key = {
            normalized_name(str(row.get("canonical") or "")): row
            for row in rows
        }
        for position, conversion in enumerate(conversion_rows, 1):
            key = normalized_name(str(conversion.get("canonical") or ""))
            if not key or key not in by_key:
                raise CommandError(f"Conversion row {position} names an unknown canonical identity")
            target = by_key[key]
            measure = {
                "unit": conversion.get("unit", ""),
                "amount": conversion.get("amount", ""),
                "grams": conversion.get("grams", ""),
                "qualifier": conversion.get("qualifier", ""),
                "is_default": str(conversion.get("is_default", "")).lower() in {"1", "true", "yes"},
            }
            prep_name = str(conversion.get("preparation") or conversion.get("prep") or "").strip()
            if not prep_name:
                target.setdefault("measures", []).append(measure)
                continue
            preparations = target.setdefault("preparations", [])
            existing = next((item for item in preparations if str(item.get("name", "")).strip().casefold() == prep_name.casefold()), None)
            if existing is None:
                existing = {"name": prep_name, "yield_percent": conversion.get("yield_percent") or 100, "measures": []}
                preparations.append(existing)
            existing.setdefault("measures", []).append(measure)

    def _deactivate_superseded(self, source_key: str) -> None:
        old_prefix = f"{source_key}:"
        CatalogIngredientAlias.objects.filter(
            provenance__startswith=old_prefix
        ).update(is_active=False)
        CatalogIngredientMeasure.objects.filter(
            source_kind="vocabulary", source_ref__startswith=old_prefix
        ).update(is_active=False, is_default=False)
        CatalogPreparationMeasure.objects.filter(
            source_kind="vocabulary", source_ref__startswith=old_prefix
        ).update(is_active=False, is_default=False)
        CatalogPreparationYield.objects.filter(
            source_kind=source_key, source_ref__startswith=old_prefix
        ).update(is_active=False, is_default=False)
        CatalogIngredientAllergen.objects.filter(
            source_kind=source_key, source_ref__startswith=old_prefix
        ).update(is_active=False)

    def _prepare_row(self, row: dict[str, Any], position: int) -> dict[str, Any]:
        name = str(row.get("canonical") or "").strip()
        key = normalized_name(name)
        if not name or not key:
            raise CommandError(f"Row {position} is missing a canonical name")
        if len(name) > 120 or len(key) > 120:
            raise CommandError(f"Row {position} canonical name exceeds 120 characters")
        synonyms = self._split_pipe(row.get("synonyms", ""))
        if any(len(value) > 200 or len(normalized_name(value)) > 200 for value in synonyms):
            raise CommandError(f"Row {position} synonym exceeds 200 characters")
        measures = self._measures(row.get("measures", []))
        # A CSV row may put one conversion directly in columns.
        if row.get("unit") or row.get("grams"):
            measures.append(self._measure(row, position))
        preparations = []
        for prep in self._as_list(row.get("preparations", [])):
            if not isinstance(prep, dict):
                raise CommandError(f"Row {position} preparation must be an object")
            prep_name = str(prep.get("name") or "").strip()
            prep_key = normalized_name(prep_name)
            if not prep_name or not prep_key:
                raise CommandError(f"Row {position} preparation is missing a name")
            if len(prep_name) > 120 or len(prep_key) > 120:
                raise CommandError(f"Row {position} preparation name exceeds 120 characters")
            yield_percent = self._decimal(prep.get("yield_percent", 100), "yield_percent", position)
            low_percent = self._optional_decimal(prep.get("low_percent"), "low_percent", position)
            high_percent = self._optional_decimal(prep.get("high_percent"), "high_percent", position)
            if not 0 < yield_percent <= 1000 or (low_percent is not None and not 0 < low_percent <= 1000) or (high_percent is not None and not 0 < high_percent <= 1000):
                raise CommandError(f"Row {position} preparation yield must be between 0 and 1000 percent")
            if low_percent is not None and low_percent > yield_percent or high_percent is not None and high_percent < yield_percent or low_percent is not None and high_percent is not None and low_percent > high_percent:
                raise CommandError(f"Row {position} preparation yield range is not ordered")
            preparations.append(
                {
                    **prep,
                    "name": prep_name,
                    "normalized_name": prep_key,
                    "yield_percent": yield_percent,
                    "low_percent": low_percent,
                    "high_percent": high_percent,
                    "measures": self._measures(prep.get("measures", prep.get("conversions", []))),
                }
            )
            if prep.get("confidence", "medium") not in {"high", "medium", "low"}:
                raise CommandError(f"Row {position} preparation has invalid confidence")
        allergens = {}
        for value in self._as_list(row.get("allergens", [])):
            raw_allergen = str(value).strip()
            normalized = {
                "treeNut": "tree_nuts",
                "treeNuts": "tree_nuts",
                "peanuts": "peanut",
                "eggs": "egg",
                "crustacean_shellfish": "shellfish",
            }.get(raw_allergen, raw_allergen.lower().replace(" ", "_"))
            if normalized not in Allergen.values:
                raise CommandError(f"Row {position} has unknown Big Nine allergen: {value}")
            allergens[normalized] = IngredientAllergenStatus.CONTAINS
        return {
            "name": name[:120],
            "normalized_name": key[:120],
            "category": str(row.get("category") or "")[:64],
            "synonyms": synonyms,
            "measures": measures,
            "preparations": preparations,
            "allergens": allergens,
        }

    def _split_pipe(self, value: Any) -> list[str]:
        if isinstance(value, list):
            values = value
        else:
            values = str(value or "").split("|")
        return list(dict.fromkeys(str(item).strip() for item in values if str(item).strip()))

    def _as_list(self, value: Any) -> list[Any]:
        if value in (None, "", []):
            return []
        return value if isinstance(value, list) else [value]

    def _measures(self, value: Any) -> list[dict[str, Any]]:
        return [self._measure(item, i) for i, item in enumerate(self._as_list(value), 1)]

    def _measure(self, item: Any, position: int) -> dict[str, Any]:
        if not isinstance(item, dict):
            raise CommandError(f"Conversion {position} must be an object")
        unit = str(item.get("unit") or "").strip().lower().replace(" ", "-")
        unit = self._unit_slug(unit)
        if unit not in MEASURE_UNIT_VALUES:
            raise CommandError(f"Unknown readable measure unit: {item.get('unit')}")
        amount = self._decimal(item.get("amount", 1), "amount", position)
        grams = self._decimal(item.get("grams"), "grams", position)
        if amount <= 0 or grams <= 0:
            raise CommandError("Measure amount and grams must be positive")
        confidence = item.get("confidence", "medium")
        if confidence not in {"high", "medium", "low"}:
            raise CommandError(f"Conversion {position} has invalid confidence")
        qualifier = str(item.get("qualifier") or "")
        if len(qualifier) > 120:
            raise CommandError(f"Conversion {position} qualifier exceeds 120 characters")
        return {"unit": unit, "amount": amount, "grams": grams, "qualifier": qualifier, "is_default": bool(item.get("is_default", False)), "confidence": confidence}

    def _unit_slug(self, value: str) -> str:
        labels = {label.lower(): slug for slug, label in measure_unit_choices()}
        return labels.get(value, value)

    def _decimal(self, value: Any, field: str, position: int) -> Decimal:
        try:
            result = Decimal(str(value))
        except (InvalidOperation, TypeError):
            raise CommandError(f"Conversion {position} has invalid {field}")
        return result

    def _optional_decimal(self, value: Any, field: str, position: int) -> Decimal | None:
        return None if value in (None, "") else self._decimal(value, field, position)

    def _upsert_base_measure(self, ingredient, measure, source_ref):
        CatalogIngredientMeasure.objects.update_or_create(
            ingredient=ingredient, unit=measure["unit"], qualifier=measure["qualifier"], source_kind="vocabulary", source_ref=source_ref,
            defaults={"amount": measure["amount"], "grams": measure["grams"], "confidence": measure["confidence"], "is_default": measure["is_default"], "is_active": True},
        )

    def _upsert_prep_measure(self, prep_yield, measure, source_ref):
        CatalogPreparationMeasure.objects.update_or_create(
            preparation_yield=prep_yield, unit=measure["unit"], qualifier=measure["qualifier"], source_kind="vocabulary", source_ref=source_ref,
            defaults={"amount": measure["amount"], "grams": measure["grams"], "confidence": measure["confidence"], "is_default": measure["is_default"], "is_active": True},
        )
