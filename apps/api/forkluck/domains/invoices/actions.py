"""Invoice and expense mutations.

Invoice PDFs are parsed by the Next.js process; Django receives normalized
JSON. Lines in an is_ingredient category run through the same
apply_supplier_import_entry pipeline as the spreadsheet import, so both
paths update the same SupplierItem rows and share the undo machinery.
"""

import hashlib
import json
from collections import defaultdict, deque
from collections.abc import Callable
from datetime import date, datetime, time
from datetime import timezone as datetime_timezone
from decimal import Decimal
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import Max
from django.utils import timezone

from ...integrations.token_crypto import encrypt_token
from ...models import (
    INVOICE_PAYMENT_METHODS,
    AnthropicCredential,
    BenchCostSettings,
    DriveFile,
    DriveFileExtraction,
    DriveFolderSource,
    DriveWatchState,
    ExpenseCategory,
    Ingredient,
    IngredientImport,
    IngredientImportItem,
    IngredientInvoicePrice,
    IngredientPrice,
    Invoice,
    InvoiceExtraction,
    InvoiceLine,
    PaymentMethod,
    ReceiptFeedback,
    Supplier,
    SupplierItem,
    SupplierItemIgnore,
    User,
)
from ..shared.activity import record_event
from ..shared.ingredient_identity import saved_line_match_map
from ..shared.ingredient_pricing import apply_price, create_priced_ingredient
from ..shared.locking import lock_workspace
from ..shared.supplier_import import (
    apply_supplier_import_entry,
    ensure_supplier,
    ingredient_snapshot,
    ingredient_values,
    invoice_line_pack_price_cents,
    promote_next_preferred,
    supplier_item_key,
    supplier_key_from_name,
    upsert_supplier_ignores,
)
from ..shared.values import (
    bool_value,
    import_date_value,
    int_value,
    iso,
    normalized_name,
    number_value,
    optional_text,
    signed_cents,
    text_value,
    uuid_value,
)
from ..shared.versioning import check_and_bump
from .serializers import (
    drive_folder_json,
    expense_category_json,
    invoice_detail_json,
)
from .ai_usage import action_invoice_ai_usage

JsonObject = dict[str, Any]


# (name, costable, supply). A supply category buys what the kitchen does not
# eat, and is costable so a packaging or cleaning line can price the supply it
# bought; is_ingredient stays the "costable" flag for both kinds.
DEFAULT_EXPENSE_CATEGORIES: tuple[tuple[str, bool, bool], ...] = (
    ("Ingredients", True, False),
    ("Staff meal", False, False),
    ("Packaging", True, True),
    ("Cleaning supplies", True, True),
    ("Equipment", False, False),
    ("Repairs", False, False),
    ("Utilities", False, False),
    ("Other", False, False),
)


INVOICE_DOCUMENT_TYPES = {value for value, _ in Invoice.DocumentType.choices}


# Credits and refunds never update prices; only these document types may
# carry cost entries.
COSTABLE_DOCUMENT_TYPES = {
    Invoice.DocumentType.INVOICE,
    Invoice.DocumentType.RECEIPT,
}

# The two documents whose printed total is money coming back, so a negative
# total on them is what the supplier wrote rather than a typo.
CREDIT_DOCUMENT_TYPES = {
    Invoice.DocumentType.CREDIT_MEMO,
    Invoice.DocumentType.REFUND,
}


def action_save_anthropic_key(user: User, body: JsonObject) -> JsonObject:
    key = text_value(body.get("key"), "API key", max_length=300).strip()
    if not key.startswith("sk-ant-") or len(key) < 20:
        raise ValueError("That doesn't look like an Anthropic API key")
    hint = key[-4:]
    AnthropicCredential.objects.update_or_create(
        user=user,
        defaults={"api_key_encrypted": encrypt_token(key), "key_hint": hint},
    )
    return {"configured": True, "hint": hint}


def action_delete_anthropic_key(user: User, body: JsonObject) -> JsonObject:
    AnthropicCredential.objects.filter(user=user).delete()
    return {"ok": True}


def ensure_expense_categories(user: User) -> None:
    existing = set(
        ExpenseCategory.objects.filter(user=user).values_list(
            "normalized_name", flat=True
        )
    )
    for position, (name, is_ingredient, is_supply) in enumerate(
        DEFAULT_EXPENSE_CATEGORIES
    ):
        normalized = normalized_name(name)
        if normalized in existing:
            continue
        # Two first page loads can race past the existence check; the unique
        # constraint picks the winner and the loser just moves on.
        try:
            with transaction.atomic():
                ExpenseCategory.objects.create(
                    user=user,
                    name=name,
                    normalized_name=normalized,
                    is_ingredient=is_ingredient,
                    is_supply=is_supply,
                    position=position,
                )
        except IntegrityError:
            continue


def invoice_fingerprint(
    supplier: str,
    invoice_number: str,
    invoice_date: date | None,
    total_cents: int,
    document_type: str = Invoice.DocumentType.INVOICE,
) -> str:
    """Stable identity for a supplier document.

    Supplier invoice numbers identify invoices even when a corrected read
    changes the date or total. Grocery receipts are different: readers often
    surface a cashier/operator number as the document number, and that value
    repeats across unrelated purchases. Receipts therefore dedupe on their
    date and total as well as the printed number.
    """
    number = invoice_number.strip().lower()
    if document_type == Invoice.DocumentType.RECEIPT:
        key = (
            f"r|{supplier}|{number}|"
            f"{invoice_date.isoformat() if invoice_date else ''}|{total_cents}"
        )
    elif number:
        key = f"n|{supplier}|{number}"
    else:
        key = f"d|{supplier}|{invoice_date.isoformat() if invoice_date else ''}|{total_cents}"
    return hashlib.sha256(key.encode()).hexdigest()


def price_effective_at(invoice_date: date) -> datetime:
    """A price row needs a timestamp; an invoice only carries a date. Start of
    day, clamped to now for future-dated documents, so an interactive edit made
    today still counts as the newest price for the ingredient."""
    start = datetime.combine(invoice_date, time.min, tzinfo=datetime_timezone.utc)
    return min(start, timezone.now())


DRIVE_FILE_PART_MAX = 40


def settle_drive_file(row: DriveFile, parts: set[int], status: str) -> None:
    """Mark these documents of a file decided and, when none is still waiting,
    close the file itself.

    A file holding one receipt walks the same path: its only part is part 0
    and the file flips on the same call. What the watcher read is dropped only
    once the whole file is done — an imported part's truth is now the invoice,
    but the parts still waiting still need theirs. A file that ends with any
    part imported counts as imported, even where its neighbours were skipped.
    """
    extractions = DriveFileExtraction.objects.filter(drive_file=row)
    extractions.filter(part__in=parts).update(status=status)
    statuses = set(extractions.values_list("status", flat=True))
    if DriveFileExtraction.Status.READY in statuses:
        return
    extractions.delete()
    imported = (
        DriveFileExtraction.Status.IMPORTED in statuses
        or status == DriveFileExtraction.Status.IMPORTED
    )
    row.status = DriveFile.Status.IMPORTED if imported else DriveFile.Status.SKIPPED
    row.save(update_fields=["status", "reason", "updated_at"])


def drive_file_part(value: Any) -> int:
    """Which document of a Drive file this is. 0 — the whole file — unless
    the file held several receipts and the reader split it."""
    if value is None:
        return 0
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("Drive part looks malformed")
    if not 0 <= value < DRIVE_FILE_PART_MAX:
        raise ValueError("Drive part looks malformed")
    return value


def action_invoice_line_status(user: User, body: JsonObject) -> JsonObject:
    """Per-file probe run right after extraction: stamps each line with the
    matching supplier item / ingredient / skip-list state plus its most
    recent expense category, and flags the invoice header as a duplicate."""
    ensure_expense_categories(user)
    supplier = (
        text_value(body.get("supplier"), "Supplier", max_length=64).strip().lower()
    )
    lines = body.get("lines")
    if not isinstance(lines, list) or len(lines) > 500:
        raise ValueError("Invoice lines look malformed")

    keys: list[str] = []
    names: list[str] = []
    for line in lines:
        if not isinstance(line, dict):
            raise ValueError("Invoice lines look malformed")
        name = optional_text(line.get("name"), "Line name", max_length=240)
        names.append(name)
        # The browser sends what the document printed; the key it is
        # remembered under is derived here, so a code-less line has memory too.
        keys.append(
            supplier_item_key(
                optional_text(line.get("sku"), "Supplier item ID", max_length=120),
                name,
            )
        )

    present_keys = [key for key in keys if key]
    supplier_items = {
        item.external_id: item
        for item in SupplierItem.objects.filter(
            user=user, supplier=supplier, external_id__in=present_keys
        ).select_related("ingredient")
    }
    ignored_ids = set(
        SupplierItemIgnore.objects.filter(
            user=user, supplier=supplier, external_id__in=present_keys
        ).values_list("external_id", flat=True)
    )
    last_categories: dict[str, str] = {}
    history = (
        InvoiceLine.objects.filter(
            user=user,
            invoice__supplier=supplier,
            item_key__in=present_keys,
            category__isnull=False,
        )
        .order_by("-created_at")
        .values_list("item_key", "category_id")[:2000]
    )
    for item_key, category_id in history:
        last_categories.setdefault(item_key, str(category_id))
    # What the supplier files under when this particular line has no memory of
    # its own. One lookup for the document, never one per line.
    supplier_default = (
        Supplier.objects.filter(user=user, key=supplier)
        .values_list("default_category_id", flat=True)
        .first()
    )
    supplier_default_id = str(supplier_default) if supplier_default else None

    normalized_names = {normalized_name(name) for name in names if name}
    ingredients_by_name = {
        row.normalized_name: row
        for row in Ingredient.objects.filter(
            user=user, normalized_name__in=normalized_names
        )
    }
    ingredient_by_id = {
        str(row.id): row for row in Ingredient.objects.filter(user=user)
    }
    matches_by_name = {
        line: ingredient_by_id.get(target_id)
        for line, (target_id, kind) in saved_line_match_map(user).items()
        if kind == "ingredient" and target_id in ingredient_by_id
    }

    items: list[JsonObject] = []
    for index, (key, name) in enumerate(zip(keys, names)):
        item = supplier_items.get(key) if key else None
        matched = None
        if item is not None:
            matched = item.ingredient
        elif name:
            by_name = normalized_name(name)
            matched = ingredients_by_name.get(by_name) or matches_by_name.get(by_name)
        items.append(
            {
                "index": index,
                "supplierItem": (
                    {
                        "id": str(item.id),
                        "ingredientId": str(item.ingredient_id),
                        "ingredientName": item.ingredient.name,
                        "title": item.title,
                        "rawSize": item.raw_size,
                        "packPriceCents": item.pack_price_cents,
                        "packAmount": float(item.pack_amount),
                        "packUnit": item.pack_unit,
                        "packGrams": item.pack_grams,
                        "isPreferred": item.is_preferred,
                    }
                    if item is not None
                    else None
                ),
                "ignored": key in ignored_ids if key else False,
                "matchedIngredientId": str(matched.id) if matched else None,
                "matchedIngredientName": matched.name if matched else None,
                "lastCategoryId": (
                    (last_categories.get(key) if key else None) or supplier_default_id
                ),
            }
        )

    duplicate = False
    # The row behind `duplicate`, so the review screen can put this receipt
    # beside the invoice it would repeat instead of only naming the clash.
    existing_invoice = None
    header = body.get("invoice")
    if header is not None:
        if not isinstance(header, dict):
            raise ValueError("Invoice header looks malformed")
        header_document_type = (
            optional_text(header.get("documentType"), "Document type", max_length=32)
            or Invoice.DocumentType.INVOICE
        )
        if header_document_type not in INVOICE_DOCUMENT_TYPES:
            raise ValueError("Unsupported document type")
        fingerprint = invoice_fingerprint(
            supplier,
            optional_text(header.get("invoiceNumber"), "Invoice number", max_length=64),
            import_date_value(header.get("invoiceDate"), "Invoice date"),
            signed_cents(header.get("totalCents"), "Invoice total"),
            header_document_type,
        )
        match = Invoice.objects.filter(
            user=user, source_fingerprint=fingerprint
        ).first()
        duplicate = match is not None
        if match is not None:
            existing_invoice = {
                "id": str(match.id),
                "publicId": match.public_id,
                "invoiceNumber": match.invoice_number,
                "invoiceDate": (
                    match.invoice_date.isoformat() if match.invoice_date else None
                ),
                "totalCents": match.total_cents,
                "lineCount": match.line_count,
                "importedAt": iso(match.created_at),
            }

    # A Drive file already imported under a different total or number is not a
    # fingerprint duplicate, so the review step asks about the file itself.
    drive_file_id = optional_text(
        body.get("driveFileId"), "Drive file id", max_length=128
    )
    # A file may hold several receipts, so it is the part that was imported,
    # not the file: importing receipt 1 of a bundle must not make receipt 2
    # look like a repeat.
    drive_part = drive_file_part(body.get("drivePart"))
    drive_file_known = (
        bool(drive_file_id)
        and Invoice.objects.filter(
            user=user, drive_file_id=drive_file_id, drive_file_part=drive_part
        ).exists()
    )

    categories = ExpenseCategory.objects.filter(user=user)
    return {
        "items": items,
        "duplicate": duplicate,
        "existingInvoice": existing_invoice,
        "driveFileKnown": drive_file_known,
        "categories": [expense_category_json(row) for row in categories],
    }


def line_is_supply(line: JsonObject, categories: dict[str, ExpenseCategory]) -> bool:
    """Whether this line was filed under a supply category, so an ingredient it
    creates is non-edible. Read off the stored category, never the payload."""
    category_id = line.get("categoryId")
    if category_id is None:
        return False
    category = categories.get(str(category_id))
    return category is not None and category.is_supply


def apply_one_time_cost_line(
    user: User,
    ingredient_import: IngredientImport,
    position: int,
    cost: JsonObject,
    *,
    supplier: str,
    invoice_date: date,
    supply: bool,
) -> Ingredient:
    """Price one line without remembering the pack it came in.

    The merchant unticked "Remember for this supplier", so no SupplierItem is
    written and the next invoice printing this item asks again. A new
    ingredient starts with this price, but a one-off purchase never replaces
    an existing ingredient's costing source.
    """
    values = ingredient_values(cost)
    requested_ingredient_id = cost.get("ingredientId")
    if requested_ingredient_id is not None:
        row = Ingredient.objects.filter(
            user=user,
            id=uuid_value(requested_ingredient_id, "ingredient id"),
        ).first()
        if row is None:
            raise ValueError("Ingredient match was not found")
    else:
        row = Ingredient.objects.filter(
            user=user, normalized_name=normalized_name(values["name"])
        ).first()
    ingredient_before = ingredient_snapshot(row) if row else None
    ingredient_created = row is None
    price = None
    if row is None:
        row, price = create_priced_ingredient(
            user,
            values,
            source=IngredientPrice.Source.SUPPLIER,
            effective_at=price_effective_at(invoice_date),
            extra_fields={"non_edible": True} if supply else None,
        )
    # No supplier snapshots: undo walks every supplier branch behind
    # `if supplier_after`, so this row unwinds the ingredient and its price
    # alone.
    IngredientImportItem.objects.create(
        ingredient_import=ingredient_import,
        position=position * 2,
        supplier=supplier,
        external_id="",
        operation=IngredientImportItem.Operation.UPDATED,
        supplier_before=None,
        supplier_after=None,
        ingredient_before=ingredient_before,
        ingredient_after=ingredient_snapshot(row),
        ingredient_created=ingredient_created,
        price_history_id=price.id if price else None,
    )
    return row


def apply_invoice_cost_line(
    user: User,
    ingredient_import: IngredientImport,
    position: int,
    line: JsonObject,
    *,
    supplier: str,
    invoice_date: date,
    supply: bool = False,
) -> tuple[bool | None, SupplierItem | None, Ingredient]:
    """Run one costed invoice line through the supplier-item pipeline.

    Returns whether a SupplierItem was created, that item, and the ingredient.
    A line the merchant asked us not to remember has no supplier item at all,
    and the first two are then None.
    """
    cost = line["costEntry"]
    if not isinstance(cost, dict):
        raise ValueError("Cost entry looks malformed")
    if not cost.get("remember", True):
        return (
            None,
            None,
            apply_one_time_cost_line(
                user,
                ingredient_import,
                position,
                cost,
                supplier=supplier,
                invoice_date=invoice_date,
                supply=supply,
            ),
        )
    # Derived here, never read off the payload: the key decides which stored
    # product this price lands on.
    external_id = supplier_item_key(
        optional_text(line.get("sku"), "Supplier item ID", max_length=120),
        text_value(line.get("description"), "Description", max_length=240),
    )
    import_entry = {
        "name": cost.get("name"),
        "packUnit": cost.get("packUnit"),
        "packAmount": cost.get("packAmount"),
        "packPriceCents": cost.get("packPriceCents"),
        "supplier": supplier,
        "externalId": external_id,
        "rawSize": cost.get("rawSize"),
        "quantity": cost.get("quantity"),
        "preferred": cost.get("preferred", False),
        "periodStart": invoice_date.isoformat(),
        "periodEnd": invoice_date.isoformat(),
        "ingredientId": cost.get("ingredientId"),
    }
    return apply_supplier_import_entry(
        user,
        ingredient_import,
        position,
        import_entry,
        effective_at=price_effective_at(invoice_date),
        non_edible=supply,
        allow_preferred_selection=False,
    )


def persist_invoice(
    user: User,
    entry: JsonObject,
    *,
    ingredient_import: IngredientImport | None,
    categories: dict[str, ExpenseCategory],
    applied: dict[int, tuple[SupplierItem | None, Ingredient]],
    invoice: Invoice | None = None,
) -> tuple[Invoice, int]:
    """Write one validated invoice and its lines. Returns the row and how many
    of its lines were expense-only.

    `applied` is keyed by `id(line)`, so it carries the supplier item and
    ingredient the caller already wrote for that exact line object. Passing an
    `invoice` replaces its lines rather than creating a second document.
    """
    fields = {
        "currency_code": entry["currency_code"],
        "supplier": entry["supplier"],
        "supplier_name": entry["supplier_name"],
        "document_type": entry["document_type"],
        "invoice_number": entry["invoice_number"],
        "invoice_date": entry["invoice_date"],
        "due_date": entry.get("due_date"),
        "total_cents": entry["total_cents"],
        "tax_cents": entry.get("tax_cents", 0),
        "subtotal_cents": entry.get("subtotal_cents"),
        "notes": entry.get("notes", ""),
        "payment_method": entry.get("payment_method", ""),
        "source": entry.get("source", ""),
        "source_fingerprint": entry["fingerprint"],
        "file_name": entry["file_name"],
        "drive_file_id": entry.get("drive_file_id", ""),
        "drive_file_part": entry.get("drive_file_part", 0),
        "drive_web_view_link": entry.get("drive_web_view_link", ""),
        "document_key": entry.get("document_key", ""),
        "extraction_model": entry.get("extraction_model", ""),
    }
    batch = (
        ingredient_import
        if any(id(line) in applied for line in entry["lines"])
        else None
    )
    old_lines: list[InvoiceLine] = []
    if invoice is None:
        invoice = Invoice.objects.create(user=user, ingredient_import=batch, **fields)
    else:
        for name, value in fields.items():
            setattr(invoice, name, value)
        # A save with no cost lines leaves the earlier batch attached: that
        # link is what the ingredients Import history undoes.
        if batch is not None:
            invoice.ingredient_import = batch
        invoice.save(update_fields=[*fields, "ingredient_import", "updated_at"])
        old_lines = list(
            invoice.lines.order_by("position", "id").prefetch_related("ingredient_prices")
        )

    # Item codes identify products, not occurrences on a document. Reserve
    # explicit row identities first; older clients without ids consume each
    # matching occurrence once, in document order.
    old_by_id = {row.id: row for row in old_lines}
    previous_lines: dict[int, InvoiceLine] = {}
    used_ids = set()
    for line in entry["lines"]:
        if line.get("id") is None:
            continue
        line_id = uuid_value(line["id"], "invoice line id")
        if line_id not in old_by_id or line_id in used_ids:
            raise ValueError("Invoice line not found or repeated")
        previous_lines[id(line)] = old_by_id[line_id]
        used_ids.add(line_id)
    legacy_lines: dict[str, deque[InvoiceLine]] = defaultdict(deque)
    for row in old_lines:
        if row.id not in used_ids:
            legacy_lines[row.item_key].append(row)
    for line in entry["lines"]:
        if "id" not in line:
            key = supplier_item_key(
                optional_text(line.get("sku"), "Supplier item ID", max_length=120),
                text_value(line.get("description"), "Description", max_length=240).strip(),
            )
            if legacy_lines[key]:
                previous_lines[id(line)] = legacy_lines[key].popleft()
    previous_price_links = {
        key: [
            (
                price.ingredient_id,
                price.purchase_size,
                price.purchase_unit,
                price.ingredient_import_id,
            )
            for price in row.ingredient_prices.all()
        ]
        for key, row in previous_lines.items()
    }
    invoice.lines.all().delete()

    matched = 0
    unresolved = 0
    expense_only = 0
    for line_position, line in enumerate(entry["lines"]):
        category_id = line.get("categoryId")
        category = None
        if category_id is not None:
            category = categories.get(str(category_id))
            if category is None:
                raise ValueError("Expense category was not found")
        quantity = number_value(
            line.get("quantity"),
            "Quantity",
            minimum=-1000000,
            maximum=1000000,
            nullable=True,
        )
        cost_result = applied.get(id(line))
        needs_review = line.get("needsReview", False)
        if not isinstance(needs_review, bool):
            raise ValueError("Invoice line review state looks malformed")
        source_payload = line.get("sourcePayload")
        sku = optional_text(line.get("sku"), "Supplier item ID", max_length=120)
        description = text_value(
            line.get("description"), "Description", max_length=240
        ).strip()
        item_key = supplier_item_key(sku, description)
        previous = previous_lines.get(id(line))
        if cost_result is not None:
            matched_item_id = cost_result[0].id if cost_result[0] else None
            matched_ingredient_id = cost_result[1].id
            price_updated = True
        else:
            matched_item_id = previous.supplier_item_id if previous else None
            matched_ingredient_id = previous.ingredient_id if previous else None
            price_updated = previous.price_updated if previous else False
        saved_line = InvoiceLine.objects.create(
            **({"id": previous.id} if previous else {}),
            user=user,
            invoice=invoice,
            currency_code=entry["currency_code"],
            position=line_position,
            sku=sku.lower(),
            item_key=item_key,
            description=description,
            quantity=(
                Decimal(str(round(quantity, 3))) if quantity is not None else None
            ),
            unit=optional_text(line.get("unit"), "Unit", max_length=32),
            pack_size=optional_text(line.get("packSize"), "Pack size", max_length=120),
            unit_price_cents=signed_cents(
                line.get("unitPriceCents"), "Unit price", nullable=True
            ),
            line_amount_cents=signed_cents(line.get("lineAmountCents"), "Line amount"),
            category=category,
            supplier_item_id=matched_item_id,
            ingredient_id=matched_ingredient_id,
            price_updated=price_updated,
            needs_review=needs_review,
            source_payload=(source_payload if isinstance(source_payload, dict) else {}),
        )
        # Replacing an edited invoice replaces its line rows. Reattach every
        # ingredient price that belonged to this exact old line, including
        # secondary links such as Egg yolk on a purchase whose
        # primary invoice classification is Egg.
        current_cost = _pack_price_cents(saved_line)
        if current_cost >= 0:
            for (
                linked_ingredient_id,
                linked_size,
                linked_unit,
                linked_import_id,
            ) in previous_price_links.get(id(line), []):
                IngredientInvoicePrice.objects.update_or_create(
                    user=user,
                    ingredient_id=linked_ingredient_id,
                    invoice_line=saved_line,
                    defaults={
                        "purchase_size": linked_size,
                        "purchase_unit": linked_unit,
                        "ingredient_import_id": linked_import_id,
                    },
                )
        if matched_ingredient_id is not None:
            matched_ingredient = (
                cost_result[1]
                if cost_result is not None
                else Ingredient.objects.get(user=user, id=matched_ingredient_id)
            )
            # A replacement may already have restored a user-owned reference
            # (including its hand-entered measure and undo independence).
            # Create the automatic primary reference only when none survived.
            if not IngredientInvoicePrice.objects.filter(
                ingredient=matched_ingredient, invoice_line=saved_line
            ).exists():
                remember_invoice_price(
                    saved_line,
                    matched_ingredient,
                    cost_result[0] if cost_result is not None else None,
                    line.get("costEntry") if cost_result is not None else None,
                )
        if matched_ingredient_id is not None:
            matched += 1
        if needs_review:
            unresolved += 1
        elif matched_ingredient_id is None:
            expense_only += 1
    invoice.line_count = len(entry["lines"])
    invoice.matched_line_count = matched
    invoice.unresolved_line_count = unresolved
    invoice.save(
        update_fields=[
            "line_count",
            "matched_line_count",
            "unresolved_line_count",
            "updated_at",
        ]
    )
    return invoice, expense_only


# What one read of a document may weigh. A page of lines is a few kilobytes;
# this only stops a client from filing an archive against an invoice.
MAX_EXTRACTION_BYTES = 64 * 1024


def extraction_document(value: object) -> JsonObject | None:
    """The raw read the client sends alongside an invoice, or None.

    Opaque here, validated only as `InvoiceLine.source_payload` is — an object,
    and small enough to sit beside the invoice.
    """
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("Extraction data looks malformed")
    if len(json.dumps(value)) > MAX_EXTRACTION_BYTES:
        raise ValueError("The extracted document is too large to store")
    return value


def action_save_receipt_feedback(user: User, body: JsonObject) -> JsonObject:
    submission_id = uuid_value(body.get("id"), "Feedback id")
    rating = text_value(body.get("rating"), "Rating", max_length=4)
    if rating not in ReceiptFeedback.Rating.values:
        raise ValueError("Choose thumbs up or thumbs down")
    original = extraction_document(body.get("original"))
    corrected = extraction_document(body.get("corrected"))
    if original is None or corrected is None:
        raise ValueError("Receipt snapshots are required")
    values = {
        "rating": rating,
        "note": optional_text(body.get("note"), "Note", max_length=2000),
        "file_name": text_value(body.get("fileName"), "File name", max_length=255),
        "supplier_name": optional_text(body.get("supplierName"), "Supplier", max_length=120),
        "extraction_model": text_value(body.get("model"), "Reader", max_length=64),
        "extraction": extraction_document(body.get("extraction")),
        "original": original,
        "corrected": corrected,
    }
    with transaction.atomic():
        lock_workspace(user)
        row, created = ReceiptFeedback.objects.get_or_create(
            user=user, submission_id=submission_id, defaults=values
        )
        if not created:
            # One report per review session; retrying cannot create duplicates.
            # A resubmission retains its initial read and refreshes only what
            # the user reports now. No invoice or pantry row is touched.
            changed = any(getattr(row, field) != values[field] for field in ("rating", "note", "corrected"))
            if changed:
                row.rating = rating
                row.note = values["note"]
                row.corrected = corrected
                row.reviewed = False
                row.save(update_fields=["rating", "note", "corrected", "reviewed", "updated_at"])
    return {"ok": True}


def action_import_invoices(user: User, body: JsonObject) -> JsonObject:
    invoices = body.get("invoices")
    if not isinstance(invoices, list) or not 1 <= len(invoices) <= 40:
        raise ValueError("Import data looks malformed")
    total_lines = 0
    for entry in invoices:
        if not isinstance(entry, dict) or not isinstance(entry.get("lines"), list):
            raise ValueError("Import data looks malformed")
        total_lines += len(entry["lines"])
    if total_lines > 500:
        raise ValueError("An import can include at most 500 invoice lines")
    reviewed_currency = body.get("reviewedCurrencyCode")
    if not isinstance(reviewed_currency, str) or len(reviewed_currency.strip()) != 3:
        raise ValueError("Import data looks malformed")
    reviewed_currency = reviewed_currency.strip().upper()
    import_source = body.get("source", "")
    if not isinstance(import_source, str) or len(import_source) > 32:
        raise ValueError("Import data looks malformed")

    imported_invoices = 0
    duplicates: list[str] = []
    duplicate_ignored: list[JsonObject] = []
    created = 0
    updated = 0
    price_updated_count = 0
    expense_only_count = 0
    line_total = 0
    batch_id = None
    imported_drive_parts: dict[str, set[int]] = {}

    with transaction.atomic():
        # Same workspace lock the spreadsheet import and the undo take, so this
        # batch cannot land price rows in the middle of an undo's
        # validate-then-restore. Taken before the settings lock, in the same
        # order as domains/workspace/currency.py.
        lock_workspace(user)
        # Currency conversion takes this same lock before restating workspace
        # prices. Hold it across the ingredient updates and invoice inserts so
        # a document cannot be parsed in one currency, race a conversion, and
        # then be stamped with another.
        settings = (
            BenchCostSettings.objects.select_for_update().filter(user=user).first()
        )
        workspace_currency = settings.currency_code if settings else "USD"
        # The amounts were reviewed with a currency attached. If a conversion
        # committed while this batch sat open, the figures on screen no longer
        # mean what they say, so refuse rather than restamp them.
        if reviewed_currency != workspace_currency:
            raise ValueError(
                "The workspace currency changed while you were reviewing this "
                "import. Reload and check the amounts before importing."
            )
        ensure_expense_categories(user)
        categories = {
            str(row.id): row for row in ExpenseCategory.objects.filter(user=user)
        }

        parsed: list[JsonObject] = []
        seen_fingerprints = set(
            Invoice.objects.filter(user=user).values_list(
                "source_fingerprint", flat=True
            )
        )
        for entry in invoices:
            supplier = (
                text_value(entry.get("supplier"), "Supplier", max_length=64)
                .strip()
                .lower()
            )
            supplier_display = text_value(
                entry.get("supplierName", supplier), "Supplier name", max_length=120
            ).strip()
            # Before the duplicate check: a re-uploaded file still names a
            # supplier this workspace may have no record of.
            ensure_supplier(user, supplier, supplier_display)
            document_type = entry.get("documentType")
            if document_type not in INVOICE_DOCUMENT_TYPES:
                raise ValueError("Unsupported document type")
            invoice_number = optional_text(
                entry.get("invoiceNumber"), "Invoice number", max_length=64
            )
            invoice_date = import_date_value(entry.get("invoiceDate"), "Invoice date")
            if invoice_date is None:
                raise ValueError("Each invoice needs a date before it can be imported")
            total_cents = signed_cents(entry.get("totalCents"), "Invoice total")
            # Document money keeps the currency the supplier billed in; the
            # workspace code is only the fallback for documents that never
            # printed one.
            document_currency = (
                optional_text(entry.get("currencyCode"), "Currency", max_length=3)
                or workspace_currency
            ).upper()
            if len(document_currency) != 3 or not document_currency.isalpha():
                raise ValueError("Currency looks malformed")
            file_name = text_value(
                entry.get("fileName"), "File name", max_length=255
            ).strip()
            escalated = entry.get("escalated", False)
            if not isinstance(escalated, bool):
                raise ValueError("Extraction data looks malformed")
            fingerprint = invoice_fingerprint(
                supplier,
                invoice_number,
                invoice_date,
                total_cents,
                document_type,
            )
            if fingerprint in seen_fingerprints:
                duplicates.append(file_name)
                # The file was already imported, but the merchant's skip-list
                # decisions on it are new — dropping them here would silently
                # discard choices made in the review step.
                dup_ignored = entry.get("ignored", [])
                if not isinstance(dup_ignored, list) or len(dup_ignored) > 500:
                    raise ValueError("Ignored supplier items look malformed")
                duplicate_ignored.extend(dup_ignored)
                continue
            seen_fingerprints.add(fingerprint)

            lines = entry["lines"]
            has_cost_entries = any(
                isinstance(line, dict) and line.get("costEntry") is not None
                for line in lines
            )
            if has_cost_entries and document_type not in COSTABLE_DOCUMENT_TYPES:
                raise ValueError("Credit memos and refunds cannot update prices")

            parsed.append(
                {
                    "supplier": supplier,
                    "supplier_name": supplier_display,
                    "document_type": document_type,
                    "invoice_number": invoice_number,
                    "invoice_date": invoice_date,
                    # Null when the document printed none of them; an absent
                    # figure is never derived from the ones it did print.
                    "due_date": import_date_value(entry.get("dueDate"), "Due date"),
                    "total_cents": total_cents,
                    "tax_cents": signed_cents(
                        entry.get("taxCents"), "Tax", nullable=True
                    )
                    or 0,
                    "subtotal_cents": signed_cents(
                        entry.get("subtotalCents"), "Subtotal", nullable=True
                    ),
                    "currency_code": document_currency,
                    "file_name": file_name,
                    "drive_file_id": optional_text(
                        entry.get("driveFileId"), "Drive file id", max_length=128
                    ),
                    "drive_file_part": drive_file_part(entry.get("drivePart")),
                    "drive_web_view_link": optional_text(
                        entry.get("driveWebViewLink"), "Drive link", max_length=500
                    ),
                    "document_key": optional_text(
                        entry.get("documentKey"), "Document key", max_length=200
                    ),
                    "extraction_model": optional_text(
                        entry.get("extractionModel"), "Extraction model", max_length=64
                    ),
                    "source": import_source,
                    "fingerprint": fingerprint,
                    "lines": lines,
                    "ignored": entry.get("ignored", []),
                    "extraction": extraction_document(entry.get("extraction")),
                    "escalated": escalated,
                }
            )

        if not parsed:
            # Every file was a duplicate, but skip-list choices made on them
            # are still new decisions — persist and report them.
            if duplicate_ignored:
                upsert_supplier_ignores(user, duplicate_ignored)
            return {
                "batchId": None,
                "invoices": 0,
                "duplicates": duplicates,
                "lines": 0,
                "priceUpdated": 0,
                "created": 0,
                "updated": 0,
                "ignored": len(duplicate_ignored),
                "expenseOnly": 0,
            }

        cost_line_refs: list[tuple[JsonObject, JsonObject]] = []
        all_ignored: list[JsonObject] = []
        for invoice_entry in parsed:
            for line in invoice_entry["lines"]:
                if not isinstance(line, dict):
                    raise ValueError("Invoice lines look malformed")
                if line.get("costEntry") is not None:
                    # Ingredient prices are workspace money; a document billed
                    # in another currency can be recorded but its numbers must
                    # not restate pantry costs.
                    if invoice_entry["currency_code"] != workspace_currency:
                        raise ValueError(
                            f"{invoice_entry['file_name']} is priced in "
                            f"{invoice_entry['currency_code']}, but ingredient "
                            f"costs are tracked in {workspace_currency}. Mark "
                            "its lines as expense categories to import it "
                            "without price updates."
                        )
                    cost_line_refs.append((invoice_entry, line))
            ignored_entries = invoice_entry["ignored"]
            if not isinstance(ignored_entries, list) or len(ignored_entries) > 500:
                raise ValueError("Ignored supplier items look malformed")
            all_ignored.extend(ignored_entries)
        all_ignored.extend(duplicate_ignored)
        # Oldest invoice first, so a multi-file batch replays the price history
        # in the order it happened. apply_price refuses a backdated overwrite on
        # its own; this keeps the recorded before/after snapshots readable too.
        cost_line_refs.sort(key=lambda ref: ref[0]["invoice_date"])

        ingredient_import = None
        if cost_line_refs or all_ignored:
            suppliers = {invoice_entry["supplier"] for invoice_entry in parsed}
            dates = [invoice_entry["invoice_date"] for invoice_entry in parsed]
            if len(parsed) == 1:
                import_file_name = parsed[0]["file_name"]
            else:
                import_file_name = f"Invoices — {len(parsed)} files"
            ingredient_import = IngredientImport.objects.create(
                user=user,
                file_name=import_file_name,
                supplier=suppliers.pop() if len(suppliers) == 1 else None,
                period_start=min(dates),
                period_end=max(dates),
                total_rows=len(cost_line_refs) + len(all_ignored),
                ignored_count=len(all_ignored),
            )
            ignored_snapshots = upsert_supplier_ignores(user, all_ignored)

        applied: dict[int, tuple[SupplierItem | None, Ingredient]] = {}
        for position, (invoice_entry, line) in enumerate(cost_line_refs):
            item_created, supplier_item, ingredient = apply_invoice_cost_line(
                user,
                ingredient_import,
                position,
                line,
                supplier=invoice_entry["supplier"],
                invoice_date=invoice_entry["invoice_date"],
                supply=line_is_supply(line, categories),
            )
            # A one-time line updates a price without adding to the memory,
            # so it counts as a price update and as neither of the other two.
            if item_created is True:
                created += 1
            elif item_created is False:
                updated += 1
            price_updated_count += 1
            applied[id(line)] = (supplier_item, ingredient)

        if ingredient_import is not None:
            ingredient_import.imported_count = len(cost_line_refs)
            ingredient_import.created_count = created
            ingredient_import.updated_count = updated
            ingredient_import.ignored_items = ignored_snapshots
            ingredient_import.save(
                update_fields=[
                    "imported_count",
                    "created_count",
                    "updated_count",
                    "ignored_items",
                    "updated_at",
                ]
            )

        for invoice_entry in parsed:
            invoice, expense_only = persist_invoice(
                user,
                invoice_entry,
                ingredient_import=ingredient_import,
                categories=categories,
                applied=applied,
            )
            if invoice_entry["extraction"] is not None:
                # The read kept beside the invoice it produced: whatever the
                # merchant corrected on the review screen is now the label on
                # it. Nothing reads the pair yet.
                InvoiceExtraction.objects.create(
                    invoice=invoice,
                    document=invoice_entry["extraction"],
                    escalated=invoice_entry["escalated"],
                )
            if invoice_entry["drive_file_id"]:
                imported_drive_parts.setdefault(
                    invoice_entry["drive_file_id"], set()
                ).add(invoice_entry["drive_file_part"])
                # An import is the one transition the poller cannot learn from
                # a Drive change, so it is written here. The status is left
                # alone: a file holding several receipts stays `ready` until
                # the last of them is decided, which the pass below settles.
                DriveFile.objects.update_or_create(
                    user=user,
                    drive_file_id=invoice_entry["drive_file_id"],
                    defaults={"reason": "", "invoice": invoice},
                    create_defaults={
                        "status": DriveFile.Status.IMPORTED,
                        "reason": "",
                        "invoice": invoice,
                        "name": invoice_entry["file_name"],
                        "web_view_link": invoice_entry["drive_web_view_link"],
                        "seen_at": timezone.now(),
                    },
                )
            line_total += invoice.line_count
            expense_only_count += expense_only
            imported_invoices += 1
            # One line per invoice, not one per batch: the invoice page reads
            # its own history by resource id, and "12 invoices" is nobody's.
            record_event(
                user,
                user,
                "invoice",
                "added",
                resource_id=invoice.id,
                name=f"{invoice.supplier_name} · "
                f"{invoice.invoice_number or invoice.public_id}",
                publicId=invoice.public_id,
                fileName=invoice.file_name,
                source=invoice.source or "",
            )

        for row in DriveFile.objects.filter(
            user=user, drive_file_id__in=imported_drive_parts
        ):
            settle_drive_file(
                row,
                imported_drive_parts[row.drive_file_id],
                DriveFileExtraction.Status.IMPORTED,
            )

        if ingredient_import is not None:
            batch_id = str(ingredient_import.id)

    return {
        "batchId": batch_id,
        "invoices": imported_invoices,
        "duplicates": duplicates,
        "lines": line_total,
        "priceUpdated": price_updated_count,
        "created": created,
        "updated": updated,
        "ignored": len(all_ignored),
        "expenseOnly": expense_only_count,
    }


def action_save_invoice(user: User, body: JsonObject) -> JsonObject:
    """Create one hand-entered invoice, or edit any invoice the workspace has.

    Editing replaces the lines and opens a *new* price batch for whatever the
    lines now cost: prices are history, so a corrected line writes the newer
    price and the earlier one stays on the ladder. An imported document keeps
    what only the import knows — where the file came from, which currency it
    was billed in, what kind of document it is — so correcting a typo on it
    never restates those.
    """
    supplier_display = text_value(
        body.get("supplierName"), "Supplier name", max_length=120
    ).strip()
    supplier = supplier_key_from_name(supplier_display)
    if not supplier:
        raise ValueError("Supplier name is required")
    invoice_number = optional_text(
        body.get("invoiceNumber"), "Invoice number", max_length=64
    )
    invoice_date = import_date_value(body.get("invoiceDate"), "Invoice date")
    if invoice_date is None:
        raise ValueError("An invoice needs a date")
    due_date = import_date_value(body.get("dueDate"), "Due date")
    total_cents = signed_cents(body.get("totalCents"), "Invoice total")
    tax_cents = signed_cents(body.get("taxCents"), "Tax", nullable=True) or 0
    if tax_cents < 0:
        raise ValueError("Tax cannot be negative")
    subtotal_cents = signed_cents(body.get("subtotalCents"), "Subtotal", nullable=True)
    notes = optional_text(body.get("notes"), "Notes", max_length=2000)
    payment_method = resolved_payment_method(user, body.get("paymentMethod"))
    expected = (
        int_value(
            body["expectedEditVersion"],
            "Edit version",
            minimum=0,
            maximum=2147483647,
        )
        if "expectedEditVersion" in body
        else None
    )
    lines = body.get("lines")
    if not isinstance(lines, list) or not 1 <= len(lines) <= 500:
        raise ValueError("Invoice lines look malformed")
    for line in lines:
        if not isinstance(line, dict):
            raise ValueError("Invoice lines look malformed")

    with transaction.atomic():
        # Same lock order as the import: workspace first, then the settings row
        # whose currency the price rows are stamped with.
        lock_workspace(user)
        settings = (
            BenchCostSettings.objects.select_for_update().filter(user=user).first()
        )
        workspace_currency = settings.currency_code if settings else "USD"
        ensure_expense_categories(user)
        categories = {
            str(row.id): row for row in ExpenseCategory.objects.filter(user=user)
        }
        ensure_supplier(user, supplier, supplier_display)

        invoice = None
        if body.get("id") is not None:
            invoice = (
                Invoice.objects.select_for_update()
                .filter(user=user, id=uuid_value(body.get("id"), "invoice id"))
                .first()
            )
            if invoice is None:
                raise ValueError("Invoice not found")
            check_and_bump(invoice, expected)

        # What only the import knows, carried off the row rather than restated
        # from the manual defaults: blanking a Drive link or restating a EUR
        # document in the workspace currency is not what fixing a typo means.
        document = {
            "document_type": (
                invoice.document_type
                if invoice is not None
                else Invoice.DocumentType.INVOICE
            ),
            "currency_code": (
                invoice.currency_code if invoice is not None else workspace_currency
            ),
            "source": invoice.source if invoice is not None else "manual",
            "file_name": invoice.file_name if invoice is not None else "",
            "drive_file_id": invoice.drive_file_id if invoice is not None else "",
            "drive_file_part": invoice.drive_file_part if invoice is not None else 0,
            "drive_web_view_link": (
                invoice.drive_web_view_link if invoice is not None else ""
            ),
            "document_key": invoice.document_key if invoice is not None else "",
            "extraction_model": (
                invoice.extraction_model if invoice is not None else ""
            ),
        }
        if total_cents < 0 and document["document_type"] not in CREDIT_DOCUMENT_TYPES:
            raise ValueError(
                "Enter a positive total; credits come from your supplier documents."
            )

        fingerprint = invoice_fingerprint(
            supplier,
            invoice_number,
            invoice_date,
            total_cents,
            document["document_type"],
        )
        clash = Invoice.objects.filter(user=user, source_fingerprint=fingerprint)
        if invoice is not None:
            clash = clash.exclude(id=invoice.id)
        if clash.exists():
            raise ValueError("You already have that invoice")

        cost_lines = [line for line in lines if line.get("costEntry") is not None]
        if cost_lines:
            # The same two rules the import applies, now that an imported
            # document can be edited here: credits never move a price, and a
            # document billed in another currency never restates pantry money.
            if document["document_type"] not in COSTABLE_DOCUMENT_TYPES:
                raise ValueError("Credit memos and refunds cannot update prices")
            if document["currency_code"] != workspace_currency:
                raise ValueError(
                    f"This document is priced in {document['currency_code']}, but "
                    f"ingredient costs are tracked in {workspace_currency}. File "
                    "its lines under expense categories instead."
                )
        ingredient_import = None
        applied: dict[int, tuple[SupplierItem | None, Ingredient]] = {}
        if cost_lines:
            ingredient_import = IngredientImport.objects.create(
                user=user,
                file_name=f"{supplier_display} {invoice_number}".strip(),
                supplier=supplier,
                period_start=invoice_date,
                period_end=invoice_date,
                total_rows=len(cost_lines),
            )
            created = 0
            updated = 0
            for position, line in enumerate(cost_lines):
                item_created, supplier_item, ingredient = apply_invoice_cost_line(
                    user,
                    ingredient_import,
                    position,
                    line,
                    supplier=supplier,
                    invoice_date=invoice_date,
                    supply=line_is_supply(line, categories),
                )
                created += 1 if item_created is True else 0
                updated += 1 if item_created is False else 0
                applied[id(line)] = (supplier_item, ingredient)
            ingredient_import.imported_count = len(cost_lines)
            ingredient_import.created_count = created
            ingredient_import.updated_count = updated
            ingredient_import.save(
                update_fields=[
                    "imported_count",
                    "created_count",
                    "updated_count",
                    "updated_at",
                ]
            )

        editing = invoice is not None
        invoice, _ = persist_invoice(
            user,
            {
                "supplier": supplier,
                "supplier_name": supplier_display,
                "invoice_number": invoice_number,
                "invoice_date": invoice_date,
                "due_date": due_date,
                "total_cents": total_cents,
                "tax_cents": tax_cents,
                "subtotal_cents": subtotal_cents,
                "notes": notes,
                "payment_method": payment_method,
                "fingerprint": fingerprint,
                "lines": lines,
                **document,
            },
            ingredient_import=ingredient_import,
            categories=categories,
            applied=applied,
            invoice=invoice,
        )

    record_event(
        user,
        user,
        "invoice",
        "edited" if editing else "added",
        resource_id=invoice.id,
        name=f"{supplier_display} {invoice_number or invoice_date.isoformat()}",
        publicId=invoice.public_id,
    )
    return {"item": invoice_detail_json(invoice)}


def _review_batch(user: User, invoice: Invoice) -> IngredientImport:
    """The price batch this invoice's reviewed lines join, so the ingredients
    Import history can undo them. An undone batch is never reopened."""
    batch = invoice.ingredient_import
    if batch is not None and batch.undone_at is None:
        return batch
    batch = IngredientImport.objects.create(
        user=user,
        file_name=(
            f"{invoice.supplier_name} {invoice.invoice_number}".strip()
            or invoice.file_name
        ),
        supplier=invoice.supplier,
        period_start=invoice.invoice_date,
        period_end=invoice.invoice_date,
    )
    invoice.ingredient_import = batch
    invoice.save(update_fields=["ingredient_import", "updated_at"])
    return batch


def action_review_invoice_line(user: User, body: JsonObject) -> JsonObject:
    """Resolve one invoice line after the document landed.

    Sets the line's expense category, and with a `costEntry` runs the same
    supplier-item pipeline an import runs, priced as of the invoice's own date.
    Works on any invoice, imported or hand-typed: reviewing a line is not
    editing the document.
    """
    line_id = uuid_value(body.get("lineId"), "invoice line id")
    cost_entry = body.get("costEntry")
    if cost_entry is not None and not isinstance(cost_entry, dict):
        raise ValueError("Cost entry looks malformed")

    with transaction.atomic():
        # Same lock order as the import: workspace, then the settings row whose
        # currency the price rows are stamped with.
        lock_workspace(user)
        settings = (
            BenchCostSettings.objects.select_for_update().filter(user=user).first()
        )
        workspace_currency = settings.currency_code if settings else "USD"
        line = (
            InvoiceLine.objects.filter(user=user, id=line_id)
            .select_related("invoice")
            .first()
        )
        if line is None:
            raise ValueError("Invoice line not found")
        invoice = line.invoice

        category_id = body.get("categoryId")
        if category_id is None:
            line.category = None
        else:
            category = ExpenseCategory.objects.filter(
                user=user, id=uuid_value(category_id, "expense category id")
            ).first()
            if category is None:
                raise ValueError("Expense category was not found")
            line.category = category
        updated_fields = ["category", "needs_review", "updated_at"]

        if cost_entry is not None:
            if invoice.document_type not in COSTABLE_DOCUMENT_TYPES:
                raise ValueError("Credit memos and refunds cannot update prices")
            if invoice.invoice_date is None:
                raise ValueError(
                    "That invoice needs a date before a line can be priced"
                )
            # Ingredient prices are workspace money; a document billed in
            # another currency is recorded but never restates pantry costs.
            if invoice.currency_code != workspace_currency:
                raise ValueError(
                    f"That invoice is priced in {invoice.currency_code}, but "
                    f"ingredient costs are tracked in {workspace_currency}. "
                    "Give the line an expense category instead."
                )
            batch = _review_batch(user, invoice)
            position = (batch.items.aggregate(last=Max("position"))["last"] or -1) + 1
            created, supplier_item, ingredient = apply_invoice_cost_line(
                user,
                batch,
                position,
                {
                    "sku": line.sku,
                    "description": line.description,
                    "costEntry": cost_entry,
                },
                supplier=invoice.supplier,
                invoice_date=invoice.invoice_date,
                supply=line.category is not None and line.category.is_supply,
            )
            batch.total_rows += 1
            batch.imported_count += 1
            batch.created_count += 1 if created is True else 0
            batch.updated_count += 1 if created is False else 0
            batch.save(
                update_fields=[
                    "total_rows",
                    "imported_count",
                    "created_count",
                    "updated_count",
                    "updated_at",
                ]
            )
            line.supplier_item = supplier_item
            line.ingredient = ingredient
            line.price_updated = True
            updated_fields += ["supplier_item", "ingredient", "price_updated"]

        # A line the merchant has filed under a category or attached to an
        # ingredient is no longer waiting on them.
        if line.category_id is not None or line.ingredient_id is not None:
            line.needs_review = False
        line.save(update_fields=updated_fields)
        if cost_entry is not None and line.ingredient is not None:
            remember_invoice_price(
                line, line.ingredient, line.supplier_item, cost_entry
            )

        invoice.matched_line_count = invoice.lines.filter(price_updated=True).count()
        invoice.unresolved_line_count = invoice.lines.filter(needs_review=True).count()
        invoice.save(
            update_fields=[
                "matched_line_count",
                "unresolved_line_count",
                "updated_at",
            ]
        )

    record_event(
        user,
        user,
        "invoice",
        "edited",
        resource_id=invoice.id,
        name=f"{invoice.supplier_name} {invoice.invoice_number}".strip(),
        reviewedLine=line.description,
    )
    return {"item": invoice_detail_json(invoice)}


def action_delete_invoice(user: User, body: JsonObject) -> JsonObject:
    row = Invoice.objects.filter(user=user, id=uuid_value(body.get("id"))).first()
    document_key = row.document_key if row is not None else ""
    if row is not None:
        # Deleting an invoice never reverts prices — that lives in the
        # ingredients Import history. It does free the fingerprint so a
        # corrected re-import works.
        row.delete()
        record_event(
            user,
            user,
            "invoice",
            "deleted",
            resource_id=row.id,
            name=f"{row.supplier_name} {row.invoice_number}".strip(),
        )
    # The stored file is Next's to delete; Django only says which one.
    return {"ok": True, "documentKey": document_key or None}


def resolved_payment_method(user: User, value: Any) -> str:
    """What an invoice may store: nothing, a built-in, or one of this
    workspace's own methods. The column is free text, so the check lives here
    rather than in a constraint that cannot see the tenant's rows."""
    name = optional_text(value, "Payment method", max_length=64)
    if name in INVOICE_PAYMENT_METHODS:
        return name
    row = PaymentMethod.objects.filter(
        user=user, normalized_name=normalized_name(name)
    ).first()
    if row is None:
        raise ValueError("Unsupported payment method")
    # Store the method's own spelling, not whatever casing was sent.
    return row.name


def action_save_payment_method(user: User, body: JsonObject) -> JsonObject:
    name = text_value(body.get("name"), "Payment method name", max_length=64).strip()
    normalized = normalized_name(name)
    if not normalized:
        raise ValueError("Payment method name is required")
    if normalized in INVOICE_PAYMENT_METHODS:
        raise ValueError("That payment method is built in")
    method_id = body.get("id")
    # The unique constraint is the check, so the write gets its own savepoint
    # and a duplicate rolls back to it instead of poisoning the transaction.
    try:
        with transaction.atomic():
            if method_id:
                row = PaymentMethod.objects.filter(
                    user=user, id=uuid_value(method_id, "payment method id")
                ).first()
                if row is None:
                    raise ValueError("Payment method not found")
                row.name = name
                row.normalized_name = normalized
                row.save(update_fields=["name", "normalized_name", "updated_at"])
            else:
                row = PaymentMethod.objects.create(
                    user=user, name=name, normalized_name=normalized
                )
    except IntegrityError:
        raise ValueError("You already have a payment method with that name") from None
    return {"id": str(row.id)}


def action_delete_payment_method(user: User, body: JsonObject) -> JsonObject:
    # Invoices keep the text they were saved with; only the choice goes away.
    PaymentMethod.objects.filter(
        user=user, id=uuid_value(body.get("id"), "payment method id")
    ).delete()
    return {"ok": True}


def action_save_expense_category(user: User, body: JsonObject) -> JsonObject:
    ensure_expense_categories(user)
    name = text_value(body.get("name"), "Category name", max_length=64).strip()
    normalized = normalized_name(name)
    if not normalized:
        raise ValueError("Category name is required")
    # Absent means "leave it as it is": a plain rename must not un-supply a
    # category, and a new one is food unless it says otherwise.
    requested_supply = body.get("isSupply")
    if requested_supply is not None:
        requested_supply = bool_value(requested_supply, "Supply category")
    category_id = body.get("id")
    try:
        if category_id:
            row = ExpenseCategory.objects.filter(
                user=user, id=uuid_value(category_id, "category id")
            ).first()
            if row is None:
                raise ValueError("Category not found")
            # Supplies are costed like food, so marking one costs it. Clearing
            # the mark takes that costability back, because a category costable
            # only for being a supply has no other reason to price anything.
            if requested_supply is True:
                row.is_ingredient = True
                row.is_supply = True
            elif requested_supply is False and row.is_supply:
                row.is_ingredient = False
                row.is_supply = False
            row.name = name
            row.normalized_name = normalized
            row.save(
                update_fields=[
                    "name",
                    "normalized_name",
                    "is_ingredient",
                    "is_supply",
                    "updated_at",
                ]
            )
        else:
            position = (
                ExpenseCategory.objects.filter(user=user).aggregate(
                    top=Max("position")
                )["top"]
                or 0
            ) + 1
            row = ExpenseCategory.objects.create(
                user=user,
                name=name,
                normalized_name=normalized,
                is_ingredient=bool(requested_supply),
                is_supply=bool(requested_supply),
                position=position,
            )
    except IntegrityError:
        raise ValueError("You already have a category with that name") from None
    return {"id": str(row.id)}


SUPPLIER_DETAIL_FIELDS = (
    "email",
    "phone",
    "account_number",
    "notes",
    "default_category",
)


def _supplier_row(user: User, supplier_id: Any) -> Supplier:
    row = Supplier.objects.filter(
        user=user, id=uuid_value(supplier_id, "supplier id")
    ).first()
    if row is None:
        raise ValueError("Supplier not found")
    return row


def _supplier_counts(user: User, key: str) -> dict[str, int]:
    return {
        "invoices": Invoice.objects.filter(user=user, supplier=key).count(),
        "items": SupplierItem.objects.filter(user=user, supplier=key).count(),
        "ignores": SupplierItemIgnore.objects.filter(user=user, supplier=key).count(),
    }


def _move_supplier_rows(
    user: User, source_key: str, target_key: str, target_name: str
) -> dict[str, int]:
    """Re-point every row stored under one supplier key at another.

    Supplier items and skip-list rows are unique per (user, supplier,
    external_id), so a SKU both suppliers carry keeps the target's row and
    drops the source's.
    """
    moved = {
        "invoices": Invoice.objects.filter(user=user, supplier=source_key).update(
            supplier=target_key, supplier_name=target_name
        ),
        "items": 0,
        "ignores": 0,
    }
    for field, model in (("items", SupplierItem), ("ignores", SupplierItemIgnore)):
        taken = set(
            model.objects.filter(user=user, supplier=target_key).values_list(
                "external_id", flat=True
            )
        )
        for row in model.objects.filter(user=user, supplier=source_key):
            if row.external_id in taken:
                row.delete()
                continue
            row.supplier = target_key
            row.save(update_fields=["supplier", "updated_at"])
            moved[field] += 1
    return moved


def action_save_supplier(user: User, body: JsonObject) -> JsonObject:
    """Create a supplier, or edit one, including the rename that moves its
    rows onto a new key."""
    name = text_value(body.get("name"), "Supplier name", max_length=120).strip()
    key = supplier_key_from_name(name)
    if not key:
        raise ValueError("Supplier name is required")
    default_category = None
    if body.get("defaultCategoryId") is not None:
        default_category = ExpenseCategory.objects.filter(
            user=user, id=uuid_value(body.get("defaultCategoryId"), "category id")
        ).first()
        if default_category is None:
            raise ValueError("Expense category was not found")
    details = {
        "email": optional_text(body.get("email"), "Email", max_length=200),
        "phone": optional_text(body.get("phone"), "Phone", max_length=64),
        "account_number": optional_text(
            body.get("accountNumber"), "Account number", max_length=64
        ),
        "notes": optional_text(body.get("notes"), "Notes", max_length=2000),
        # What this supplier's lines fall back to when no line of its own
        # remembers a category.
        "default_category": default_category,
    }
    supplier_id = body.get("id")
    with transaction.atomic():
        if not supplier_id:
            if Supplier.objects.filter(user=user, key=key).exists():
                raise ValueError("That supplier already exists")
            row = Supplier.objects.create(user=user, key=key, name=name, **details)
            return {"id": str(row.id)}
        row = _supplier_row(user, supplier_id)
        if key != row.key:
            if Supplier.objects.filter(user=user, key=key).exists():
                raise ValueError(
                    "That name belongs to another supplier. Merge them instead."
                )
            _move_supplier_rows(user, row.key, key, name)
            row.key = key
        row.name = name
        for field, value in details.items():
            setattr(row, field, value)
        row.save(update_fields=["key", "name", *SUPPLIER_DETAIL_FIELDS, "updated_at"])
    return {"id": str(row.id)}


def action_merge_suppliers(user: User, body: JsonObject) -> JsonObject:
    """Fold one supplier into another: its rows move, its blanks fill the
    target's, and it is gone."""
    source = _supplier_row(user, body.get("sourceId"))
    target = _supplier_row(user, body.get("targetId"))
    if source.id == target.id:
        raise ValueError("Pick a different supplier to merge into")
    with transaction.atomic():
        moved = _move_supplier_rows(user, source.key, target.key, target.name)
        filled = [
            field
            for field in SUPPLIER_DETAIL_FIELDS
            if not getattr(target, field) and getattr(source, field)
        ]
        if filled:
            for field in filled:
                setattr(target, field, getattr(source, field))
            target.save(update_fields=[*filled, "updated_at"])
        source.delete()
    return {"ok": True, "moved": moved}


def action_delete_supplier(user: User, body: JsonObject) -> JsonObject:
    row = _supplier_row(user, body.get("id"))
    if any(_supplier_counts(user, row.key).values()):
        raise ValueError("That supplier still has invoices or items.")
    row.delete()
    return {"ok": True}


def action_delete_expense_category(user: User, body: JsonObject) -> JsonObject:
    row = ExpenseCategory.objects.filter(
        user=user, id=uuid_value(body.get("id"), "category id")
    ).first()
    if row is None:
        return {"ok": True}
    # The food Ingredients row anchors the costing pipeline. A supply category
    # is costable too but is the workspace's to keep or drop.
    if row.is_ingredient and not row.is_supply:
        raise ValueError("The Ingredients category can't be deleted")
    row.delete()
    return {"ok": True}


# Slugs this module answers for, composed into the one action route by
# forkluck/http/dispatch.py.
def _clear_item_sync(user: User, item: SupplierItem) -> None:
    """Drop one supplier pack and the invoice lines that point at it. The
    ingredient's other packs stay. Price history survives too: its supplier
    item is SET_NULL."""
    InvoiceLine.objects.filter(user=user, supplier_item=item).update(
        ingredient=None, supplier_item=None
    )
    item.delete()


def _pack_price_cents(line: InvoiceLine) -> int:
    return invoice_line_pack_price_cents(line)


def remember_invoice_price(
    line: InvoiceLine,
    ingredient: Ingredient,
    supplier_item: SupplierItem | None = None,
    cost_entry: JsonObject | None = None,
) -> IngredientInvoicePrice | None:
    """Put one purchase on an ingredient's invoice-price shelf.

    The shelf is reference history, not the ingredient's active costing
    source. Invoice review can therefore remember an emergency purchase
    without replacing the kitchen's normal pack.
    """
    cost = _pack_price_cents(line)
    if cost < 0:
        return None
    item = supplier_item or line.supplier_item
    size = (
        item.pack_amount
        if item is not None
        else Decimal(str(cost_entry["packAmount"]))
        if cost_entry is not None
        else None
    )
    unit = (
        item.pack_unit
        if item is not None
        else str(cost_entry["packUnit"])
        if cost_entry is not None
        else ""
    )
    row, _ = IngredientInvoicePrice.objects.update_or_create(
        user=line.user,
        ingredient=ingredient,
        invoice_line=line,
        defaults={
            "purchase_size": size,
            "purchase_unit": unit,
            "ingredient_import": line.invoice.ingredient_import,
        },
    )
    return row


def action_disconnect_invoice_line(user: User, body: JsonObject) -> JsonObject:
    """Remove one invoice price from one ingredient only."""
    ingredient = Ingredient.objects.filter(
        user=user, id=uuid_value(body.get("ingredientId"), "ingredient id")
    ).first()
    if ingredient is None:
        return {"error": "Ingredient not found"}
    with transaction.atomic():
        row = Ingredient.objects.select_for_update().get(pk=ingredient.pk)
        price = IngredientInvoicePrice.objects.filter(
            user=user,
            ingredient=row,
            id=uuid_value(body.get("invoicePriceId"), "invoice price id"),
        ).first()
        if price is None:
            return {"error": "Invoice price not found"}
        price.delete()
        version = check_and_bump(row, None)
    return {"ok": True, "editVersion": version}


def action_link_invoice_line(user: User, body: JsonObject) -> JsonObject:
    """Add an invoice purchase to an ingredient without changing its cost."""
    ingredient = Ingredient.objects.filter(
        user=user, id=uuid_value(body.get("ingredientId"), "ingredient id")
    ).first()
    if ingredient is None:
        return {"error": "Ingredient not found"}
    line = (
        InvoiceLine.objects.filter(
            user=user, id=uuid_value(body.get("lineId"), "invoice line id")
        )
        .select_related("invoice")
        .first()
    )
    if line is None:
        return {"error": "Invoice line not found"}

    # A SupplierItem describes a concrete pack, so a missing size or unit is
    # named here rather than left to the NOT NULL column, which surfaces as
    # "that change conflicts".
    purchase_size = number_value(
        body.get("purchaseSize"),
        "Purchase size",
        minimum=0,
        maximum=1000000,
        nullable=True,
    )
    purchase_unit = optional_text(
        body.get("purchaseUnit"), "Purchase unit", max_length=64
    )
    if not purchase_size or not purchase_unit:
        return {
            "error": "Set a purchase size and unit before connecting an invoice item."
        }
    purchase_cost_cents = _pack_price_cents(line)
    if purchase_cost_cents < 0:
        return {"error": "Credit lines cannot be used as ingredient prices."}

    with transaction.atomic():
        ingredient = Ingredient.objects.select_for_update().get(pk=ingredient.pk)
        IngredientInvoicePrice.objects.update_or_create(
            user=user,
            ingredient=ingredient,
            invoice_line=line,
            defaults={
                "purchase_size": Decimal(str(purchase_size)),
                "purchase_unit": purchase_unit,
                "ingredient_import": None,
            },
        )
        version = check_and_bump(ingredient, None)
    return {"ok": True, "editVersion": version}


def action_use_invoice_price(user: User, body: JsonObject) -> JsonObject:
    """Explicitly copy one connected invoice price into ingredient costing."""
    ingredient = Ingredient.objects.filter(
        user=user, id=uuid_value(body.get("ingredientId"), "ingredient id")
    ).first()
    if ingredient is None:
        return {"error": "Ingredient not found"}
    price = (
        IngredientInvoicePrice.objects.filter(
            user=user,
            ingredient=ingredient,
            id=uuid_value(body.get("invoicePriceId"), "invoice price id"),
        )
        .select_related("invoice_line")
        .first()
    )
    if price is None:
        return {"error": "Invoice price not found"}
    if price.purchase_size is None or not price.purchase_unit:
        return {"error": "Set a pack size and unit before using this price."}
    settings = BenchCostSettings.objects.filter(user=user).first()
    workspace_currency = settings.currency_code if settings else "USD"
    if price.invoice_line.currency_code != workspace_currency:
        return {
            "error": (
                f"That invoice is priced in {price.invoice_line.currency_code}, but "
                f"ingredient costs are tracked in {workspace_currency}."
            )
        }
    with transaction.atomic():
        ingredient = Ingredient.objects.select_for_update().get(pk=ingredient.pk)
        apply_price(
            ingredient,
            {
                "purchase_cost_cents": invoice_line_pack_price_cents(
                    price.invoice_line
                ),
                "purchase_size": price.purchase_size,
                "purchase_unit": price.purchase_unit,
            },
            source=IngredientPrice.Source.USER,
        )
        version = check_and_bump(ingredient, None)
    return {"ok": True, "editVersion": version}


def _supplier_item_row(user: User, item_id: Any) -> SupplierItem:
    row = SupplierItem.objects.filter(
        user=user, id=uuid_value(item_id, "supplier item id")
    ).first()
    if row is None:
        raise ValueError("Supplier item not found")
    return row


def action_relink_supplier_item(user: User, body: JsonObject) -> JsonObject:
    """Point one remembered supplier product at a different ingredient.

    A plain edit, not an import: no price is written, so this joins no undo
    batch. The invoice lines bought under the pack follow it, and the
    preferred flag moves only where it is free to.
    """
    ingredient_id = uuid_value(body.get("ingredientId"), "ingredient id")
    with transaction.atomic():
        lock_workspace(user)
        item = _supplier_item_row(user, body.get("itemId"))
        ingredient = Ingredient.objects.filter(user=user, id=ingredient_id).first()
        if ingredient is None:
            raise ValueError("Ingredient match was not found")
        if item.ingredient_id == ingredient.id:
            return {"ok": True}
        previous = item.ingredient
        was_preferred = item.is_preferred
        item.ingredient = ingredient
        # One preferred pack per ingredient, so the arriving pack keeps the
        # flag only when its new ingredient has none.
        item.is_preferred = not SupplierItem.objects.filter(
            user=user, ingredient=ingredient, is_preferred=True
        ).exists()
        item.save(update_fields=["ingredient", "is_preferred", "updated_at"])
        InvoiceLine.objects.filter(user=user, supplier_item=item).update(
            ingredient=ingredient
        )
        if was_preferred:
            promote_next_preferred(user, previous)
    return {"ok": True}


def action_ignore_supplier_item(user: User, body: JsonObject) -> JsonObject:
    """Forget one supplier product and stop being asked about it again.

    The pack goes the way disconnecting an invoice line drops one, and the
    skip list remembers the key, so the next invoice that prints it is filed
    as an expense without a prompt.
    """
    with transaction.atomic():
        lock_workspace(user)
        item = _supplier_item_row(user, body.get("itemId"))
        supplier, external_id = item.supplier, item.external_id
        title, raw_size = item.title, item.raw_size
        _clear_item_sync(user, item)
        SupplierItemIgnore.objects.update_or_create(
            user=user,
            supplier=supplier,
            external_id=external_id,
            defaults={"title": title, "raw_size": raw_size},
        )
    return {"ok": True}


def action_unignore_supplier_item(user: User, body: JsonObject) -> JsonObject:
    """Take one supplier product off the skip list. It has no pack again, so
    the next invoice that prints it asks."""
    SupplierItemIgnore.objects.filter(
        user=user,
        supplier=text_value(body.get("supplier"), "Supplier", max_length=64).lower(),
        external_id=text_value(
            body.get("externalId"), "Supplier item ID", max_length=120
        ),
    ).delete()
    return {"ok": True}


def action_delete_supplier_item(user: User, body: JsonObject) -> JsonObject:
    """Drop one remembered supplier product without skipping it: the next
    invoice that prints it is matched from scratch."""
    with transaction.atomic():
        lock_workspace(user)
        _clear_item_sync(user, _supplier_item_row(user, body.get("itemId")))
    return {"ok": True}


def action_connect_drive_folder(user: User, body: JsonObject) -> JsonObject:
    """Point the workspace at one Drive folder. Only the id and the name it
    displays under are stored; the documents stay in Drive."""
    folder_id = text_value(body.get("folderId"), "Folder id", max_length=128)
    folder_name = optional_text(body.get("folderName"), "Folder name", max_length=255)
    source, _ = DriveFolderSource.objects.update_or_create(
        user=user,
        # Reconnecting re-seeds: the poller owes this folder a full listing
        # again, because a Changes page only mentions what moved since.
        defaults={
            "folder_id": folder_id,
            "folder_name": folder_name,
            "registered_at": None,
        },
    )
    return {"folder": drive_folder_json(source)}


def action_disconnect_drive_folder(user: User, body: JsonObject) -> JsonObject:
    DriveFolderSource.objects.filter(user=user).delete()
    return {"ok": True}


# What the Next process decided about a file it listed: "ok" is importable,
# the rest are the verdicts that rule one out and become the row's reason.
DRIVE_SUPPORT_VERDICTS = ("ok", "heic", "unsupported", "too_large")

# The statuses a registration may still re-decide. Imported, skipped and
# failed are the workspace's own verdicts and a Drive change never undoes one.
DRIVE_UNDECIDED_STATUSES = (DriveFile.Status.NEW, DriveFile.Status.UNSUPPORTED)

# The two verdicts that are about the bytes rather than about the merchant's
# intent: an edited document has not been read, and has not failed to be read.
DRIVE_REREADABLE_STATUSES = (DriveFile.Status.READY, DriveFile.Status.FAILED)

DRIVE_FILE_FIELDS = (
    "name",
    "mime_type",
    "size_bytes",
    "modified_time",
    "web_view_link",
    "folder_path",
    "status",
    "reason",
    "seen_at",
)


def drive_timestamp(value: Any) -> datetime | None:
    """Drive prints RFC 3339 with a trailing `Z`, which fromisoformat wants
    spelled as an offset."""
    if value is None:
        return None
    raw = text_value(value, "Modified time", max_length=40)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("Modified time is invalid") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime_timezone.utc)
    return parsed


def drive_registration(entry: Any) -> JsonObject:
    if not isinstance(entry, dict):
        raise ValueError("Drive files look malformed")
    support = text_value(entry.get("support"), "Support verdict", max_length=16)
    if support not in DRIVE_SUPPORT_VERDICTS:
        raise ValueError("Support verdict is not recognized")
    size = entry.get("sizeBytes")
    return {
        "drive_file_id": text_value(
            entry.get("driveFileId"), "Drive file id", max_length=128
        ),
        "name": optional_text(entry.get("name"), "File name", max_length=255),
        "mime_type": optional_text(entry.get("mimeType"), "File type", max_length=128),
        "size_bytes": (
            None
            if size is None
            else int_value(size, "File size", minimum=0, maximum=2**53)
        ),
        "modified_time": drive_timestamp(entry.get("modifiedTime")),
        "web_view_link": optional_text(
            entry.get("webViewLink"), "Drive link", max_length=500
        ),
        "folder_path": optional_text(
            entry.get("folderPath"), "Folder path", max_length=255
        ),
        "support": support,
        "removed": bool_value(entry.get("removed"), "Removed"),
    }


def _has_newer_bytes(row: DriveFile, modified_time: datetime | None) -> bool:
    """Whether Drive reports this file as edited since the row was written.

    A file Drive gives no modified time for, on either side, cannot be shown
    to have changed, so its verdict stands.
    """
    return (
        modified_time is not None
        and row.modified_time is not None
        and modified_time > row.modified_time
    )


@transaction.atomic
def register_drive_files(user: User, body: JsonObject) -> JsonObject:
    """Record what the poller saw in one workspace's folder.

    Metadata refreshes on every row, but the status is the workspace's: a file
    it imported, skipped, read or failed to read keeps that verdict, and only a
    file nobody has decided on is re-read as new or unsupported. The exception
    is an edited document: a `ready` or `failed` row whose Drive modified time
    has moved goes back to `new` and loses what was read from the old bytes.
    """
    files = body.get("files")
    if not isinstance(files, list) or len(files) > 500:
        raise ValueError("Drive files look malformed")
    # One page can mention the same file twice; the last word wins.
    wanted = {
        entry["drive_file_id"]: entry
        for entry in (drive_registration(entry) for entry in files)
    }
    existing = {
        row.drive_file_id: row
        # The poller and an import-invoices running in the browser can name the
        # same file at the same moment; without the lock the two racing
        # create-or-update passes collide on the unique constraint. A no-op on
        # SQLite, a row lock on PostgreSQL.
        for row in DriveFile.objects.select_for_update()
        .filter(user=user, drive_file_id__in=wanted)
        .order_by("drive_file_id")
    }
    now = timezone.now()
    created: list[DriveFile] = []
    updated: list[DriveFile] = []
    gone: list[str] = []
    reread: list[DriveFile] = []
    for drive_file_id, entry in wanted.items():
        row = existing.get(drive_file_id)
        if entry["removed"]:
            # A file deleted from Drive after it was imported keeps its row:
            # the invoice it produced still points back at it.
            if row is not None and row.status != DriveFile.Status.IMPORTED:
                gone.append(drive_file_id)
            continue
        if row is None:
            row = DriveFile(user=user, drive_file_id=drive_file_id)
            created.append(row)
        else:
            updated.append(row)
            if row.status in DRIVE_REREADABLE_STATUSES and _has_newer_bytes(
                row, entry["modified_time"]
            ):
                # The document changed under a verdict that was about its
                # bytes: what the watcher read no longer describes the file,
                # so the row goes back in line and the reading is dropped.
                row.status = DriveFile.Status.NEW
                row.reason = ""
                reread.append(row)
        row.name = entry["name"]
        row.mime_type = entry["mime_type"]
        row.size_bytes = entry["size_bytes"]
        row.modified_time = entry["modified_time"]
        row.web_view_link = entry["web_view_link"]
        row.folder_path = entry["folder_path"]
        row.seen_at = now
        if row.status in DRIVE_UNDECIDED_STATUSES:
            supported = entry["support"] == "ok"
            row.status = (
                DriveFile.Status.NEW if supported else DriveFile.Status.UNSUPPORTED
            )
            row.reason = "" if supported else entry["support"]
    if created:
        DriveFile.objects.bulk_create(created)
    if updated:
        DriveFile.objects.bulk_update(updated, DRIVE_FILE_FIELDS)
    if reread:
        DriveFileExtraction.objects.filter(drive_file__in=reread).delete()
    removed = 0
    if gone:
        # The per-model count, not the total: deleting a row that had been
        # read cascades to what was read of it, and `removed` is about files.
        _, per_model = DriveFile.objects.filter(
            user=user, drive_file_id__in=gone
        ).delete()
        removed = per_model.get(DriveFile._meta.label, 0)
    return {
        "registered": len(created) + len(updated),
        "removed": removed,
        "newCount": DriveFile.objects.filter(
            user=user, status=DriveFile.Status.NEW
        ).count(),
    }


def save_drive_watch_state(body: JsonObject) -> JsonObject:
    """Advance the one Changes cursor the whole installation shares."""
    state = DriveWatchState.load()
    state.page_token = optional_text(
        body.get("pageToken"), "Page token", max_length=256
    )
    state.polled_at = drive_timestamp(body.get("polledAt"))
    state.last_error = optional_text(
        body.get("lastError"), "Last error", max_length=2000
    )
    state.save(update_fields=["page_token", "polled_at", "last_error", "updated_at"])
    return {"ok": True}


def action_skip_drive_files(user: User, body: JsonObject) -> JsonObject:
    """Stop offering these files for import. Re-skipping a file already on the
    list is a no-op, so the browser can send a whole selection blindly.

    An entry with a `part` skips that one document of a file holding several,
    which leaves the rest of the file on offer; an entry without one skips the
    file itself, whatever it holds."""
    files = body.get("files")
    if not isinstance(files, list) or len(files) > 200:
        raise ValueError("Drive files look malformed")
    wanted: dict[str, JsonObject] = {}
    for entry in files:
        if not isinstance(entry, dict):
            raise ValueError("Drive files look malformed")
        drive_file_id = text_value(
            entry.get("driveFileId"), "Drive file id", max_length=128
        )
        slot = wanted.setdefault(drive_file_id, {"parts": set()})
        slot["name"] = optional_text(entry.get("fileName"), "File name", max_length=255)
        slot["reason"] = optional_text(entry.get("reason"), "Reason", max_length=255)
        if entry.get("part") is None:
            # The whole file wins over any part of it named in the same call.
            slot["parts"] = None
        elif slot["parts"] is not None:
            slot["parts"].add(drive_file_part(entry.get("part")))
    existing = {
        row.drive_file_id: row
        for row in DriveFile.objects.filter(user=user, drive_file_id__in=wanted)
    }
    now = timezone.now()
    created: list[DriveFile] = []
    updated: list[DriveFile] = []
    dropped: list[DriveFile] = []
    for drive_file_id, entry in wanted.items():
        row = existing.get(drive_file_id)
        if row is None:
            if entry["parts"] is not None:
                # A part of a file nothing has read is not a thing to skip.
                continue
            # The merchant can skip a file the poller has not registered yet.
            created.append(
                DriveFile(
                    user=user,
                    drive_file_id=drive_file_id,
                    name=entry["name"],
                    status=DriveFile.Status.SKIPPED,
                    reason=entry["reason"],
                    seen_at=now,
                )
            )
            continue
        if row.status == DriveFile.Status.IMPORTED:
            continue
        if entry["parts"] is not None:
            if not DriveFileExtraction.objects.filter(drive_file=row).exists():
                # A re-read drops the parts and puts the file back to `new`,
                # so a screen still holding the old blocks would skip the
                # whole file where it meant to skip one receipt of it.
                continue
            row.reason = entry["reason"]
            settle_drive_file(row, entry["parts"], DriveFileExtraction.Status.SKIPPED)
            continue
        # Nobody will confirm a skipped file, so what was read of it is dead
        # weight. The row itself stays, so no cascade does this.
        if row.status == DriveFile.Status.READY:
            dropped.append(row)
        row.status = DriveFile.Status.SKIPPED
        row.reason = entry["reason"]
        updated.append(row)
    if created:
        DriveFile.objects.bulk_create(created)
    if updated:
        DriveFile.objects.bulk_update(updated, ["status", "reason"])
    if dropped:
        DriveFileExtraction.objects.filter(drive_file__in=dropped).delete()
    return {"ok": True}


def action_unskip_drive_file(user: User, body: JsonObject) -> JsonObject:
    """Offer the file again. It goes back to new; the next registration
    re-reads its support verdict."""
    drive_file_id = text_value(body.get("driveFileId"), "Drive file id", max_length=128)
    DriveFile.objects.filter(user=user, drive_file_id=drive_file_id).exclude(
        status=DriveFile.Status.IMPORTED
    ).update(status=DriveFile.Status.NEW, reason="")
    return {"ok": True}


def action_retry_drive_file(user: User, body: JsonObject) -> JsonObject:
    """Put a file the watcher could not read back in the queue. Only a failed
    row moves: a read that succeeded is waiting on the merchant, not on the
    watcher."""
    drive_file_id = text_value(body.get("driveFileId"), "Drive file id", max_length=128)
    DriveFile.objects.filter(
        user=user,
        drive_file_id=drive_file_id,
        status=DriveFile.Status.FAILED,
    ).update(status=DriveFile.Status.NEW, reason="")
    return {"ok": True}


ACTIONS: dict[str, Callable[[User, JsonObject], JsonObject]] = {
    "save-receipt-feedback": action_save_receipt_feedback,
    "invoice-ai-usage": action_invoice_ai_usage,
    "save-anthropic-key": action_save_anthropic_key,
    "delete-anthropic-key": action_delete_anthropic_key,
    "invoice-line-status": action_invoice_line_status,
    "import-invoices": action_import_invoices,
    "save-invoice": action_save_invoice,
    "review-invoice-line": action_review_invoice_line,
    "delete-invoice": action_delete_invoice,
    "save-expense-category": action_save_expense_category,
    "delete-expense-category": action_delete_expense_category,
    "save-payment-method": action_save_payment_method,
    "delete-payment-method": action_delete_payment_method,
    "link-invoice-line": action_link_invoice_line,
    "disconnect-invoice-line": action_disconnect_invoice_line,
    "use-invoice-price": action_use_invoice_price,
    "save-supplier": action_save_supplier,
    "merge-suppliers": action_merge_suppliers,
    "delete-supplier": action_delete_supplier,
    "connect-drive-folder": action_connect_drive_folder,
    "disconnect-drive-folder": action_disconnect_drive_folder,
    "skip-drive-files": action_skip_drive_files,
    "unskip-drive-file": action_unskip_drive_file,
    "retry-drive-file": action_retry_drive_file,
    "relink-supplier-item": action_relink_supplier_item,
    "ignore-supplier-item": action_ignore_supplier_item,
    "unignore-supplier-item": action_unignore_supplier_item,
    "delete-supplier-item": action_delete_supplier_item,
}
