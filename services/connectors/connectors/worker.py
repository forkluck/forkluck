"""Durable, single-claim worker for provider acquisition."""

import json
import uuid
from datetime import date, timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .crypto import decrypt
from .models import ConnectorRun, DocumentPage
from .providers import PROVIDERS
from .services import provider_allowed

PAGE_DOCUMENT_LIMIT = 40


def fail_stale_runs():
    """A crashed worker must not permanently block the next manual sync."""
    return ConnectorRun.objects.filter(
        status=ConnectorRun.Status.RUNNING,
        heartbeat_at__lt=timezone.now()
        - timedelta(seconds=settings.CONNECTORS_RUN_STALE_SECONDS),
    ).update(
        status=ConnectorRun.Status.FAILED,
        error="Connector worker stopped before the sync completed",
    )


def _date(value, fallback):
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        return fallback


def _validate_document(document):
    required = {
        "supplier",
        "supplierName",
        "documentType",
        "invoiceNumber",
        "invoiceDate",
        "totalCents",
        "currencyCode",
        "fileName",
        "lines",
    }
    if (
        set(document) != required
        or document["documentType"]
        not in {"invoice", "credit_memo", "receipt", "refund"}
        or not isinstance(document["lines"], list)
        or len(document["lines"]) > 500
    ):
        raise ValueError("Provider normalization did not produce supplier_documents:v1")
    for line in document["lines"]:
        if (
            set(line)
            - {
                "sku",
                "description",
                "quantity",
                "unit",
                "packSize",
                "unitPriceCents",
                "lineAmountCents",
                "sourcePayload",
            }
            or "description" not in line
            or "lineAmountCents" not in line
        ):
            raise ValueError("Provider normalization emitted an invalid line")


def _append_page(run, claim_token, documents, cursor):
    # A zero-document sync still needs one terminal page: the public client
    # validates every pages/next response against the strict v1 schema.
    if not documents and cursor.get("complete") is not True:
        return
    if sum(len(document["lines"]) for document in documents) > 500:
        raise ValueError("Provider page exceeds 500 total lines")
    for document in documents:
        _validate_document(document)
    with transaction.atomic():
        locked = (
            ConnectorRun.objects.select_for_update()
            .filter(
                pk=run.pk, status=ConnectorRun.Status.RUNNING, claim_token=claim_token
            )
            .first()
        )
        if locked is None:
            raise RuntimeError("Worker claim was lost")
        sequence = locked.pages.count() + 1
        next_cursor = (
            {"complete": True}
            if cursor.get("complete") is True
            else {"sequence": sequence + 1}
        )
        DocumentPage.objects.create(
            run=locked,
            sequence=sequence,
            payload={"documents": documents},
            next_cursor=next_cursor,
        )


def execute(run_id):
    """Claim and run once. Retrying a failed queued run creates no duplicate pages."""
    with transaction.atomic():
        run = (
            ConnectorRun.objects.select_for_update()
            .select_related("connection")
            .filter(pk=run_id, status=ConnectorRun.Status.QUEUED)
            .first()
        )
        if run is None:
            return False
        run.status, run.heartbeat_at, run.claim_token = (
            ConnectorRun.Status.RUNNING,
            timezone.now(),
            uuid.uuid4(),
        )
        run.save(update_fields=["status", "heartbeat_at", "claim_token", "updated_at"])
    claim_token = run.claim_token
    try:
        provider = PROVIDERS.get(run.connection.provider_key)
        if not provider:
            raise ValueError("Provider is unavailable")
        if not provider_allowed(run.connection.provider_key, run.subject_id):
            raise ValueError("Provider access was revoked")
        credentials = json.loads(decrypt(run.connection.credential_encrypted))
        client = provider["client"]()
        client.login(credentials["username"], credentials["password"])
        today = timezone.localdate()
        from_date = _date(run.cursor.get("fromDate"), today - timedelta(days=730))
        to_date = _date(run.cursor.get("toDate"), today)
        invoice_page = int(run.cursor.get("invoicePage", 0))
        documents, count = [], 0
        pages_done = invoice_page
        for batch in client.document_batches(
            from_date, to_date, start_page=invoice_page
        ):
            for document in batch:
                _validate_document(document)
                if documents and (
                    len(documents) == PAGE_DOCUMENT_LIMIT
                    or sum(len(item["lines"]) for item in documents)
                    + len(document["lines"])
                    > 500
                ):
                    _append_page(run, claim_token, documents, {})
                    documents = []
                documents.append(document)
                count += 1
            pages_done += 1
            updated = ConnectorRun.objects.filter(
                pk=run_id, status=ConnectorRun.Status.RUNNING, claim_token=claim_token
            ).update(heartbeat_at=timezone.now())
            if not updated:
                raise RuntimeError("Worker claim was lost")
        _append_page(
            run,
            claim_token,
            documents,
            {
                "complete": True,
                "fromDate": from_date.isoformat(),
                "toDate": to_date.isoformat(),
            },
        )
        ConnectorRun.objects.filter(
            pk=run_id, status=ConnectorRun.Status.RUNNING, claim_token=claim_token
        ).update(
            status=ConnectorRun.Status.SUCCEEDED,
            progress={"pagesDone": pages_done, "documents": count},
            heartbeat_at=timezone.now(),
        )
        return True
    except Exception:
        # Arbitrary provider exceptions can contain credentials, URLs, or raw
        # responses. Persist a fixed message, including for unfamiliar providers.
        ConnectorRun.objects.filter(
            pk=run_id, status=ConnectorRun.Status.RUNNING, claim_token=claim_token
        ).update(
            status=ConnectorRun.Status.FAILED,
            error="Provider sync failed",
            heartbeat_at=timezone.now(),
        )
        return False
