"""HTTP boundary and object ownership checks for the connector protocol."""

import base64
import json
import secrets
from functools import wraps

from django.conf import settings
from django.db import IntegrityError, transaction
from django.http import JsonResponse
from django.utils import timezone

from .models import ConnectorConnection, RateLimitBucket, ServiceClient


def error(code: str, message: str, status: int = 400):
    return JsonResponse({"error": {"code": code, "message": message}}, status=status)


def request_json(request):
    try:
        value = json.loads(request.body or b"{}")
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("Request body must be a JSON object")
    if not isinstance(value, dict):
        raise ValueError("Request body must be a JSON object")
    return value


def _basic_client(request):
    raw = request.headers.get("Authorization", "")
    if not raw.startswith("Basic "):
        return None
    try:
        client_id, secret = (
            base64.b64decode(raw[6:], validate=True).decode().split(":", 1)
        )
    except (ValueError, UnicodeDecodeError):
        return None
    client = ServiceClient.objects.filter(client_id=client_id, active=True).first()
    return client if client and client.verify_secret(secret) else None


def client_required(view):
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        client = _basic_client(request)
        if client is None:
            return error("invalid_client", "Client authentication failed", 401)
        subject_id = request.headers.get("X-Forkluck-Subject", "").strip()
        if not subject_id or len(subject_id) > 128:
            return error(
                "invalid_subject", "A valid X-Forkluck-Subject is required", 400
            )
        if (
            settings.CONNECTORS_ALLOWED_SUBJECTS
            and subject_id not in settings.CONNECTORS_ALLOWED_SUBJECTS
        ):
            return error(
                "subject_not_allowed",
                "This account is not enabled for hosted connectors",
                403,
            )
        return view(request, *args, client=client, subject_id=subject_id, **kwargs)

    return wrapped


def metrics_client_required(view):
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        if _basic_client(request) is None:
            return error("invalid_client", "Client authentication failed", 401)
        return view(request, *args, **kwargs)

    return wrapped


def provider_allowed(provider_key, subject_id):
    allowed = settings.CONNECTORS_PROVIDER_ALLOWLIST.get(provider_key)
    if not isinstance(allowed, list):
        return False
    # "*" opens a provider to every subject; the global CONNECTORS_ALLOWED_SUBJECTS
    # gate in client_required still applies first.
    return "*" in allowed or subject_id in allowed


def connection_required(view=None, *, require_provider=True):
    def decorate(view):
        @wraps(view)
        @client_required
        def wrapped(request, *args, client, subject_id, **kwargs):
            connection_id = kwargs.get("connection_id")
            if connection_id is None and "run_id" in kwargs:
                from .models import ConnectorRun

                run = (
                    ConnectorRun.objects.select_related("connection")
                    .filter(pk=kwargs["run_id"])
                    .first()
                )
                if run is None:
                    return error("not_found", "Run was not found", 404)
                connection_id = run.connection_id
            connection = ConnectorConnection.objects.filter(
                pk=connection_id, client=client, subject_id=subject_id
            ).first()
            if connection is None:
                return error("not_found", "Connection was not found", 404)
            if require_provider and not provider_allowed(
                connection.provider_key, subject_id
            ):
                return error(
                    "provider_not_allowed",
                    "This connector is not enabled for this account",
                    403,
                )
            token = request.headers.get("X-Forkluck-Connection-Token", "")
            if not token or not connection.verify_token(token):
                return error(
                    "invalid_connection_token", "Connection token is invalid", 401
                )
            kwargs["connection"] = connection
            return view(request, *args, client=client, subject_id=subject_id, **kwargs)

        return wrapped

    return decorate if view is None else decorate(view)


def random_token() -> str:
    return secrets.token_urlsafe(32)


def connection_json(connection):
    return {
        "id": str(connection.id),
        "providerKey": connection.provider_key,
        "status": connection.status,
        "lastError": connection.last_error or None,
        "updatedAt": connection.updated_at.isoformat(),
    }


def run_json(run):
    return {
        "runId": str(run.id),
        "status": run.status,
        "progress": run.progress,
        "error": run.error or None,
    }


def now():
    return timezone.now()


def rate_limit(client, subject_id, provider_key, operation, maximum):
    """Return false when this tuple exceeded its shared current-minute budget."""
    current = now().replace(second=0, microsecond=0)
    try:
        with transaction.atomic():
            bucket, _ = RateLimitBucket.objects.select_for_update().get_or_create(
                client=client,
                subject_id=subject_id,
                provider_key=provider_key,
                operation=operation,
                window_started=current,
            )
            if bucket.count >= maximum:
                return False
            bucket.count += 1
            bucket.save(update_fields=["count"])
            return True
    except IntegrityError:
        # A concurrent first request races only on a fresh minute; retry against
        # the now-created row instead of allowing an unbounded burst.
        return rate_limit(client, subject_id, provider_key, operation, maximum)
