import json
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from forkluck.models import (
    CatalogIngredient,
    CatalogPreparationYield,
    IngredientMeasureConfidence,
    MAX_PREPARATION_YIELD_PERCENT,
)
from forkluck.domains.shared.values import normalized_name


class Command(BaseCommand):
    help = "Import reviewed preparation yields from a JSON manifest."

    def add_arguments(self, parser) -> None:
        parser.add_argument("path", type=Path)
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **options) -> None:
        path: Path = options["path"]
        if not path.is_file():
            raise CommandError(f"Yield manifest not found: {path}")
        try:
            rows = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise CommandError(f"Yield manifest is not valid JSON: {exc}") from exc
        if not isinstance(rows, list) or not rows:
            raise CommandError("Yield manifest must contain a non-empty JSON array")

        prepared = [self._prepare_row(row, position) for position, row in enumerate(rows, 1)]
        seen: set[tuple[str, str, str, str]] = set()
        default_keys: set[tuple[str, str]] = set()
        for row in prepared:
            key = (
                row["normalized_ingredient"],
                row["normalized_preparation"],
                row["source_kind"],
                row["source_ref"],
            )
            if key in seen:
                raise CommandError(
                    "Duplicate ingredient/preparation/source record in manifest: "
                    f"{row['ingredient']} {row['name']}"
                )
            seen.add(key)
            if row["is_default"]:
                default_key = (
                    row["normalized_ingredient"],
                    row["normalized_preparation"],
                )
                if default_key in default_keys:
                    raise CommandError(
                        "Multiple defaults for ingredient/preparation in manifest: "
                        f"{row['ingredient']} {row['name']}"
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
                    CatalogPreparationYield.objects.filter(
                        ingredient=ingredient,
                        normalized_name=row["normalized_preparation"],
                        is_default=True,
                    ).update(is_default=False)
                yield_row, was_created = CatalogPreparationYield.objects.update_or_create(
                    ingredient=ingredient,
                    normalized_name=row["normalized_preparation"],
                    source_kind=row["source_kind"],
                    source_ref=row["source_ref"],
                    defaults={
                        "name": row["name"],
                        "yield_percent": row["yield_percent"],
                        "low_percent": row["low_percent"],
                        "high_percent": row["high_percent"],
                        "source_release": row["source_release"],
                        "derivation": row["derivation"],
                        "evidence_count": row["evidence_count"],
                        "confidence": row["confidence"],
                        "is_default": row["is_default"],
                        "is_active": row["is_active"],
                    },
                )
                created += int(was_created)
                updated += int(not was_created)
                if not yield_row.is_active and yield_row.is_default:
                    raise CommandError("An inactive yield cannot be the default")
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
        name = self._text(value, "name", position, 120)
        normalized_preparation = normalized_name(name)
        if not normalized_preparation:
            raise CommandError(f"Row {position} name is empty after normalization")
        yield_percent = self._decimal(value.get("yield_percent"), "yield_percent", position)
        low_percent = self._optional_decimal(
            value.get("low_percent"), "low_percent", position
        )
        high_percent = self._optional_decimal(
            value.get("high_percent"), "high_percent", position
        )
        if (low_percent is None) != (high_percent is None):
            raise CommandError(
                f"Row {position} low_percent and high_percent must be provided together"
            )
        if low_percent is not None and high_percent is not None and low_percent > high_percent:
            raise CommandError(f"Row {position} low_percent exceeds high_percent")
        if low_percent is not None and yield_percent < low_percent:
            raise CommandError(f"Row {position} yield_percent is below low_percent")
        if high_percent is not None and yield_percent > high_percent:
            raise CommandError(f"Row {position} yield_percent exceeds high_percent")
        evidence_count = value.get("evidence_count")
        if not isinstance(evidence_count, int) or isinstance(evidence_count, bool) or evidence_count < 1:
            raise CommandError(f"Row {position} evidence_count must be a positive whole number")
        confidence = str(value.get("confidence", "medium"))
        if confidence not in IngredientMeasureConfidence.values:
            raise CommandError(f"Row {position} has invalid confidence")
        is_default = value.get("is_default", True)
        is_active = value.get("is_active", True)
        if not isinstance(is_default, bool) or not isinstance(is_active, bool):
            raise CommandError(f"Row {position} flags must be booleans")
        if is_default and not is_active:
            raise CommandError(f"Row {position} inactive yield cannot be the default")
        return {
            "ingredient": ingredient,
            "normalized_ingredient": normalized_ingredient,
            "name": name,
            "normalized_preparation": normalized_preparation,
            "yield_percent": yield_percent,
            "low_percent": low_percent,
            "high_percent": high_percent,
            "source_kind": self._text(value, "source_kind", position, 32),
            "source_ref": self._text(value, "source_ref", position, 120),
            "source_release": self._text(value, "source_release", position, 120),
            "derivation": self._text(value, "derivation", position, 32),
            "evidence_count": evidence_count,
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
            raise CommandError(f"Row {position} {key} must be a positive percent")
        try:
            result = Decimal(str(value))
        except (InvalidOperation, ValueError):
            raise CommandError(f"Row {position} {key} must be a positive percent") from None
        if (
            not result.is_finite()
            or result <= 0
            or result > MAX_PREPARATION_YIELD_PERCENT
        ):
            raise CommandError(f"Row {position} {key} must be a positive percent")
        return result

    def _optional_decimal(
        self, value: Any, key: str, position: int
    ) -> Decimal | None:
        if value is None:
            return None
        return self._decimal(value, key, position)
