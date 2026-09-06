import json
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from forkluck.models import (
    CatalogIngredient,
    CatalogIngredientMeasure,
    IngredientMeasureConfidence,
    MAX_INGREDIENT_MEASURE_VALUE,
)
from forkluck.domains.shared.values import normalized_name
from forkluck.units import MEASURE_UNIT_VALUES


class Command(BaseCommand):
    help = "Import reviewed ingredient household measures from a JSON manifest."

    def add_arguments(self, parser) -> None:
        parser.add_argument("path", type=Path)
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **options) -> None:
        path: Path = options["path"]
        if not path.is_file():
            raise CommandError(f"Measure manifest not found: {path}")
        try:
            rows = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise CommandError(f"Measure manifest is not valid JSON: {exc}") from exc
        if not isinstance(rows, list) or not rows:
            raise CommandError("Measure manifest must contain a non-empty JSON array")

        prepared = [self._prepare_row(row, position) for position, row in enumerate(rows, 1)]
        seen: set[tuple[str, str, str, str, str]] = set()
        default_keys: set[tuple[str, str, str]] = set()
        for row in prepared:
            key = (
                row["normalized_ingredient"],
                row["unit"],
                row["qualifier"],
                row["source_kind"],
                row["source_ref"],
            )
            if key in seen:
                raise CommandError(
                    "Duplicate ingredient/unit/qualifier/source record in manifest: "
                    f"{row['ingredient']} {row['unit']} {row['qualifier']}"
                )
            seen.add(key)
            if row["is_default"]:
                default_key = (
                    row["normalized_ingredient"],
                    row["unit"],
                    row["qualifier"],
                )
                if default_key in default_keys:
                    raise CommandError(
                        "Multiple defaults for ingredient/unit/qualifier in manifest: "
                        f"{row['ingredient']} {row['unit']} {row['qualifier']}"
                    )
                default_keys.add(default_key)

        created = 0
        updated = 0
        with transaction.atomic():
            for row in prepared:
                ingredient, _ = CatalogIngredient.objects.get_or_create(
                    normalized_name=row["normalized_ingredient"],
                    defaults={"name": row["ingredient"]},
                )
                if row["is_default"]:
                    CatalogIngredientMeasure.objects.filter(
                        ingredient=ingredient,
                        unit=row["unit"],
                        qualifier=row["qualifier"],
                        is_default=True,
                    ).update(is_default=False)
                measure, was_created = CatalogIngredientMeasure.objects.update_or_create(
                    ingredient=ingredient,
                    unit=row["unit"],
                    qualifier=row["qualifier"],
                    source_kind=row["source_kind"],
                    source_ref=row["source_ref"],
                    defaults={
                        "amount": row["amount"],
                        "grams": row["grams"],
                        "low_grams": row["low_grams"],
                        "high_grams": row["high_grams"],
                        "confidence": row["confidence"],
                        "is_default": row["is_default"],
                        "is_active": row["is_active"],
                    },
                )
                created += int(was_created)
                updated += int(not was_created)
                if not measure.is_active and measure.is_default:
                    raise CommandError("An inactive measure cannot be the default")
            if options["dry_run"]:
                transaction.set_rollback(True)

        mode = "Dry run" if options["dry_run"] else "Imported"
        self.stdout.write(
            self.style.SUCCESS(f"{mode}: {created} created; {updated} updated.")
        )

    def _prepare_row(self, value: Any, position: int) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise CommandError(f"Row {position} must be an object")
        ingredient = self._text(value, "ingredient", position, 120)
        normalized_ingredient = normalized_name(ingredient)
        if not normalized_ingredient:
            raise CommandError(f"Row {position} ingredient is empty after normalization")
        unit = self._text(value, "unit", position, 8)
        if unit not in MEASURE_UNIT_VALUES:
            raise CommandError(f"Row {position} has an unsupported unit: {unit}")
        qualifier_value = value.get("qualifier", "")
        if not isinstance(qualifier_value, str) or len(qualifier_value) > 120:
            raise CommandError(f"Row {position} qualifier must be text up to 120 characters")
        qualifier = normalized_name(qualifier_value)
        amount = self._decimal(value.get("amount"), "amount", position)
        grams = self._decimal(value.get("grams"), "grams", position)
        low_grams = self._optional_decimal(value.get("low_grams"), "low_grams", position)
        high_grams = self._optional_decimal(
            value.get("high_grams"), "high_grams", position
        )
        if (low_grams is None) != (high_grams is None):
            raise CommandError(
                f"Row {position} low_grams and high_grams must be provided together"
            )
        if low_grams is not None and high_grams is not None and low_grams > high_grams:
            raise CommandError(f"Row {position} low_grams exceeds high_grams")
        if low_grams is not None and grams < low_grams:
            raise CommandError(f"Row {position} grams is below low_grams")
        if high_grams is not None and grams > high_grams:
            raise CommandError(f"Row {position} grams exceeds high_grams")
        confidence = str(value.get("confidence", "medium"))
        if confidence not in IngredientMeasureConfidence.values:
            raise CommandError(f"Row {position} has invalid confidence")
        is_default = value.get("is_default", True)
        is_active = value.get("is_active", True)
        if not isinstance(is_default, bool) or not isinstance(is_active, bool):
            raise CommandError(f"Row {position} flags must be booleans")
        if is_default and not is_active:
            raise CommandError(f"Row {position} inactive measure cannot be the default")
        return {
            "ingredient": ingredient,
            "normalized_ingredient": normalized_ingredient,
            "unit": unit,
            "amount": amount,
            "grams": grams,
            "low_grams": low_grams,
            "high_grams": high_grams,
            "qualifier": qualifier,
            "source_kind": self._text(value, "source_kind", position, 32),
            "source_ref": self._text(value, "source_ref", position, 120),
            "confidence": confidence,
            "is_default": is_default,
            "is_active": is_active,
        }

    def _text(
        self, value: dict[str, Any], key: str, position: int, maximum: int
    ) -> str:
        result = value.get(key)
        if not isinstance(result, str) or not result.strip() or len(result) > maximum:
            raise CommandError(
                f"Row {position} {key} must be non-empty text up to {maximum} characters"
            )
        return result.strip()

    def _decimal(self, value: Any, key: str, position: int) -> Decimal:
        if isinstance(value, bool):
            raise CommandError(f"Row {position} {key} must be a positive number")
        try:
            result = Decimal(str(value))
        except (InvalidOperation, ValueError):
            raise CommandError(f"Row {position} {key} must be a positive number") from None
        if (
            not result.is_finite()
            or result <= 0
            or result > MAX_INGREDIENT_MEASURE_VALUE
        ):
            raise CommandError(f"Row {position} {key} must be a positive number")
        return result

    def _optional_decimal(
        self, value: Any, key: str, position: int
    ) -> Decimal | None:
        if value is None:
            return None
        return self._decimal(value, key, position)
