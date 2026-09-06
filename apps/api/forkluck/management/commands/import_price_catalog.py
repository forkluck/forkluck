import hashlib
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from forkluck.models import (
    CatalogImportBatch,
    CatalogIngredient,
    CatalogPriceObservation,
    CatalogProduct,
    CatalogSource,
)
from forkluck.domains.shared.values import normalized_name
from forkluck.price_catalog import normalized_catalog_price


class Command(BaseCommand):
    help = "Import a private source file into the supplier-neutral Forkluck Catalog."

    def add_arguments(self, parser) -> None:
        parser.add_argument("path", type=Path)
        parser.add_argument("--source-key", required=True)
        parser.add_argument("--private-label", default="")
        parser.add_argument(
            "--input-source",
            help="Only import rows whose input supplier field equals this value.",
        )
        parser.add_argument(
            "--mapping",
            type=Path,
            help="JSON object mapping source SKUs to approved canonical names.",
        )
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **options) -> None:
        path: Path = options["path"]
        if not path.is_file():
            raise CommandError(f"Catalog file not found: {path}")
        raw = path.read_bytes()
        try:
            rows = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise CommandError(f"Catalog file is not valid JSON: {exc}") from exc
        if not isinstance(rows, list):
            raise CommandError("Catalog file must contain a JSON array")
        for position, row in enumerate(rows, start=1):
            if not isinstance(row, dict):
                raise CommandError(f"Row {position} must be an object")

        input_source = options.get("input_source")
        if input_source:
            rows = [row for row in rows if row.get("supplier") == input_source]
        if not rows:
            raise CommandError("Catalog file contains no matching rows")

        mapping = self._read_mapping(options.get("mapping"))
        self._validate_mapping(mapping)
        digest = self._import_digest(raw, mapping)
        prepared_rows: list[tuple[dict[str, Any], str, str, str, datetime]] = []
        seen_skus: set[str] = set()
        for position, row in enumerate(rows, start=1):
            sku = str(row.get("sku") or "").strip()
            title = str(row.get("name") or "").strip()
            if not sku or not title:
                raise CommandError(f"Row {position} is missing sku or name")
            if len(sku) > 120:
                raise CommandError(f"Row {position} sku exceeds 120 characters")
            row_observed_at = self._parse_observed_at(row.get("collected_at"))
            if row_observed_at is None:
                raise CommandError(
                    f"Row {position} is missing a valid collected_at timestamp"
                )
            normalized_sku = sku.casefold()
            if len(normalized_sku) > 120:
                raise CommandError(
                    f"Row {position} normalized sku exceeds 120 characters"
                )
            if normalized_sku in seen_skus:
                raise CommandError(f"Duplicate source SKU in file: {sku}")
            seen_skus.add(normalized_sku)
            prepared_rows.append(
                (
                    row,
                    sku,
                    title,
                    normalized_sku,
                    row_observed_at,
                )
            )
        observed_at = max(row_observed_at for *_, row_observed_at in prepared_rows)
        snapshot_external_ids = {
            normalized_sku for _, _, _, normalized_sku, _ in prepared_rows
        }
        snapshot_rows = {
            normalized_sku: (normalized_sku, row_observed_at)
            for _, _, _, normalized_sku, row_observed_at in prepared_rows
        }

        with transaction.atomic():
            source, source_created = CatalogSource.objects.get_or_create(
                key=options["source_key"],
                defaults={
                    "private_label": options["private_label"],
                    "is_active": True,
                },
            )
            source = CatalogSource.objects.select_for_update().get(pk=source.pk)
            if not source_created and source.private_label != options["private_label"]:
                source.private_label = options["private_label"]
                source.save(update_fields=["private_label", "updated_at"])
            if CatalogImportBatch.objects.filter(
                source=source, content_sha256=digest
            ).exists():
                raise CommandError("This exact source file has already been imported")
            is_latest_snapshot = not CatalogImportBatch.objects.filter(
                source=source, observed_at__gt=observed_at
            ).exists()
            batch = CatalogImportBatch.objects.create(
                source=source,
                content_sha256=digest,
                file_name=path.name,
                observed_at=observed_at,
                row_count=len(rows),
            )

            imported = 0
            discarded = 0
            review = 0
            if is_latest_snapshot:
                mapped_products = CatalogProduct.objects.select_related(
                    "ingredient"
                ).filter(
                    source=source,
                    normalized_external_id__in=snapshot_external_ids,
                    ingredient__isnull=False,
                )
                for product in mapped_products:
                    normalized_sku = product.normalized_external_id
                    _, row_observed_at = snapshot_rows[normalized_sku]
                    if row_observed_at < product.observed_at:
                        continue
                    canonical_name = mapping.get(normalized_sku, "").strip()
                    next_normalized = normalized_name(canonical_name)[:120]
                    if next_normalized != product.ingredient.normalized_name:
                        product.ingredient = None
                        product.is_recipe_ready = False
                        product.save(
                            update_fields=[
                                "ingredient",
                                "is_recipe_ready",
                                "updated_at",
                            ]
                        )

            for row, external_id, title, normalized_sku, row_observed_at in prepared_rows:

                canonical_name = mapping.get(normalized_sku, "").strip()
                ingredient = self._catalog_ingredient(canonical_name, row)
                existing_product = CatalogProduct.objects.filter(
                    source=source,
                    normalized_external_id=normalized_sku,
                ).first()
                if existing_product is not None and (
                    not is_latest_snapshot
                    or row_observed_at < existing_product.observed_at
                ):
                    ingredient = existing_product.ingredient
                repeated_products = CatalogProduct.objects.filter(
                    ingredient=ingredient
                )
                if existing_product is not None:
                    repeated_products = repeated_products.exclude(pk=existing_product.pk)
                if (
                    ingredient is not None
                    and is_latest_snapshot
                ):
                    replaced_product = (
                        repeated_products.filter(
                            source=source,
                            observed_at__lte=row_observed_at,
                        )
                        .exclude(normalized_external_id__in=snapshot_external_ids)
                        .first()
                    )
                    if replaced_product is not None:
                        replaced_product.ingredient = None
                        replaced_product.is_recipe_ready = False
                        replaced_product.is_available = False
                        replaced_product.save(
                            update_fields=[
                                "ingredient",
                                "is_recipe_ready",
                                "is_available",
                                "updated_at",
                            ]
                        )
                        repeated_products = repeated_products.exclude(
                            pk=replaced_product.pk
                        )
                if ingredient is not None and repeated_products.exists():
                    if existing_product is not None and existing_product.is_available:
                        existing_product.is_available = False
                        existing_product.save(
                            update_fields=["is_available", "updated_at"]
                        )
                    discarded += 1
                    continue
                price = normalized_catalog_price(row)
                recipe_ready = ingredient is not None and price["pack_grams"] is not None
                defaults: dict[str, Any] = {
                    "import_batch": batch,
                    "ingredient": ingredient,
                    "title": title[:200],
                    "normalized_title": normalized_name(title)[:200],
                    "category": str(row.get("category") or "")[:64],
                    "raw_size": str(row.get("sell_unit") or "")[:120],
                    "currency": str(row.get("currency") or "USD").upper()[:3],
                    "observed_at": row_observed_at,
                    "is_recipe_ready": recipe_ready,
                    "is_available": True,
                    **price,
                }
                if existing_product is None:
                    product = CatalogProduct.objects.create(
                        source=source,
                        external_id=external_id,
                        normalized_external_id=normalized_sku,
                        **{
                            **defaults,
                            "is_available": is_latest_snapshot,
                        },
                    )
                else:
                    product = existing_product
                    if is_latest_snapshot and row_observed_at >= product.observed_at:
                        for field, value in defaults.items():
                            setattr(product, field, value)
                        product.save()
                CatalogPriceObservation.objects.update_or_create(
                    product=product,
                    import_batch=batch,
                    defaults={
                        "observed_at": row_observed_at,
                        "currency": defaults["currency"],
                        "price_basis": defaults["price_basis"],
                        "pack_price_cents": defaults["pack_price_cents"],
                        "pack_grams": defaults["pack_grams"],
                        "pack_amount": defaults["pack_amount"],
                        "pack_unit": defaults["pack_unit"],
                        "raw_size": defaults["raw_size"],
                    },
                )
                imported += 1
                if not recipe_ready:
                    review += 1

            if is_latest_snapshot:
                CatalogProduct.objects.filter(source=source, is_available=True).exclude(
                    normalized_external_id__in=snapshot_external_ids
                ).update(is_available=False, updated_at=timezone.now())

            batch.imported_count = imported
            batch.discarded_count = discarded
            batch.review_count = review
            batch.save(
                update_fields=[
                    "imported_count",
                    "discarded_count",
                    "review_count",
                    "updated_at",
                ]
            )
            if options["dry_run"]:
                transaction.set_rollback(True)

        mode = "Dry run" if options["dry_run"] else "Imported"
        self.stdout.write(
            self.style.SUCCESS(
                f"{mode}: {imported} products; {discarded} repeated products discarded; "
                f"{review} hidden for mapping or weight review."
            )
        )

    def _read_mapping(self, path: Path | None) -> dict[str, str]:
        if path is None:
            return {}
        if not path.is_file():
            raise CommandError(f"Mapping file not found: {path}")
        try:
            value = json.loads(path.read_text())
        except json.JSONDecodeError as exc:
            raise CommandError(f"Mapping file is not valid JSON: {exc}") from exc
        if not isinstance(value, dict) or not all(
            isinstance(key, str) and isinstance(name, str)
            for key, name in value.items()
        ):
            raise CommandError("Mapping file must be an object of SKU-to-name strings")
        mapping: dict[str, str] = {}
        for key, name in value.items():
            normalized_key = key.strip().casefold()
            if normalized_key in mapping:
                raise CommandError(
                    f"Duplicate mapping SKU after normalization: {key}"
                )
            mapping[normalized_key] = name
        return mapping

    def _import_digest(self, raw: bytes, mapping: dict[str, str]) -> str:
        """Identify the source snapshot together with its approved mapping."""
        normalized_mapping = json.dumps(
            mapping,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(raw + b"\0catalog-mapping\0" + normalized_mapping).hexdigest()

    def _validate_mapping(self, mapping: dict[str, str]) -> None:
        for sku, canonical_name in mapping.items():
            canonical_name = canonical_name.strip()
            normalized = normalized_name(canonical_name)
            if len(canonical_name) > 120 or len(normalized) > 120:
                raise CommandError(
                    f"Canonical name for SKU {sku} exceeds 120 characters"
                )

    def _catalog_ingredient(
        self, canonical_name: str, row: dict[str, Any]
    ) -> CatalogIngredient | None:
        if not canonical_name:
            return None
        normalized = normalized_name(canonical_name)
        if not normalized:
            return None
        ingredient, _ = CatalogIngredient.objects.get_or_create(
            normalized_name=normalized,
            defaults={
                "name": canonical_name,
                "category": str(row.get("category") or "")[:64],
            },
        )
        return ingredient

    def _parse_observed_at(self, value: Any):
        if not isinstance(value, str):
            return None
        parsed = parse_datetime(value)
        if parsed is None:
            return None
        if timezone.is_naive(parsed):
            parsed = timezone.make_aware(parsed)
        return parsed
