"""Invoice read endpoints.

Plain view functions: the internal-secret guard is applied by
internal_urls.py, so this module never reaches into the dispatch layer.
"""

import re
import uuid
from datetime import datetime
from decimal import Decimal

from django.db.models import Count, Exists, F, Max, OuterRef, Q, Sum
from django.db.models.functions import Coalesce, TruncMonth
from django.http import HttpRequest, JsonResponse
from django.utils import timezone

from ...http.request import error
from ...integrations.token_crypto import TokenCryptoError, decrypt_token
from ...models import (
    AnthropicCredential,
    ConnectorSyncRun,
    DriveFile,
    DriveFileExtraction,
    DriveFolderSource,
    DriveWatchState,
    ExpenseCategory,
    IngredientInvoicePrice,
    Invoice,
    InvoiceLine,
    PaymentMethod,
    Supplier,
    SupplierItem,
    SupplierItemIgnore,
    User,
)
from ..shared.search import search_tokens, tokens_filter
from ..shared.billing import billing_json
from ..shared.supplier_import import supplier_display_name
from ..shared.values import month_value
from .actions import ensure_expense_categories
from .ai_usage import invoice_ai_usage
from .connector_sync import connector_payload, run_json as connector_run_json
from .serializers import (
    drive_file_json,
    drive_file_skip_json,
    drive_folder_json,
    drive_watch_summary_json,
    expense_category_json,
    INVOICE_TOTAL_TOLERANCE_CENTS,
    invoice_detail_json,
    invoice_json,
    invoice_line_json,
)


def invoice_suppliers(request: HttpRequest) -> JsonResponse:
    """Every supplier this workspace buys from, with what points at it.

    The counts are taken off the string columns the invoice, pantry and
    skip-list rows carry rather than off the record, because neither side is a
    superset of the other: a supplier can appear on an invoice without ever
    producing a pantry product (expense-only lines), and a pantry product can
    carry a supplier the workspace has no invoice for (spreadsheet imports).

    itemCount used to be computed in Next by downloading every ingredient —
    each with its full price history and supplier items — and counting in
    JavaScript. That is three aggregates in SQL.
    """

    def counted(model: type) -> dict[str, int]:
        rows = (
            model.objects.filter(user=request.user)
            .values("supplier")
            .annotate(total=Count("id"))
        )
        return {row["supplier"]: row["total"] for row in rows}

    invoice_counts = counted(Invoice)
    item_counts = counted(SupplierItem)
    ignore_counts = counted(SupplierItemIgnore)
    items = [
        {
            "id": str(row.id),
            "key": row.key,
            "name": row.name,
            "email": row.email,
            "phone": row.phone,
            "accountNumber": row.account_number,
            "notes": row.notes,
            # What this supplier's lines are filed under when no line of their
            # own remembers a category; null until the workspace says.
            "defaultCategoryId": (
                str(row.default_category_id) if row.default_category_id else None
            ),
            "invoiceCount": invoice_counts.get(row.key, 0),
            "itemCount": item_counts.get(row.key, 0),
            "ignoreCount": ignore_counts.get(row.key, 0),
        }
        for row in Supplier.objects.filter(user=request.user).order_by("name")
    ]
    return JsonResponse({"items": items})


def anthropic_key_status(user: User) -> dict[str, bool | str | None]:
    credential = AnthropicCredential.objects.filter(user=user).first()
    return {
        "configured": credential is not None,
        "hint": credential.key_hint if credential else None,
    }


def ai_credential(request: HttpRequest) -> JsonResponse:
    """Loopback-only credential access for invoice extraction."""
    credential = AnthropicCredential.objects.filter(user=request.user).first()
    if credential is None:
        return JsonResponse({"configured": False, "hint": None, "key": None})
    try:
        key = decrypt_token(credential.api_key_encrypted)
    except TokenCryptoError:
        return JsonResponse(
            {"configured": True, "hint": credential.key_hint, "key": None}
        )
    return JsonResponse({"configured": True, "hint": credential.key_hint, "key": key})


def drive_folder(request: HttpRequest) -> JsonResponse:
    """The connected Drive folder, the skipped files, and how the poller is.

    Drive ids only — the documents themselves are never stored here; the Next
    process fetches bytes from Drive when it extracts one.
    """
    source = DriveFolderSource.objects.filter(user=request.user).first()
    skipped = DriveFile.objects.filter(
        user=request.user, status=DriveFile.Status.SKIPPED
    ).order_by("-created_at")[:500]
    return JsonResponse(
        {
            "folder": drive_folder_json(source) if source is not None else None,
            "skipped": [drive_file_skip_json(row) for row in skipped],
            "watch": drive_watch_summary_json(DriveWatchState.objects.first()),
        }
    )


DRIVE_FILE_LIMIT_DEFAULT = 200
DRIVE_FILE_LIMIT_MAX = 500


def drive_files_payload(
    user: User, status: str, limit: int, *, oldest_first: bool = False
) -> dict:
    """One status of the Drive registry as `{files, count}`.

    The screen leads with the newest change; the watcher asks for the oldest
    first, so a backlog is read in the order the receipts arrived. `count` is
    everything in that status, not just the page, so the screen can say
    "200 of 812 new files" without a second request. For `ready` that is
    documents rather than files: one file can hold a bundle of receipts and
    the reviewer works through them one at a time, so counting files would
    promise fewer than it shows.
    """
    rows = DriveFile.objects.filter(user=user, status=status)
    counted = rows
    if status == DriveFile.Status.READY:
        # What the watcher read travels with the page: one extra query for
        # every part of every row on it, not one query per row.
        rows = rows.prefetch_related("extractions")
        counted = ready_documents(user)
    modified = F("modified_time")
    rows = rows.order_by(
        modified.asc(nulls_last=True)
        if oldest_first
        else modified.desc(nulls_last=True),
        "name",
    )
    return {
        "files": [drive_file_json(row) for row in rows[:limit]],
        "count": counted.count(),
    }


def drive_file_limit(raw_limit: str | None, default: int, maximum: int) -> int:
    """The `limit` query parameter, clamped. A value that is not a number
    raises ValueError, which the caller answers 400 with."""
    limit = int(raw_limit) if raw_limit else default
    return max(1, min(limit, maximum))


def drive_files(request: HttpRequest) -> JsonResponse:
    """One status of the Drive registry, newest change first."""
    status = (request.GET.get("status") or "").strip()
    if status not in DriveFile.Status.values:
        return error("Unknown Drive file status")
    try:
        limit = drive_file_limit(
            request.GET.get("limit"), DRIVE_FILE_LIMIT_DEFAULT, DRIVE_FILE_LIMIT_MAX
        )
    except ValueError:
        return error("Limit must be a whole number")
    return JsonResponse(drive_files_payload(request.user, status, limit))


SUPPLIER_ITEM_PAGE_SIZE = 50


def supplier_items(request: HttpRequest) -> JsonResponse:
    """The supplier memory Suppliers → Mapping shows, one page at a time.

    `tab=ignored` reads the skip list instead of the packs. Both are keyed on
    the supplier string, so a rename or a merge carries them along.
    """
    user = request.user
    supplier = (request.GET.get("supplier") or "").strip().lower()[:64]
    query = (request.GET.get("q") or "").strip()[:120]
    try:
        limit = int(request.GET.get("limit") or SUPPLIER_ITEM_PAGE_SIZE)
        offset = int(request.GET.get("offset") or 0)
    except ValueError:
        return error("limit and offset must be whole numbers")
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    ignored = request.GET.get("tab") == "ignored"

    names = dict(Supplier.objects.filter(user=user).values_list("key", "name"))

    def supplier_name(key: str) -> str:
        return names.get(key) or supplier_display_name(key)

    rows = (SupplierItemIgnore if ignored else SupplierItem).objects.filter(user=user)
    if supplier:
        rows = rows.filter(supplier=supplier)
    if query:
        rows = rows.filter(Q(title__icontains=query) | Q(external_id__icontains=query))
    if ignored:
        page = list(rows[offset : offset + limit])
        return JsonResponse(
            {
                "items": [
                    {
                        "id": str(row.id),
                        "supplier": row.supplier,
                        "supplierName": supplier_name(row.supplier),
                        "externalId": row.external_id,
                        # A key that starts with `desc:` was derived from the
                        # description because the supplier printed no code.
                        "hasCode": not row.external_id.startswith("desc:"),
                        "title": row.title,
                        "rawSize": row.raw_size,
                    }
                    for row in page
                ],
                "total": rows.count(),
            }
        )

    page = list(rows.select_related("ingredient")[offset : offset + limit])
    # One aggregate over the page, not one per row: how often this pack has
    # been billed and when it last was.
    usage = {
        row["supplier_item"]: row
        for row in InvoiceLine.objects.filter(
            user=user, supplier_item__in=[row.id for row in page]
        )
        .values("supplier_item")
        .annotate(times=Count("id"), last=Max("invoice__invoice_date"))
    }

    def item_json(row: SupplierItem) -> dict:
        seen = usage.get(row.id)
        last_date = seen["last"] if seen else None
        return {
            "id": str(row.id),
            "supplier": row.supplier,
            "supplierName": supplier_name(row.supplier),
            "externalId": row.external_id,
            "hasCode": not row.external_id.startswith("desc:"),
            "title": row.title,
            "rawSize": row.raw_size,
            "packPriceCents": row.pack_price_cents,
            "packAmount": float(row.pack_amount),
            "packUnit": row.pack_unit,
            "ingredientId": str(row.ingredient_id),
            "ingredientName": row.ingredient.name,
            "isPreferred": row.is_preferred,
            "timesSeen": seen["times"] if seen else 0,
            "lastInvoiceDate": last_date.isoformat() if last_date else None,
        }

    return JsonResponse(
        {"items": [item_json(row) for row in page], "total": rows.count()}
    )


def annotated_invoices(user: User):
    """Every invoice with what its lines add up to and how far the printed
    total is from them, so the attention tab and `issueKind` are one query
    rather than a read per row."""
    return (
        Invoice.objects.filter(user=user)
        .annotate(line_total_cents=Coalesce(Sum("lines__line_amount_cents"), 0))
        .annotate(total_delta=F("total_cents") - F("line_total_cents") - F("tax_cents"))
        # The Sum groups the query, and Django leaves Meta.ordering out of a
        # grouped query — so the month's 200-row page would be whatever order
        # Postgres felt like. Spelled out, it is the model's own order.
        .order_by("-invoice_date", "-created_at")
    )


# What puts an invoice in the attention tab: nothing was read off it, a line is
# still unresolved, nobody knows who billed it, or the printed total disagrees
# with the lines by more than `INVOICE_TOTAL_TOLERANCE_CENTS`.
NEEDS_ATTENTION = (
    Q(line_count=0)
    | Q(unresolved_line_count__gt=0)
    | Q(supplier_name="")
    | (
        Q(line_count__gt=0)
        & (
            Q(total_delta__gt=INVOICE_TOTAL_TOLERANCE_CENTS)
            | Q(total_delta__lt=-INVOICE_TOTAL_TOLERANCE_CENTS)
        )
    )
)

# One search or one tab returns at most this many rows; `needsReviewCount` is
# the uncapped total the client shows beside them.
INVOICE_ROW_CAP = 200

_MONEY = re.compile(r"^[-+]?\d+(?:\.\d{1,2})?$")


def money_cents(query: str) -> int | None:
    """`"88.73"` -> 8873, so typing a total off a document finds it. None when
    the query is not a bare amount."""
    cleaned = query.strip().lstrip("$€£").replace(",", "").replace(" ", "")
    if not _MONEY.match(cleaned):
        return None
    return int(Decimal(cleaned).scaleb(2).to_integral_value())


def invoice_search(user: User, query: str) -> Q | None:
    """Number, supplier, any line's description or code, or the whole query
    read as the printed total. None when the query can match nothing."""
    tokens = search_tokens(query)
    amount = money_cents(query)

    def extra(token):
        yield Exists(
            InvoiceLine.objects.filter(user=user, invoice=OuterRef("pk")).filter(
                Q(description__icontains=token.folded)
                | Q(description__icontains=token.typed)
                | Q(sku__icontains=token.typed)
            )
        )

    if not tokens:
        return Q(total_cents__in=(amount, -amount)) if amount is not None else None
    predicate = tokens_filter(tokens, ("invoice_number", "supplier_name"), extra)
    if amount is not None:
        predicate |= Q(total_cents__in=(amount, -amount))
    return predicate


def invoices_overview(request: HttpRequest) -> JsonResponse:
    user = request.user
    billing = billing_json(user)
    ensure_expense_categories(user)
    try:
        month = month_value(request.GET.get("month"))
    except ValueError as exc:
        return error(str(exc))
    query = (request.GET.get("q") or "").strip()[:120]
    tab = request.GET.get("tab") or ""

    month_rows = list(
        Invoice.objects.filter(user=user)
        .annotate(month=TruncMonth("invoice_date"))
        .values("month", "currency_code")
        .annotate(agg_total=Sum("total_cents"))
        .order_by("-month", "currency_code")
    )
    months_by_key: dict[str, dict] = {}
    for row in month_rows:
        if row["month"] is None:
            continue
        month_key = row["month"].strftime("%Y-%m")
        month_entry = months_by_key.setdefault(
            month_key, {"month": month_key, "totals": []}
        )
        month_entry["totals"].append(
            {
                "currencyCode": row["currency_code"],
                "totalCents": row["agg_total"] or 0,
            }
        )
    months = list(months_by_key.values())
    if month is None and months:
        month = datetime.strptime(months[0]["month"], "%Y-%m").date()
    if month is None:
        month = timezone.localdate().replace(day=1)

    month_invoices = Invoice.objects.filter(
        user=user, invoice_date__year=month.year, invoice_date__month=month.month
    )
    summary_rows = month_invoices.values("currency_code").annotate(
        agg_total=Sum("total_cents"),
        agg_invoices=Count("id"),
        agg_lines=Sum("line_count"),
        agg_credits=Sum("total_cents", filter=Q(total_cents__lt=0)),
    )
    # The badge counts the whole workspace, not the month on screen: an
    # invoice nobody has resolved does not stop needing attention because the
    # merchant scrolled to another month.
    all_invoices = annotated_invoices(user)
    needs_review_count = all_invoices.filter(NEEDS_ATTENTION).count()

    # A search and the attention tab both reach across months; only the plain
    # month view is a month. Each is capped, and `needsReviewCount` is what
    # says how much the cap hid.
    if query:
        predicate = invoice_search(user, query)
        visible_invoices = (
            all_invoices.none() if predicate is None else all_invoices.filter(predicate)
        )
    elif tab == "attention":
        visible_invoices = all_invoices.filter(NEEDS_ATTENTION)
    else:
        visible_invoices = all_invoices.filter(
            invoice_date__year=month.year, invoice_date__month=month.month
        )
    visible_invoices = visible_invoices[:INVOICE_ROW_CAP]

    month_lines = InvoiceLine.objects.filter(
        user=user,
        invoice__invoice_date__year=month.year,
        invoice__invoice_date__month=month.month,
    )
    by_category_rows = (
        month_lines.values("category_id", "category__name", "currency_code")
        .annotate(agg_total=Sum("line_amount_cents"), agg_lines=Count("id"))
        .order_by("-agg_total")
    )
    by_supplier_rows = (
        month_invoices.values("supplier", "supplier_name", "currency_code")
        .annotate(agg_total=Sum("total_cents"), agg_invoices=Count("id"))
        .order_by("-agg_total")
    )

    categories = ExpenseCategory.objects.filter(user=user)
    return JsonResponse(
        {
            "months": months,
            "month": month.strftime("%Y-%m"),
            "summary": [
                {
                    "currencyCode": row["currency_code"],
                    "totalCents": row["agg_total"] or 0,
                    "invoiceCount": row["agg_invoices"] or 0,
                    "lineCount": row["agg_lines"] or 0,
                    "creditCents": row["agg_credits"] or 0,
                }
                for row in summary_rows
            ],
            "needsReviewCount": needs_review_count,
            "byCategory": [
                {
                    "categoryId": (
                        str(row["category_id"]) if row["category_id"] else None
                    ),
                    "name": row["category__name"] or "Uncategorized",
                    "currencyCode": row["currency_code"],
                    "totalCents": row["agg_total"] or 0,
                    "lineCount": row["agg_lines"],
                }
                for row in by_category_rows
            ],
            "bySupplier": [
                {
                    "supplier": row["supplier"],
                    "supplierName": row["supplier_name"],
                    "currencyCode": row["currency_code"],
                    "totalCents": row["agg_total"] or 0,
                    "invoiceCount": row["agg_invoices"],
                }
                for row in by_supplier_rows
            ],
            "invoices": [invoice_json(row) for row in visible_invoices],
            "categories": [expense_category_json(row) for row in categories],
            "aiKey": anthropic_key_status(user),
            "aiUsage": invoice_ai_usage(user, billing),
            "connectors": connector_payload(user),
            # The badge on the Drive tab: how many files the poller has found
            # that nobody has imported, skipped or ruled out yet.
            "driveNewCount": DriveFile.objects.filter(
                user=user, status=DriveFile.Status.NEW
            ).count(),
            # The other half of that badge: documents the watcher has already
            # read and that are waiting for the merchant to confirm them — a
            # bundle counts once per receipt, the way the reviewer shows it.
            "driveReadyCount": ready_documents(user).count(),
        }
    )


def ready_documents(user: User):
    """Every document still waiting for the merchant: one row per receipt the
    watcher read out of a `ready` file, so a bundle counts once per receipt."""
    return DriveFileExtraction.objects.filter(
        drive_file__user=user,
        drive_file__status=DriveFile.Status.READY,
        status=DriveFileExtraction.Status.READY,
    )


def connector_sync_runs(request: HttpRequest) -> JsonResponse:
    runs = (
        ConnectorSyncRun.objects.filter(user=request.user)
        .select_related("connection")
        .order_by("-created_at")[:20]
    )
    return JsonResponse({"items": [connector_run_json(run) for run in runs]})


def connector_sync_run(request: HttpRequest, run_id: uuid.UUID) -> JsonResponse:
    run = (
        ConnectorSyncRun.objects.filter(user=request.user, id=run_id)
        .select_related("connection")
        .first()
    )
    if run is None:
        return error("Sync run not found", 404)
    return JsonResponse({"run": connector_run_json(run)})


def invoice_lines(request: HttpRequest, invoice_id: uuid.UUID) -> JsonResponse:
    # Annotated, so the header carries the same `issueKind` the list shows.
    invoice = annotated_invoices(request.user).filter(id=invoice_id).first()
    if invoice is None:
        return error("Invoice not found", 404)
    rows = invoice.lines.select_related("category", "ingredient")
    return JsonResponse(
        {
            "invoice": invoice_json(invoice),
            "items": [invoice_line_json(row) for row in rows],
        }
    )


def invoice_detail(request: HttpRequest, public_id: str) -> JsonResponse:
    """One invoice as a whole document, keyed by its public id."""
    invoice = Invoice.objects.filter(user=request.user, public_id=public_id).first()
    if invoice is None:
        return error("Invoice not found", 404)
    # The slice of the Drive file this invoice came out of, when the watcher
    # read that file as a bundle; a whole-file read has no row to find.
    part = (
        DriveFileExtraction.objects.filter(
            drive_file__user=request.user,
            drive_file__drive_file_id=invoice.drive_file_id,
            part=invoice.drive_file_part,
        ).first()
        if invoice.drive_file_id
        else None
    )
    return JsonResponse({"item": invoice_detail_json(invoice, part)})


def payment_methods(request: HttpRequest) -> JsonResponse:
    """The workspace's own payment methods. The four built-ins are wire values
    the clients already know, so they are not listed here."""
    rows = PaymentMethod.objects.filter(user=request.user)
    return JsonResponse(
        {"items": [{"id": str(row.id), "name": row.name} for row in rows]}
    )


def invoice_line_options(request: HttpRequest) -> JsonResponse:
    """Invoice lines an ingredient can be connected to, newest first."""
    query = (request.GET.get("q") or "").strip()[:120]
    rows = InvoiceLine.objects.filter(user=request.user).select_related("invoice")
    if query:
        rows = rows.filter(
            Q(description__icontains=query)
            | Q(sku__icontains=query)
            | Q(invoice__supplier_name__icontains=query)
        )
    rows = list(rows.order_by("-invoice__invoice_date", "-created_at")[:20])
    links: dict[object, list[object]] = {}
    for price in IngredientInvoicePrice.objects.filter(
        user=request.user, invoice_line__in=rows
    ).select_related("ingredient"):
        links.setdefault(price.invoice_line_id, []).append(price.ingredient)

    def option_json(row: InvoiceLine) -> dict:
        return {
            "id": str(row.id),
            "supplier": row.invoice.supplier_name or row.invoice.supplier,
            "description": row.description,
            "sku": row.sku,
            "packSize": row.pack_size,
            "quantity": float(row.quantity) if row.quantity is not None else None,
            "unitPriceCents": row.unit_price_cents,
            "lineAmountCents": row.line_amount_cents,
            "currencyCode": row.currency_code,
            "invoiceDate": (
                row.invoice.invoice_date.isoformat()
                if row.invoice.invoice_date
                else None
            ),
            "linkedIngredients": [
                {"name": ingredient.name, "publicId": ingredient.public_id}
                for ingredient in sorted(
                    links.get(row.id, []), key=lambda item: item.name.lower()
                )
            ],
        }

    return JsonResponse({"items": [option_json(row) for row in rows]})
