"""Small authenticated client for the separately deployed connector service.

This module deliberately knows only the public `supplier_documents:v1`
protocol. Supplier web sessions, passwords and provider-specific acquisition
belong to the connector service and never cross this import boundary.
"""

import base64
import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from django.conf import settings

logger = logging.getLogger(__name__)


class ConnectorError(Exception):
    """The connector service was unavailable or returned malformed data."""


class ConnectorUnauthorized(ConnectorError):
    """The service rejected a client, subject, or opaque connection token."""


class ConnectorConflict(ConnectorError):
    """The requested authorization or cursor is no longer valid."""


def configured() -> bool:
    return bool(
        settings.FORKLUCK_CONNECTOR_SERVICE_URL
        and settings.FORKLUCK_CONNECTOR_CLIENT_ID
        and settings.FORKLUCK_CONNECTOR_CLIENT_SECRET
    )


def _base_url() -> str:
    value = settings.FORKLUCK_CONNECTOR_SERVICE_URL.rstrip("/")
    if not value:
        raise ConnectorError("Supplier connectors are not configured")
    parsed = urllib.parse.urlsplit(value)
    local_http = parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}
    if parsed.scheme not in {"https", "http"} or not parsed.netloc or (
        parsed.scheme != "https" and not local_http
    ):
        raise ConnectorError("Connector service URL must use HTTPS")
    return value


def _request(
    path: str,
    *,
    subject_id: str,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    token: str | None = None,
) -> dict[str, Any]:
    credentials = (
        f"{settings.FORKLUCK_CONNECTOR_CLIENT_ID}:"
        f"{settings.FORKLUCK_CONNECTOR_CLIENT_SECRET}"
    ).encode()
    headers = {
        "Accept": "application/json",
        "Authorization": f"Basic {base64.b64encode(credentials).decode()}",
        "X-Forkluck-Subject": subject_id,
        "User-Agent": "forkluck-backend/1.0",
    }
    if token:
        headers["X-Forkluck-Connection-Token"] = token
    if payload is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        f"{_base_url()}{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        # Never log response content: upstream services may include a
        # provider-specific diagnostic in it.
        if exc.code in {401, 403}:
            raise ConnectorUnauthorized("Connector authorization was rejected") from exc
        if exc.code == 409:
            raise ConnectorConflict("Connector state has changed; try again") from exc
        logger.warning("Connector %s %s failed with %s", method, path, exc.code)
        raise ConnectorError("Connector service request failed") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        logger.warning("Connector %s %s could not be reached: %s", method, path, exc)
        raise ConnectorError("Connector service could not be reached") from exc
    try:
        decoded = json.loads(raw or b"{}")
    except json.JSONDecodeError as exc:
        raise ConnectorError("Connector service returned unreadable JSON") from exc
    if not isinstance(decoded, dict):
        raise ConnectorError("Connector service returned malformed JSON")
    return decoded


def providers(*, subject_id: str) -> list[dict[str, Any]]:
    body = _request("/v1/providers", subject_id=subject_id)
    rows = body.get("providers")
    if not isinstance(rows, list):
        raise ConnectorError("Connector provider list was malformed")
    return rows


def create_authorization_session(
    *, subject_id: str, provider_key: str, state: str, callback_url: str
) -> dict[str, Any]:
    return _request(
        "/v1/authorization-sessions",
        subject_id=subject_id,
        method="POST",
        payload={
            "providerKey": provider_key,
            "state": state,
            "callbackUrl": callback_url,
        },
    )


def exchange_authorization_code(
    *, subject_id: str, session_id: str, state: str, code: str
) -> dict[str, Any]:
    return _request(
        "/v1/authorization-codes/exchange",
        subject_id=subject_id,
        method="POST",
        payload={"sessionId": session_id, "state": state, "code": code},
    )


def disconnect(*, subject_id: str, connection_id: str, token: str) -> None:
    _request(
        f"/v1/connections/{urllib.parse.quote(connection_id, safe='')}",
        subject_id=subject_id,
        method="DELETE",
        token=token,
    )


def create_run(
    *, subject_id: str, connection_id: str, token: str, idempotency_key: str
) -> dict[str, Any]:
    return _request(
        "/v1/runs",
        subject_id=subject_id,
        method="POST",
        token=token,
        payload={"connectionId": connection_id, "idempotencyKey": idempotency_key},
    )


def run_status(*, subject_id: str, run_id: str, token: str) -> dict[str, Any]:
    return _request(
        f"/v1/runs/{urllib.parse.quote(run_id, safe='')}",
        subject_id=subject_id,
        token=token,
    )


def next_page(
    *, subject_id: str, run_id: str, token: str, cursor: dict[str, Any]
) -> dict[str, Any]:
    return _request(
        f"/v1/runs/{urllib.parse.quote(run_id, safe='')}/pages/next",
        subject_id=subject_id,
        method="POST",
        token=token,
        payload={"cursor": cursor},
    )


def acknowledge_page(
    *, subject_id: str, run_id: str, page_id: str, token: str
) -> None:
    _request(
        "/v1/runs/"
        f"{urllib.parse.quote(run_id, safe='')}/pages/"
        f"{urllib.parse.quote(page_id, safe='')}/ack",
        subject_id=subject_id,
        method="POST",
        token=token,
        payload={},
    )
