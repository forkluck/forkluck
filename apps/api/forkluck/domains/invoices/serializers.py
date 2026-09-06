"""Invoice, invoice-line and expense-category JSON shapes."""

from typing import Any

from ...models import (
    DriveFile,
    DriveFileExtraction,
    DriveFolderSource,
    DriveWatchState,
    ExpenseCategory,
    Invoice,
    InvoiceLine,
)
from ..shared.values import iso

JsonObject = dict[str, Any]


def expense_category_json(row: ExpenseCategory) -> JsonObject:
    return {
        "id": str(row.id),
        "name": row.name,
        "isIngredient": row.is_ingredient,
        "isSupply": row.is_supply,
        "position": row.position,
    }


def drive_folder_json(row: DriveFolderSource) -> JsonObject:
    return {"folderId": row.folder_id, "folderName": row.folder_name}


def drive_file_skip_json(row: DriveFile) -> JsonObject:
    """The skip list the Connections card still reads, off the registry row."""
    return {
        "driveFileId": row.drive_file_id,
        "fileName": row.name,
        "reason": row.reason,
    }


def drive_file_part_json(row: DriveFileExtraction) -> JsonObject:
    """One document the watcher read out of a file, verbatim. `document` is
    opaque to Django: it is the normalized invoice the Next process stored,
    and the workspace's view of it (categories, duplicates, matches) is
    recomputed at review time. `pageStart`/`pageEnd` or `region` say which
    slice of the file it came from; all three are null for a whole file."""
    return {
        "id": str(row.id),
        "part": row.part,
        "pageStart": row.page_start,
        "pageEnd": row.page_end,
        "region": row.region,
        "status": row.status,
        "document": row.document,
        "model": row.model,
        "escalated": row.escalated,
        "extractedAt": iso(row.extracted_at),
    }


def drive_file_json(row: DriveFile) -> JsonObject:
    # Only a `ready` row can carry readings, and the reads that list those
    # prefetch them, so this never reaches back to the database per row.
    parts = (
        sorted(row.extractions.all(), key=lambda part: part.part)
        if row.status == DriveFile.Status.READY
        else []
    )
    return {
        "driveFileId": row.drive_file_id,
        "name": row.name,
        "mimeType": row.mime_type,
        "sizeBytes": row.size_bytes,
        "modifiedTime": iso(row.modified_time) if row.modified_time else None,
        "webViewLink": row.web_view_link,
        "folderPath": row.folder_path,
        "status": row.status,
        "reason": row.reason,
        "invoiceId": str(row.invoice_id) if row.invoice_id else None,
        "seenAt": iso(row.seen_at),
        "parts": [drive_file_part_json(part) for part in parts],
    }


def drive_watch_state_json(row: DriveWatchState | None) -> JsonObject:
    """The whole cursor, for the poller that advances it."""
    return {
        "pageToken": row.page_token if row else "",
        "polledAt": iso(row.polled_at) if row and row.polled_at else None,
        "lastError": row.last_error if row else "",
    }


def drive_watch_folder_json(row: DriveFolderSource) -> JsonObject:
    """One connected folder, for the poller that has to decide which workspace
    a changed file belongs to. `registeredAt` is null until it has listed the
    folder in full at least once."""
    return {
        "userId": str(row.user_id),
        "folderId": row.folder_id,
        "folderName": row.folder_name,
        "registeredAt": iso(row.registered_at) if row.registered_at else None,
    }


def drive_watch_summary_json(row: DriveWatchState | None) -> JsonObject | None:
    """What the Connections card says about the poller, or nothing yet."""
    if row is None:
        return None
    return {
        "polledAt": iso(row.polled_at) if row.polled_at else None,
        "lastError": row.last_error,
    }


# What the printed total may differ from the lines by before the row is called
# a mismatch. Mirrors `normalizeInvoiceExtraction`'s tolerance in
# `apps/web/lib/invoice-import.ts`, so both sides call the same document even.
INVOICE_TOTAL_TOLERANCE_CENTS = 50


def invoice_issue_kind(row: Invoice) -> str | None:
    """The one thing wrong with this invoice, worst first, or None.

    `total-mismatch` is only reachable on a row the queryset annotated with
    `line_total_cents` / `total_delta`; an unannotated row cannot know what its
    lines add up to and says nothing rather than guessing.
    """
    if row.line_count == 0:
        return "no-lines"
    if row.unresolved_line_count > 0:
        return "unmatched-lines"
    if getattr(row, "line_total_cents", None) is not None and (
        abs(row.total_delta) > INVOICE_TOTAL_TOLERANCE_CENTS
    ):
        return "total-mismatch"
    if not row.supplier_name:
        return "unknown-supplier"
    return None


def invoice_json(row: Invoice) -> JsonObject:
    return {
        "id": str(row.id),
        "publicId": row.public_id,
        "supplier": row.supplier,
        "supplierName": row.supplier_name,
        "documentType": row.document_type,
        "invoiceNumber": row.invoice_number,
        "invoiceDate": row.invoice_date.isoformat() if row.invoice_date else None,
        # The currency the supplier billed in. Sent with the amount so the
        # client never has to assume it matches the workspace's current
        # currency — an invoice is not restated when that changes.
        "currencyCode": row.currency_code,
        "totalCents": row.total_cents,
        "taxCents": row.tax_cents,
        "lineCount": row.line_count,
        "matchedLineCount": row.matched_line_count,
        "unresolvedLineCount": row.unresolved_line_count,
        # Why this row is in the attention tab, or null when nothing is wrong.
        "issueKind": invoice_issue_kind(row),
        # total - lines - tax, null on a row the queryset did not annotate.
        "totalDeltaCents": getattr(row, "total_delta", None),
        "fileName": row.file_name,
        "source": row.source or None,
        "driveFileId": row.drive_file_id or None,
        "driveWebViewLink": row.drive_web_view_link or None,
        "createdAt": iso(row.created_at),
        "updatedAt": iso(row.updated_at),
    }


def invoice_line_json(row: InvoiceLine) -> JsonObject:
    return {
        "id": str(row.id),
        "position": row.position,
        "sku": row.sku,
        "description": row.description,
        "quantity": float(row.quantity) if row.quantity is not None else None,
        "unit": row.unit,
        "packSize": row.pack_size,
        "currencyCode": row.currency_code,
        "unitPriceCents": row.unit_price_cents,
        "lineAmountCents": row.line_amount_cents,
        "categoryId": str(row.category_id) if row.category_id else None,
        "categoryName": row.category.name if row.category else None,
        "ingredientId": str(row.ingredient_id) if row.ingredient_id else None,
        "ingredientName": row.ingredient.name if row.ingredient else None,
        "priceUpdated": row.price_updated,
        "needsReview": row.needs_review,
    }


def invoice_detail_json(
    row: Invoice, part: DriveFileExtraction | None = None
) -> JsonObject:
    """One invoice read as a whole document, lines included.

    Narrower than invoice_json where the list needs nothing (no updatedAt) and
    wider where the document view does: the tax and payment method the
    merchant typed in, and the Drive file it was read from — with `part`, the
    slice of that file, when the watcher read the file as a bundle — so the
    page can show the document beside its lines.
    """
    return {
        "id": str(row.id),
        "publicId": row.public_id,
        "editVersion": row.edit_version,
        "supplier": row.supplier,
        "supplierName": row.supplier_name,
        "documentType": row.document_type,
        "invoiceNumber": row.invoice_number,
        "invoiceDate": row.invoice_date.isoformat() if row.invoice_date else None,
        "dueDate": row.due_date.isoformat() if row.due_date else None,
        "totalCents": row.total_cents,
        "taxCents": row.tax_cents,
        # Null when the document did not print a subtotal; never derived.
        "subtotalCents": row.subtotal_cents,
        "notes": row.notes,
        "paymentMethod": row.payment_method,
        "currencyCode": row.currency_code,
        "source": row.source or None,
        "fileName": row.file_name,
        "driveWebViewLink": row.drive_web_view_link or None,
        "driveFileId": row.drive_file_id or None,
        "driveFilePart": (
            {
                "part": part.part,
                "pageStart": part.page_start,
                "pageEnd": part.page_end,
                "region": part.region,
            }
            if part is not None
            else None
        ),
        # The uploaded file kept on our side, null for a Drive or typed-in
        # invoice; the page fetches it from Next by this key.
        "documentKey": row.document_key or None,
        "lineCount": row.line_count,
        "matchedLineCount": row.matched_line_count,
        "unresolvedLineCount": row.unresolved_line_count,
        "createdAt": iso(row.created_at),
        "lines": [
            invoice_line_json(line)
            for line in row.lines.select_related("category", "ingredient")
        ],
    }
