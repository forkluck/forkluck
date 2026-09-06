"""The secret-only surface the Next process's Drive watcher polls with.

The watcher runs on a timer in the Next process: no browser request, no
session, no `request.user`. It reads the Changes feed once for the whole
service account, so it needs to learn every connected folder and which
workspace owns it, register what changed to that workspace, and persist the
cursor. Every view here takes its workspace from the body rather than a
session; `internal_urls.py` applies the guard.
"""

import json
import uuid

from django.db import transaction
from django.http import HttpRequest, JsonResponse
from django.utils import timezone

from ...http.request import error, read_json
from ...models import (
    BenchCostSettings,
    DriveFile,
    DriveFileExtraction,
    DriveFolderSource,
    DriveWatchState,
)
from .actions import (
    action_invoice_line_status,
    register_drive_files,
    save_drive_watch_state,
)
from .serializers import drive_watch_folder_json, drive_watch_state_json
from .views import drive_file_limit, drive_files_payload
from .ai_usage import action_invoice_ai_usage
from ..shared.billing import EntitlementError


def drive_watch(request: HttpRequest) -> JsonResponse:
    """The cursor plus every connected folder, newest first.

    Two queries: the singleton and the folder list. `userId` is what the
    watcher posts back to `system/drive-files/`.
    """
    folders = DriveFolderSource.objects.order_by("-created_at")
    return JsonResponse(
        {
            **drive_watch_state_json(DriveWatchState.objects.first()),
            "folders": [drive_watch_folder_json(row) for row in folders],
        }
    )


def invoice_ai_usage(request: HttpRequest) -> JsonResponse:
    try:
        body = read_json(request)
        source = _connected_folder(body.get("userId"))
        if source is None:
            return error("No connected Drive folder for that workspace", 404)
        return JsonResponse(action_invoice_ai_usage(source.user, body))
    except EntitlementError as exc:
        return error(str(exc), 403, code=exc.code)
    except ValueError as exc:
        return error(str(exc))


def save_drive_watch(request: HttpRequest) -> JsonResponse:
    """Advance the cursor. The singleton is the poller's alone — no browser
    flow writes it, which is why this is a system route and not an action."""
    try:
        return JsonResponse(save_drive_watch_state(read_json(request)))
    except ValueError as exc:
        return error(str(exc))


def _connected_folder(user_id: object) -> DriveFolderSource | None:
    if not isinstance(user_id, str):
        return None
    try:
        uuid.UUID(user_id)
    except ValueError:
        return None
    return (
        DriveFolderSource.objects.select_related("user").filter(user_id=user_id).first()
    )


def register_files(request: HttpRequest) -> JsonResponse:
    """Register a Changes page against the workspace the body names.

    `markRegistered` says the poller has just listed the whole folder rather
    than only what a Changes page mentioned, so the folder no longer owes a
    first full listing.
    """
    try:
        body = read_json(request)
    except ValueError as exc:
        return error(str(exc))
    source = _connected_folder(body.get("userId"))
    if source is None:
        # Disconnected between the folder list and this call, or an id the
        # watcher invented: either way there is nowhere to register to.
        return error("No connected Drive folder for that workspace", 404)
    mark_registered = body.get("markRegistered", False)
    if not isinstance(mark_registered, bool):
        return error("Mark registered must be true or false")
    try:
        with transaction.atomic():
            result = register_drive_files(source.user, body)
            if mark_registered:
                source.registered_at = timezone.now()
                source.save(update_fields=["registered_at", "updated_at"])
    except ValueError as exc:
        return error(str(exc))
    return JsonResponse(result)


# The statuses the reader asks about: what it still owes a read, what it has
# read, and what it failed on. The merchant's own verdicts are none of its
# business.
SYSTEM_READABLE_STATUSES = (
    DriveFile.Status.NEW,
    DriveFile.Status.READY,
    DriveFile.Status.FAILED,
)
SYSTEM_FILE_LIMIT_DEFAULT = 20
SYSTEM_FILE_LIMIT_MAX = 100
# A document is a page of text, not a payload: past this the reader has sent
# something other than one receipt.
EXTRACTION_DOCUMENT_MAX_BYTES = 200 * 1024
# A file holding more documents than this is a filing cabinet, not a day's
# receipts, and a page index past the second bound is not a page.
EXTRACTION_PART_MAX = 40
EXTRACTION_PAGE_MAX = 2000


def drive_files(request: HttpRequest) -> JsonResponse:
    """Both halves of `system/drive-files/`: the watcher registers a page of
    Changes with POST and reads the registry back with GET. One route because
    Django matches a path once, and the two are the same resource."""
    if request.method == "GET":
        return read_drive_files(request)
    return register_files(request)


def read_drive_files(request: HttpRequest) -> JsonResponse:
    """What one workspace still owes a read, oldest first.

    Oldest first because a backlog is worked through in the order the receipts
    arrived; files Drive gave no modified time for come last.
    """
    source = _connected_folder(request.GET.get("userId"))
    if source is None:
        return error("No connected Drive folder for that workspace", 404)
    status = (request.GET.get("status") or "").strip()
    if status not in SYSTEM_READABLE_STATUSES:
        return error("Unknown Drive file status")
    try:
        limit = drive_file_limit(
            request.GET.get("limit"),
            SYSTEM_FILE_LIMIT_DEFAULT,
            SYSTEM_FILE_LIMIT_MAX,
        )
    except ValueError:
        return error("Limit must be a whole number")
    return JsonResponse(
        drive_files_payload(source.user, status, limit, oldest_first=True)
    )


def invoice_line_status(request: HttpRequest) -> JsonResponse:
    """The attended path's probe, run for the watcher instead of a browser.

    The same function the `invoice-line-status` action calls, plus the
    workspace currency: an unattended read has no session to look it up with,
    and a document that printed its own currency has to be normalized against
    it exactly the way the merchant's own import does.
    """
    try:
        body = read_json(request)
    except ValueError as exc:
        return error(str(exc))
    source = _connected_folder(body.get("userId"))
    if source is None:
        return error("No connected Drive folder for that workspace", 404)
    currency = (
        BenchCostSettings.objects.filter(user=source.user)
        .values_list("currency_code", flat=True)
        .first()
    )
    try:
        payload = action_invoice_line_status(source.user, body)
    except ValueError as exc:
        return error(str(exc))
    return JsonResponse({**payload, "currencyCode": currency or "USD"})


def _extraction_row(body: dict) -> tuple[DriveFile | None, JsonResponse | None]:
    """The registry row a reader's write names, or the error to answer with.

    Locked for the transaction the caller opened, and refused unless it is
    still waiting to be read: by the time a slow read finishes the merchant
    may have imported or skipped the file, and their verdict is the one that
    counts.
    """
    source = _connected_folder(body.get("userId"))
    if source is None:
        return None, error("No connected Drive folder for that workspace", 404)
    drive_file_id = body.get("driveFileId")
    if not isinstance(drive_file_id, str) or not drive_file_id:
        return None, error("Drive file id looks malformed")
    row = (
        DriveFile.objects.select_for_update()
        .filter(user=source.user, drive_file_id=drive_file_id)
        .first()
    )
    if row is None:
        return None, error("Drive file not found", 404)
    if row.status not in (DriveFile.Status.NEW, DriveFile.Status.READY):
        return None, error("That Drive file is no longer waiting to be read")
    return row, None


def _page_bound(value: object, name: str) -> int | None:
    """A 0-based page index, or None when the part is not a page range."""
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"{name} looks malformed")
    if value > EXTRACTION_PAGE_MAX:
        raise ValueError(f"{name} looks malformed")
    return value


def _region(value: object) -> dict | None:
    """A crop of the prepared photo as fractions of it, or None."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("Region looks malformed")
    box = {}
    for key in ("x0", "y0", "x1", "y1"):
        edge = value.get(key)
        if isinstance(edge, bool) or not isinstance(edge, (int, float)):
            raise ValueError("Region looks malformed")
        if not 0 <= float(edge) <= 1:
            raise ValueError("Region looks malformed")
        box[key] = float(edge)
    if box["x0"] >= box["x1"] or box["y0"] >= box["y1"]:
        raise ValueError("Region looks malformed")
    return box


def extraction_parts(body: dict) -> list[dict]:
    """The parts a reader is storing, whichever shape it sent.

    A file holding one document may post it flat (`document`, `model`,
    `escalated`); a file holding several posts `parts`. The flat shape is
    turned into a one-element list here so nothing downstream knows there
    were ever two shapes. A part may name its own `model`/`escalated`,
    because one receipt of a bundle can escalate while its neighbours do not;
    the body-level values are the default.
    """
    raw = body.get("parts")
    if raw is None:
        raw = [
            {
                "part": 0,
                "document": body.get("document"),
                "pageStart": body.get("pageStart"),
                "pageEnd": body.get("pageEnd"),
                "region": body.get("region"),
            }
        ]
    if not isinstance(raw, list) or not 1 <= len(raw) <= EXTRACTION_PART_MAX:
        raise ValueError("Extraction parts look malformed")
    default_model = body.get("model", "")
    if not isinstance(default_model, str) or len(default_model) > 120:
        raise ValueError("Extraction model looks malformed")
    default_escalated = body.get("escalated", False)
    if not isinstance(default_escalated, bool):
        raise ValueError("Escalated must be true or false")
    parts: list[dict] = []
    seen: set[int] = set()
    for entry in raw:
        if not isinstance(entry, dict):
            raise ValueError("Extraction parts look malformed")
        index = entry.get("part", 0)
        if isinstance(index, bool) or not isinstance(index, int):
            raise ValueError("Extraction parts look malformed")
        if not 0 <= index < EXTRACTION_PART_MAX or index in seen:
            raise ValueError("Extraction parts look malformed")
        seen.add(index)
        document = entry.get("document")
        if not isinstance(document, dict) or not document:
            raise ValueError("Extraction document looks malformed")
        if len(json.dumps(document)) > EXTRACTION_DOCUMENT_MAX_BYTES:
            raise ValueError("Extraction document is too large")
        model = entry.get("model", default_model)
        if not isinstance(model, str) or len(model) > 120:
            raise ValueError("Extraction model looks malformed")
        escalated = entry.get("escalated", default_escalated)
        if not isinstance(escalated, bool):
            raise ValueError("Escalated must be true or false")
        page_start = _page_bound(entry.get("pageStart"), "Page start")
        page_end = _page_bound(entry.get("pageEnd"), "Page end")
        if (page_start is None) != (page_end is None):
            raise ValueError("Page range looks malformed")
        if page_start is not None and page_end < page_start:
            raise ValueError("Page range looks malformed")
        region = _region(entry.get("region"))
        if region is not None and page_start is not None:
            raise ValueError("A part is a page range or a region, not both")
        parts.append(
            {
                "part": index,
                "document": document,
                "model": model,
                "escalated": escalated,
                "page_start": page_start,
                "page_end": page_end,
                "region": region,
            }
        )
    return parts


def save_drive_extraction(request: HttpRequest) -> JsonResponse:
    """Store every document the watcher read out of a file and offer it for
    review. The parts replace whatever was stored before, so a re-read never
    leaves a stale document of an earlier reading behind."""
    try:
        body = read_json(request)
        parts = extraction_parts(body)
    except ValueError as exc:
        return error(str(exc))
    now = timezone.now()
    with transaction.atomic():
        row, refusal = _extraction_row(body)
        if row is None:
            return refusal
        DriveFileExtraction.objects.filter(drive_file=row).delete()
        DriveFileExtraction.objects.bulk_create(
            DriveFileExtraction(drive_file=row, extracted_at=now, **part)
            for part in parts
        )
        row.status = DriveFile.Status.READY
        row.reason = ""
        row.save(update_fields=["status", "reason", "updated_at"])
        ready_count = DriveFile.objects.filter(
            user_id=row.user_id, status=DriveFile.Status.READY
        ).count()
    return JsonResponse({"ok": True, "readyCount": ready_count})


def fail_drive_extraction(request: HttpRequest) -> JsonResponse:
    """Record that the read did not produce an invoice. The row keeps the
    reason so the screen can say why, and `retry-drive-file` puts it back."""
    try:
        body = read_json(request)
    except ValueError as exc:
        return error(str(exc))
    reason = body.get("reason", "")
    if not isinstance(reason, str) or len(reason) > 255:
        return error("Reason looks malformed")
    with transaction.atomic():
        row, refusal = _extraction_row(body)
        if row is None:
            return refusal
        # A failed read has nothing to review, and a re-read that fails must
        # not leave the previous reading behind.
        DriveFileExtraction.objects.filter(drive_file=row).delete()
        row.status = DriveFile.Status.FAILED
        row.reason = reason
        row.save(update_fields=["status", "reason", "updated_at"])
    return JsonResponse({"ok": True})
