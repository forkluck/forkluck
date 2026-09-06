"""Provider-neutral supplier document synchronization.

The public app owns durable job state and invoice persistence.  The remote
connector owns every supplier-specific login and fetch.  Keeping that seam
here prevents provider code and supplier credentials from becoming part of the
AGPL application or its deploy artifact.
"""

import secrets
import urllib.parse
import uuid
from datetime import date, timedelta
import math
import re
from typing import Any

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import OuterRef, Subquery
from django.utils import timezone

from ...integrations import connectors
from ...integrations.token_crypto import decrypt_token, encrypt_token
from ...models import (
    BenchCostSettings,
    ConnectorAuthorizationSession,
    ConnectorConnection,
    ConnectorSyncRun,
    User,
)
from ..shared.activity import record_event
from ..shared.billing import require_entitlement
from ..shared.values import text_value, uuid_value
from .actions import action_import_invoices

JsonObject = dict[str, Any]

ACTIVE_STATUSES = (ConnectorSyncRun.Status.QUEUED, ConnectorSyncRun.Status.RUNNING)
RUN_STALE_AFTER = timedelta(minutes=15)
REMOTE_POLL_AFTER = timedelta(seconds=2)
MAX_TRANSIENT_FAILURES = 3
AUTHORIZATION_TTL = timedelta(minutes=10)
PROVIDER_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
MAX_CENTS = 2_147_483_647


class SupplierDocumentsInvalid(ValueError):
    pass


def _progress(value: object | None = None) -> JsonObject:
    source = value if isinstance(value, dict) else {}
    result: JsonObject = {}
    for key in (
        "pagesDone",
        "documentsSeen",
        "documentsImported",
        "documentsSkipped",
        "linesNeedingReview",
    ):
        item = source.get(key, 0)
        result[key] = item if isinstance(item, int) and not isinstance(item, bool) else 0
    return result


def _connection_json(row: ConnectorConnection, latest: ConnectorSyncRun | None) -> JsonObject:
    return {
        "id": str(row.id),
        "providerKey": row.provider_key,
        "status": row.status,
        "lastSyncedAt": row.last_synced_at.isoformat() if row.last_synced_at else None,
        "lastError": row.last_error or None,
        "lastErrorCode": row.last_error_code or None,
        "latestRun": run_json(latest) if latest else None,
    }


def run_json(run: ConnectorSyncRun) -> JsonObject:
    return {
        "id": str(run.id),
        "providerKey": run.connection.provider_key,
        "remoteRunId": run.remote_run_id or None,
        "status": run.status,
        "progress": _progress(run.progress),
        "error": run.error or None,
        "queuedAt": run.created_at.isoformat(),
        "startedAt": run.started_at.isoformat() if run.started_at else None,
        "heartbeatAt": run.heartbeat_at.isoformat() if run.heartbeat_at else None,
        "finishedAt": run.finished_at.isoformat() if run.finished_at else None,
    }


def _provider_json(row: object) -> JsonObject:
    if not isinstance(row, dict):
        raise ValueError("Connector provider list was malformed")
    key = row.get("key")
    display_name = row.get("displayName")
    if not isinstance(key, str) or not key or len(key) > 64:
        raise ValueError("Connector provider list was malformed")
    if not isinstance(display_name, str) or not display_name or len(display_name) > 120:
        raise ValueError("Connector provider list was malformed")
    capabilities = row.get("capabilities", [])
    if not isinstance(capabilities, list) or any(
        not isinstance(item, str) or len(item) > 64 for item in capabilities
    ):
        raise ValueError("Connector provider list was malformed")
    description = row.get("description", "")
    icon = row.get("icon", "")
    if not isinstance(description, str) or len(description) > 500:
        raise ValueError("Connector provider list was malformed")
    if not isinstance(icon, str) or len(icon) > 500:
        raise ValueError("Connector provider list was malformed")
    return {
        "key": key,
        "displayName": display_name,
        "description": description,
        "icon": icon,
        "capabilities": capabilities,
        "available": bool(row.get("available", False)),
    }


def connector_payload(user: User) -> JsonObject:
    if not connectors.configured():
        return {"configured": False, "providers": [], "connections": []}
    latest_run_id = Subquery(
        ConnectorSyncRun.objects.filter(connection_id=OuterRef("pk"))
        .order_by("-created_at")
        .values("id")[:1]
    )
    connections = list(
        ConnectorConnection.objects.filter(user=user).annotate(
            latest_run_id=latest_run_id
        )
    )
    catalog_unavailable = False
    try:
        providers = [_provider_json(row) for row in connectors.providers(subject_id=str(user.id))]
    except (connectors.ConnectorError, ValueError):
        # Settings remains usable during a private-service deploy; surface the
        # outage as an unavailable catalog instead of failing invoice reads.
        providers = []
        catalog_unavailable = True
    if catalog_unavailable:
        known_keys = {row["key"] for row in providers}
        # A catalog outage must not make an already-authorized connection
        # disappear from Settings.  This deliberately uses no provider data:
        # the stable local key is enough to keep its reconnect/disconnect
        # controls reachable until the private service recovers.
        providers.extend(
            {
                "key": connection.provider_key,
                "displayName": "Supplier connector",
                "description": "Connector details are temporarily unavailable.",
                "icon": "cable",
                "capabilities": [],
                "available": True,
            }
            for connection in connections
            if connection.provider_key not in known_keys
        )
    runs_by_id = {
        run.id: run
        for run in ConnectorSyncRun.objects.filter(
            user=user,
            id__in=[row.latest_run_id for row in connections if row.latest_run_id],
        ).select_related("connection")
    }
    return {
        "configured": True,
        "providers": providers,
        "connections": [
            _connection_json(row, runs_by_id.get(row.latest_run_id))
            for row in connections
        ],
    }


def _callback_url() -> str:
    return f"{settings.FORKLUCK_APP_ORIGIN.rstrip('/')}/api/integrations/connectors/callback"


def action_connect_connector(user: User, body: JsonObject) -> JsonObject:
    require_entitlement(user, "connectors")
    if not connectors.configured():
        raise ValueError("Supplier connectors are not configured")
    provider_key = text_value(body.get("providerKey"), "Provider", max_length=64)
    providers = [_provider_json(row) for row in connectors.providers(subject_id=str(user.id))]
    provider = next((row for row in providers if row["key"] == provider_key), None)
    if provider is None or not provider["available"]:
        raise ValueError("That supplier connector is not available")
    now = timezone.now()
    ConnectorAuthorizationSession.objects.filter(
        user=user, consumed_at__isnull=True, expires_at__lte=now
    ).delete()
    state = secrets.token_urlsafe(32)
    remote = connectors.create_authorization_session(
        subject_id=str(user.id),
        provider_key=provider_key,
        state=state,
        callback_url=_callback_url(),
    )
    session_id = remote.get("sessionId")
    authorization_url = remote.get("authorizationUrl")
    if not isinstance(session_id, str) or not session_id or len(session_id) > 128:
        raise ValueError("Connector service returned an invalid authorization session")
    parsed_url = urllib.parse.urlsplit(authorization_url) if isinstance(authorization_url, str) else None
    configured_origin = urllib.parse.urlsplit(settings.FORKLUCK_CONNECTOR_SERVICE_URL)
    if (
        parsed_url is None
        or parsed_url.scheme != configured_origin.scheme
        or parsed_url.hostname != configured_origin.hostname
        or parsed_url.port != configured_origin.port
        or parsed_url.username is not None
        or parsed_url.password is not None
    ):
        raise ValueError("Connector service returned an invalid authorization URL")
    ConnectorAuthorizationSession.objects.create(
        user=user,
        provider_key=provider_key,
        state=state,
        remote_session_id=session_id,
        expires_at=now + AUTHORIZATION_TTL,
    )
    return {"authorizationUrl": authorization_url}


def action_complete_connector_authorization(user: User, body: JsonObject) -> JsonObject:
    require_entitlement(user, "connectors")
    state = text_value(body.get("state"), "Authorization state", max_length=128)
    code = text_value(body.get("code"), "Authorization code", max_length=512)
    now = timezone.now()
    with transaction.atomic():
        session = (
            ConnectorAuthorizationSession.objects.select_for_update()
            .filter(user=user, state=state, consumed_at__isnull=True)
            .first()
        )
        if session is None or session.expires_at <= now:
            raise ValueError("This connector authorization has expired. Connect again.")
        # Mark first to make a duplicate callback fail even if exchange later
        # succeeds but a browser retries before the response reaches it.
        session.consumed_at = now
        session.save(update_fields=["consumed_at", "updated_at"])
    remote = connectors.exchange_authorization_code(
        subject_id=str(user.id), session_id=session.remote_session_id, state=state, code=code
    )
    remote_connection_id = remote.get("connectionId")
    access_token = remote.get("accessToken")
    provider_key = remote.get("providerKey")
    status = remote.get("status", ConnectorConnection.Status.CONNECTED)
    if (
        not isinstance(remote_connection_id, str)
        or not remote_connection_id
        or len(remote_connection_id) > 128
        or not isinstance(access_token, str)
        or not access_token
        or len(access_token) > 4096
        or provider_key != session.provider_key
        or status not in ConnectorConnection.Status.values
    ):
        raise ValueError("Connector service returned an invalid connection")
    encrypted_token = encrypt_token(access_token)
    try:
        with transaction.atomic():
            connection = (
                ConnectorConnection.objects.select_for_update()
                .filter(user=user, provider_key=session.provider_key)
                .first()
            )
            if connection is None:
                connection = ConnectorConnection.objects.create(
                    user=user,
                    provider_key=session.provider_key,
                    remote_connection_id=remote_connection_id,
                    access_token_encrypted=encrypted_token,
                    status=status,
                )
            else:
                # A claimed worker can be waiting on provider I/O while the
                # user reconnects.  Fence that generation before replacing
                # the opaque token, so no old result can affect the fresh
                # connection after its request returns.
                ConnectorSyncRun.objects.filter(
                    connection=connection, status__in=ACTIVE_STATUSES
                ).update(
                    status=ConnectorSyncRun.Status.CANCELLED,
                    claim_token=None,
                    finished_at=now,
                    error="Connection was reconnected",
                )
                connection.remote_connection_id = remote_connection_id
                connection.access_token_encrypted = encrypted_token
                connection.status = status
                connection.last_error = ""
                connection.last_error_code = ""
                connection.save(
                    update_fields=[
                        "remote_connection_id",
                        "access_token_encrypted",
                        "status",
                        "last_error",
                        "last_error_code",
                        "updated_at",
                    ]
                )
    except IntegrityError as exc:
        raise ValueError("This connector connection is already in use") from exc
    record_event(user, user, "connection", "connected", name=connection.provider_key)
    return {"connection": _connection_json(connection, None)}


def _connection_for_user(user: User, value: object) -> ConnectorConnection:
    connection = ConnectorConnection.objects.filter(
        user=user, id=uuid_value(value, "Connection")
    ).first()
    if connection is None:
        raise ValueError("Connector connection was not found")
    return connection


def action_enqueue_connector_sync(user: User, body: JsonObject) -> JsonObject:
    require_entitlement(user, "connectors")
    connection = _connection_for_user(user, body.get("connectionId"))
    if connection.status != ConnectorConnection.Status.CONNECTED:
        raise ValueError("Reconnect this supplier before syncing")
    try:
        with transaction.atomic():
            locked = ConnectorConnection.objects.select_for_update().get(pk=connection.pk)
            active = (
                ConnectorSyncRun.objects.select_related("connection")
                .filter(connection=locked, status__in=ACTIVE_STATUSES)
                .first()
            )
            if active:
                return {"run": run_json(active)}
            run = ConnectorSyncRun.objects.create(
                user=user, connection=locked, progress=_progress()
            )
    except IntegrityError:
        active = (
            ConnectorSyncRun.objects.select_related("connection")
            .filter(connection=connection, status__in=ACTIVE_STATUSES)
            .first()
        )
        if active is None:
            raise
        return {"run": run_json(active)}
    return {"run": run_json(run)}


def action_disconnect_connector(user: User, body: JsonObject) -> JsonObject:
    connection = _connection_for_user(user, body.get("connectionId"))
    remote_connection_id = connection.remote_connection_id
    encrypted_token = connection.access_token_encrypted
    token = decrypt_token(encrypted_token)
    # The remote service is authoritative for its credential lifetime. Do not
    # delete the local pointer until it confirms the subject/token binding.
    connectors.disconnect(
        subject_id=str(user.id), connection_id=remote_connection_id, token=token
    )
    with transaction.atomic():
        current = (
            ConnectorConnection.objects.select_for_update()
            .filter(pk=connection.pk, user=user)
            .first()
        )
        if current is None:
            return {"ok": True}
        # A reconnect can finish while the old remote disconnect is in
        # flight.  Never delete the freshly-issued local pointer in that
        # case; the caller can retry against the new connection if needed.
        if (
            current.remote_connection_id != remote_connection_id
            or current.access_token_encrypted != encrypted_token
        ):
            raise ValueError("This connector changed while it was being disconnected. Try again.")
        ConnectorSyncRun.objects.filter(connection=current, status__in=ACTIVE_STATUSES).update(
            status=ConnectorSyncRun.Status.CANCELLED,
            finished_at=timezone.now(),
            error="Connection was disconnected",
            claim_token=None,
        )
        current.delete()
    record_event(user, user, "connection", "disconnected", name=connection.provider_key)
    return {"ok": True}


def _validate_documents_page(body: object) -> JsonObject:
    if not isinstance(body, dict):
        raise SupplierDocumentsInvalid("Connector page was malformed")
    expected = {"pageId", "documents", "done", "nextCursor", "progress"}
    if set(body) != expected:
        raise SupplierDocumentsInvalid("Connector page was malformed")
    page_id = body["pageId"]
    documents = body["documents"]
    if not isinstance(page_id, str) or not page_id or len(page_id) > 128:
        raise SupplierDocumentsInvalid("Connector page was malformed")
    if not isinstance(documents, list) or len(documents) > 40:
        raise SupplierDocumentsInvalid("Connector page was malformed")
    if not isinstance(body["done"], bool):
        raise SupplierDocumentsInvalid("Connector page was malformed")
    if body["done"]:
        if body["nextCursor"] is not None:
            raise SupplierDocumentsInvalid("Connector page was malformed")
    elif not isinstance(body["nextCursor"], dict):
        raise SupplierDocumentsInvalid("Connector page was malformed")
    total_lines = 0
    normalized: list[JsonObject] = []
    document_types = {"invoice", "credit_memo", "receipt", "refund"}
    for document in documents:
        if not isinstance(document, dict) or set(document) != {
            "supplier", "supplierName", "documentType", "invoiceNumber", "invoiceDate",
            "totalCents", "currencyCode", "fileName", "lines",
        }:
            raise SupplierDocumentsInvalid("Connector document was malformed")
        if (
            not isinstance(document["supplier"], str)
            or not document["supplier"]
            or len(document["supplier"]) > 64
            or PROVIDER_KEY_RE.fullmatch(document["supplier"]) is None
            or not isinstance(document["supplierName"], str)
            or not document["supplierName"]
            or len(document["supplierName"]) > 120
            or document["documentType"] not in document_types
            or not isinstance(document["invoiceNumber"], str)
            or len(document["invoiceNumber"]) > 64
            or not isinstance(document["invoiceDate"], str)
            or not isinstance(document["totalCents"], int)
            or isinstance(document["totalCents"], bool)
            or abs(document["totalCents"]) > MAX_CENTS
            or not isinstance(document["currencyCode"], str)
            or len(document["currencyCode"]) != 3
            or not document["currencyCode"].isupper()
            or not document["currencyCode"].isalpha()
            or not isinstance(document["fileName"], str)
            or not document["fileName"]
            or len(document["fileName"]) > 255
            or not isinstance(document["lines"], list)
        ):
            raise SupplierDocumentsInvalid("Connector document was malformed")
        try:
            date.fromisoformat(document["invoiceDate"])
        except ValueError as exc:
            raise SupplierDocumentsInvalid("Connector document was malformed") from exc
        lines: list[JsonObject] = []
        for line in document["lines"]:
            if not isinstance(line, dict) or set(line) - {
                "sku", "description", "quantity", "unit", "packSize", "unitPriceCents",
                "lineAmountCents", "sourcePayload",
            } or "description" not in line or "lineAmountCents" not in line:
                raise SupplierDocumentsInvalid("Connector document line was malformed")
            if not isinstance(line["description"], str) or not line["description"] or len(line["description"]) > 240:
                raise SupplierDocumentsInvalid("Connector document line was malformed")
            if not isinstance(line["lineAmountCents"], int) or isinstance(line["lineAmountCents"], bool):
                raise SupplierDocumentsInvalid("Connector document line was malformed")
            if abs(line["lineAmountCents"]) > MAX_CENTS:
                raise SupplierDocumentsInvalid("Connector document line was malformed")
            for key, maximum in (("sku", 120), ("unit", 32), ("packSize", 120)):
                value = line.get(key)
                if value is not None and (not isinstance(value, str) or len(value) > maximum):
                    raise SupplierDocumentsInvalid("Connector document line was malformed")
            quantity = line.get("quantity")
            if quantity is not None and (
                not isinstance(quantity, (int, float))
                or isinstance(quantity, bool)
                or not math.isfinite(quantity)
                or abs(quantity) > 1_000_000
            ):
                raise SupplierDocumentsInvalid("Connector document line was malformed")
            unit_price = line.get("unitPriceCents")
            if unit_price is not None and (
                not isinstance(unit_price, int)
                or isinstance(unit_price, bool)
                or abs(unit_price) > MAX_CENTS
            ):
                raise SupplierDocumentsInvalid("Connector document line was malformed")
            if "sourcePayload" in line and not isinstance(line["sourcePayload"], dict):
                raise SupplierDocumentsInvalid("Connector document line was malformed")
            lines.append({**line, "needsReview": True})
        total_lines += len(lines)
        normalized.append({**document, "currencyCode": document["currencyCode"].upper(), "lines": lines})
    if total_lines > 500:
        raise SupplierDocumentsInvalid("Connector page has too many document lines")
    return {
        "pageId": page_id,
        "documents": normalized,
        "done": body["done"],
        "nextCursor": body["nextCursor"],
        "progress": _progress(body["progress"]),
    }


def _claim_next_run() -> tuple[ConnectorSyncRun, uuid.UUID] | None:
    now = timezone.now()
    with transaction.atomic():
        ConnectorSyncRun.objects.filter(
            status=ConnectorSyncRun.Status.RUNNING,
            heartbeat_at__lt=now - RUN_STALE_AFTER,
        ).update(
            status=ConnectorSyncRun.Status.QUEUED,
            claim_token=None,
            available_at=now,
            error="",
        )
        run = (
            ConnectorSyncRun.objects.select_for_update()
            .filter(status=ConnectorSyncRun.Status.QUEUED, available_at__lte=now)
            .select_related("connection", "user")
            .order_by("created_at")
            .first()
        )
        if run is None:
            return None
        token = uuid.uuid4()
        run.status = ConnectorSyncRun.Status.RUNNING
        run.claim_token = token
        run.started_at = run.started_at or now
        run.heartbeat_at = now
        run.attempts += 1
        run.save(update_fields=["status", "claim_token", "started_at", "heartbeat_at", "attempts", "updated_at"])
        return run, token


def _finish(run: ConnectorSyncRun, claim: uuid.UUID, *, status: str, error: str = "") -> None:
    ConnectorSyncRun.objects.filter(
        id=run.id, status=ConnectorSyncRun.Status.RUNNING, claim_token=claim
    ).update(
        status=status,
        error=error,
        finished_at=timezone.now() if status != ConnectorSyncRun.Status.QUEUED else None,
        claim_token=None,
        updated_at=timezone.now(),
    )


def _requeue_while_remote_runs(run: ConnectorSyncRun, claim: uuid.UUID) -> None:
    ConnectorSyncRun.objects.filter(
        id=run.id, status=ConnectorSyncRun.Status.RUNNING, claim_token=claim
    ).update(
        status=ConnectorSyncRun.Status.QUEUED,
        claim_token=None,
        available_at=timezone.now() + REMOTE_POLL_AFTER,
        error="",
        updated_at=timezone.now(),
    )


def _set_connection_error_for_claim(
    run: ConnectorSyncRun,
    claim: uuid.UUID,
    *,
    last_error: str,
    last_error_code: str,
    status: str | None = None,
) -> None:
    """Update connection state only while this exact run still owns it.

    Reconnect and disconnect cancel active runs before changing or deleting
    their connection.  Acquiring the connection first gives those actions and
    this worker one lock order, then the claim check fences responses which
    returned after the user changed credentials.
    """
    with transaction.atomic():
        connection = (
            ConnectorConnection.objects.select_for_update()
            .filter(pk=run.connection_id, user_id=run.user_id)
            .first()
        )
        if connection is None:
            return
        if not ConnectorSyncRun.objects.select_for_update().filter(
            id=run.id,
            connection_id=connection.id,
            status=ConnectorSyncRun.Status.RUNNING,
            claim_token=claim,
        ).exists():
            return
        fields: dict[str, object] = {
            "last_error": last_error,
            "last_error_code": last_error_code,
        }
        if status is not None:
            fields["status"] = status
        ConnectorConnection.objects.filter(pk=connection.pk).update(**fields)


def _retry_transient_failure(
    run: ConnectorSyncRun, claim: uuid.UUID, *, message: str
) -> bool:
    progress = dict(run.progress) if isinstance(run.progress, dict) else {}
    failures = progress.get("serviceFailures", 0)
    failures = failures if isinstance(failures, int) and not isinstance(failures, bool) else 0
    failures += 1
    if failures >= MAX_TRANSIENT_FAILURES:
        return False
    progress["serviceFailures"] = failures
    ConnectorSyncRun.objects.filter(
        id=run.id, status=ConnectorSyncRun.Status.RUNNING, claim_token=claim
    ).update(
        status=ConnectorSyncRun.Status.QUEUED,
        claim_token=None,
        available_at=timezone.now() + timedelta(seconds=2**failures),
        progress=progress,
        error=message,
        updated_at=timezone.now(),
    )
    return True


def _ack_pending_page(
    run: ConnectorSyncRun, claim: uuid.UUID, token: str
) -> bool:
    """Ack one durably committed page, retaining it for safe retry on failure.

    Returns true when this worker has completed its claim.  A transient ack
    failure is deliberately requeued rather than failed: the service is free
    to replay the page, but Forkluck already committed it.
    """
    if not run.pending_page_id:
        return False
    page_id = run.pending_page_id
    try:
        connectors.acknowledge_page(
            subject_id=str(run.user_id),
            run_id=run.remote_run_id,
            page_id=page_id,
            token=token,
        )
    except connectors.ConnectorUnauthorized:
        raise
    except connectors.ConnectorError:
        if _retry_transient_failure(
            run, claim, message="Awaiting connector page acknowledgement"
        ):
            return True
        raise
    with transaction.atomic():
        connection = (
            ConnectorConnection.objects.select_for_update()
            .filter(pk=run.connection_id, user_id=run.user_id)
            .first()
        )
        if connection is None:
            return True
        current = (
            ConnectorSyncRun.objects.select_for_update()
            .filter(id=run.id, connection=connection)
            .first()
        )
        if current is None:
            return True
        if (
            current.status != ConnectorSyncRun.Status.RUNNING
            or current.claim_token != claim
            or current.pending_page_id != page_id
        ):
            return True
        current.acknowledged_page_id = page_id
        final_page = current.pending_page_is_final
        current.pending_page_id = ""
        current.pending_page_is_final = False
        current.error = ""
        current.claim_token = None
        if final_page:
            current.status = ConnectorSyncRun.Status.SUCCEEDED
            current.finished_at = timezone.now()
            connection.last_synced_at = timezone.now()
            connection.last_error = ""
            connection.last_error_code = ""
            connection.save(
                update_fields=["last_synced_at", "last_error", "last_error_code", "updated_at"]
            )
        else:
            current.status = ConnectorSyncRun.Status.QUEUED
            current.available_at = timezone.now()
        current.save()
    return True


def process_next_run() -> bool:
    claimed = _claim_next_run()
    if claimed is None:
        return False
    run, claim = claimed
    connection = run.connection
    try:
        token = decrypt_token(connection.access_token_encrypted)
        if not run.remote_run_id:
            remote = connectors.create_run(
                subject_id=str(run.user_id),
                connection_id=connection.remote_connection_id,
                token=token,
                idempotency_key=str(run.id),
            )
            remote_run_id = remote.get("runId")
            if not isinstance(remote_run_id, str) or not remote_run_id or len(remote_run_id) > 128:
                raise connectors.ConnectorError("Connector service returned an invalid sync run")
            updated = ConnectorSyncRun.objects.filter(id=run.id, claim_token=claim).update(
                remote_run_id=remote_run_id, heartbeat_at=timezone.now()
            )
            if not updated:
                return True
            run.remote_run_id = remote_run_id
        remote_status = connectors.run_status(
            subject_id=str(run.user_id), run_id=run.remote_run_id, token=token
        ).get("status")
        if remote_status in {"queued", "running"}:
            _requeue_while_remote_runs(run, claim)
            return True
        if remote_status == "failed":
            raise connectors.ConnectorError("Connector service could not complete the sync")
        if remote_status != "succeeded":
            raise connectors.ConnectorError("Connector service returned an invalid sync status")
        # A previous transaction can have committed documents but lost its
        # acknowledgement response. Always settle that durable pending page
        # before asking the service for the next cursor.
        if _ack_pending_page(run, claim, token):
            return True
        page = _validate_documents_page(
            connectors.next_page(
                subject_id=str(run.user_id), run_id=run.remote_run_id, token=token, cursor=run.cursor
            )
        )
        # The importer is nested in this transaction. Cursor persistence and
        # invoice writes therefore either both commit or both replay.
        with transaction.atomic():
            current = (
                ConnectorSyncRun.objects.select_for_update()
                .filter(id=run.id)
                .first()
            )
            if current is None:
                return True
            if current.status != ConnectorSyncRun.Status.RUNNING or current.claim_token != claim:
                return True
            currency = (
                BenchCostSettings.objects.filter(user_id=run.user_id)
                .values_list("currency_code", flat=True)
                .first()
                or "USD"
            )
            result = action_import_invoices(
                run.user,
                {
                    "invoices": page["documents"],
                    "reviewedCurrencyCode": currency,
                    "source": "connector",
                },
            ) if page["documents"] else {"invoices": 0, "duplicates": [], "lines": 0}
            prior = _progress(current.progress)
            prior["pagesDone"] += 1
            prior["documentsSeen"] += len(page["documents"])
            prior["documentsImported"] += int(result["invoices"])
            prior["documentsSkipped"] += len(result["duplicates"])
            prior["linesNeedingReview"] += int(result["lines"])
            current.cursor = page["nextCursor"] or {}
            current.pending_page_id = page["pageId"]
            current.pending_page_is_final = page["done"]
            current.progress = prior
            current.heartbeat_at = timezone.now()
            current.save()
            run.pending_page_id = page["pageId"]
            run.pending_page_is_final = page["done"]
        _ack_pending_page(run, claim, token)
    except connectors.ConnectorUnauthorized:
        _set_connection_error_for_claim(
            run,
            claim,
            last_error="Connector authorization was rejected. Reconnect this supplier.",
            last_error_code="authorization_rejected",
            status=ConnectorConnection.Status.NEEDS_RECONNECT,
        )
        _finish(run, claim, status=ConnectorSyncRun.Status.FAILED, error="Connector authorization was rejected")
    except connectors.ConnectorError:
        if _retry_transient_failure(
            run, claim, message="Connector service request will be retried"
        ):
            return True
        _set_connection_error_for_claim(
            run,
            claim,
            last_error="Connector service request failed after retries",
            last_error_code="service_error",
        )
        _finish(
            run,
            claim,
            status=ConnectorSyncRun.Status.FAILED,
            error="Connector service request failed after retries",
        )
    except (SupplierDocumentsInvalid, ValueError) as exc:
        _set_connection_error_for_claim(
            run,
            claim,
            last_error=str(exc),
            last_error_code="invalid_document" if isinstance(exc, SupplierDocumentsInvalid) else "service_error",
        )
        _finish(run, claim, status=ConnectorSyncRun.Status.FAILED, error=str(exc))
    return True


ACTIONS = {
    "connect-connector": action_connect_connector,
    "complete-connector-authorization": action_complete_connector_authorization,
    "enqueue-connector-sync": action_enqueue_connector_sync,
    "disconnect-connector": action_disconnect_connector,
}
