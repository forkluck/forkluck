"""Deterministic, synthetic HTTP implementation of `supplier_documents:v1`.

It is deliberately a separate process for local development and browser
acceptance tests. It contains no supplier-specific code or credentials.
"""

import base64
import json
import secrets
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit


class FakeConnectorStore:
    def __init__(self, *, client_id: str, client_secret: str, failures: set[str]) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.failures = failures
        self.sessions: dict[str, dict[str, str]] = {}
        self.connections: dict[str, dict[str, str]] = {}
        self.runs: dict[str, dict[str, str | bool]] = {}
        self.run_keys: dict[tuple[str, str], str] = {}
        self.ack_failed = False

    def authorized(self, headers, *, needs_token: bool = False) -> tuple[bool, str]:
        expected = "Basic " + base64.b64encode(
            f"{self.client_id}:{self.client_secret}".encode()
        ).decode()
        subject = headers.get("X-Forkluck-Subject", "")
        if headers.get("Authorization") != expected or not subject:
            return False, subject
        if needs_token and not headers.get("X-Forkluck-Connection-Token"):
            return False, subject
        return True, subject


def make_handler(store: FakeConnectorStore):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, format, *args):  # noqa: A002
            return

        def _json(self, status: int, body: dict[str, Any]) -> None:
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _redirect(self, url: str) -> None:
            self.send_response(302)
            self.send_header("Location", url)
            self.end_headers()

        def _body(self) -> dict[str, Any] | None:
            try:
                length = int(self.headers.get("Content-Length", "0"))
                value = json.loads(self.rfile.read(length) or b"{}")
            except (ValueError, json.JSONDecodeError):
                return None
            return value if isinstance(value, dict) else None

        def _authorize(self, *, needs_token: bool = False) -> str | None:
            ok, subject = store.authorized(self.headers, needs_token=needs_token)
            if not ok:
                self._json(403, {"error": "forbidden"})
                return None
            return subject

        def _connection(self, connection_id: str, subject: str) -> dict[str, str] | None:
            connection = store.connections.get(connection_id)
            if (
                connection is None
                or connection["subject"] != subject
                or connection["token"] != self.headers.get("X-Forkluck-Connection-Token")
            ):
                self._json(403, {"error": "forbidden"})
                return None
            return connection

        def _run(self, run_id: str, subject: str) -> dict[str, str | bool] | None:
            run = store.runs.get(run_id)
            connection = store.connections.get(str(run["connection"])) if run else None
            if (
                run is None
                or run["subject"] != subject
                or connection is None
                or connection["token"]
                != self.headers.get("X-Forkluck-Connection-Token")
            ):
                self._json(403, {"error": "forbidden"})
                return None
            return run

        def do_GET(self):  # noqa: N802
            parsed = urlsplit(self.path)
            if parsed.path == "/healthz":
                self._json(200, {"status": "ok"})
                return
            if parsed.path == "/v1/providers":
                if self._authorize() is None:
                    return
                self._json(
                    200,
                    {
                        "providers": [
                            {
                                "key": "acme",
                                "displayName": "Acme Produce",
                                "description": "Synthetic connector for local testing",
                                "icon": "acme",
                                "capabilities": ["invoices", "credit_memos"],
                                "available": "lockout" not in store.failures,
                            }
                        ]
                    },
                )
                return
            if parsed.path == "/authorize/acme":
                state = parse_qs(parsed.query).get("state", [""])[0]
                session = store.sessions.get(state)
                if session is None or "expired_state" in store.failures:
                    self._json(400, {"error": "expired state"})
                    return
                callback = session["callback"]
                separator = "&" if "?" in callback else "?"
                self._redirect(
                    f"{callback}{separator}{urlencode({'state': state, 'code': session['code']})}"
                )
                return
            if parsed.path.startswith("/v1/runs/"):
                subject = self._authorize(needs_token=True)
                if subject is None:
                    return
                run_id = parsed.path.split("/")[3]
                run = self._run(run_id, subject)
                if run is None:
                    return
                self._json(200, {"runId": run_id, "status": "succeeded", "progress": {}})
                return
            self._json(404, {})

        def do_POST(self):  # noqa: N802
            parsed = urlsplit(self.path)
            if parsed.path == "/v1/authorization-sessions":
                subject = self._authorize()
                body = self._body()
                if subject is None or body is None:
                    return
                provider = body.get("providerKey")
                state = body.get("state")
                callback = body.get("callbackUrl")
                if provider != "acme" or not all(isinstance(value, str) and value for value in (state, callback)):
                    self._json(400, {"error": "invalid session"})
                    return
                session_id = f"session_{secrets.token_urlsafe(12)}"
                store.sessions[state] = {
                    "id": session_id,
                    "subject": subject,
                    "callback": callback,
                    "code": f"code_{secrets.token_urlsafe(12)}",
                }
                origin = f"http://{self.headers['Host']}"
                if "callback_origin" in store.failures:
                    origin = "https://evil.example"
                self._json(
                    200,
                    {
                        "sessionId": session_id,
                        "authorizationUrl": f"{origin}/authorize/acme?{urlencode({'state': state})}",
                        "expiresAt": "2099-01-01T00:00:00+00:00",
                    },
                )
                return
            if parsed.path == "/v1/authorization-codes/exchange":
                subject = self._authorize()
                body = self._body()
                if subject is None or body is None:
                    return
                state = body.get("state")
                session = store.sessions.get(state) if isinstance(state, str) else None
                if (
                    session is None
                    or session["subject"] != subject
                    or body.get("sessionId") != session["id"]
                    or body.get("code") != session["code"]
                ):
                    self._json(409, {"error": "invalid code"})
                    return
                if "authorization_rejected" in store.failures:
                    self._json(403, {"error": "rejected"})
                    return
                connection_id = f"connection_{secrets.token_urlsafe(12)}"
                token = f"token_{secrets.token_urlsafe(24)}"
                store.connections[connection_id] = {"subject": subject, "token": token}
                del store.sessions[state]
                self._json(
                    200,
                    {"connectionId": connection_id, "providerKey": "acme", "accessToken": token, "status": "connected"},
                )
                return
            if parsed.path == "/v1/runs":
                subject = self._authorize(needs_token=True)
                body = self._body()
                if subject is None or body is None:
                    return
                connection_id = body.get("connectionId")
                idempotency_key = body.get("idempotencyKey")
                if (
                    not isinstance(connection_id, str)
                    or not isinstance(idempotency_key, str)
                    or not idempotency_key
                    or self._connection(connection_id, subject) is None
                ):
                    return
                bound_key = (subject, idempotency_key)
                existing_run_id = store.run_keys.get(bound_key)
                if existing_run_id is not None:
                    existing = store.runs[existing_run_id]
                    if existing["connection"] != connection_id:
                        self._json(409, {"error": "idempotency conflict"})
                    else:
                        self._json(200, {"runId": existing_run_id})
                    return
                run_id = f"run_{secrets.token_urlsafe(12)}"
                store.runs[run_id] = {"subject": subject, "connection": connection_id, "acked": False}
                store.run_keys[bound_key] = run_id
                self._json(200, {"runId": run_id})
                return
            segments = parsed.path.strip("/").split("/")
            if len(segments) == 5 and segments[:2] == ["v1", "runs"] and segments[3:] == ["pages", "next"]:
                subject = self._authorize(needs_token=True)
                if subject is None:
                    return
                run = self._run(segments[2], subject)
                if run is None:
                    return
                if "transient" in store.failures:
                    self._json(503, {"error": "retry"})
                    return
                if "timeout" in store.failures:
                    time.sleep(16)
                if "malformed" in store.failures:
                    self._json(200, {"malformed": True})
                    return
                self._json(
                    200,
                    {
                        "pageId": "page_acme_1",
                        "documents": [
                            {
                                "supplier": "acme",
                                "supplierName": "Acme Produce",
                                "documentType": "invoice",
                                "invoiceNumber": "ACME-100",
                                "invoiceDate": "2026-08-27",
                                "totalCents": 1234,
                                "currencyCode": "USD",
                                "fileName": "ACME-100",
                                "lines": [{"sku": "apple-1", "description": "Apples", "quantity": 2, "unit": "case", "packSize": "10 lb", "unitPriceCents": 617, "lineAmountCents": 1234, "sourcePayload": {}}],
                            }
                        ],
                        "done": True,
                        "nextCursor": None,
                        "progress": {},
                    },
                )
                return
            if len(segments) == 6 and segments[:2] == ["v1", "runs"] and segments[3] == "pages" and segments[5] == "ack":
                subject = self._authorize(needs_token=True)
                if subject is None:
                    return
                run = self._run(segments[2], subject)
                if run is None:
                    return
                if segments[4] != "page_acme_1":
                    self._json(404, {})
                    return
                if "ack_once" in store.failures and not store.ack_failed:
                    store.ack_failed = True
                    self._json(503, {"error": "retry"})
                    return
                run["acked"] = True
                self._json(200, {})
                return
            self._json(404, {})

        def do_DELETE(self):  # noqa: N802
            subject = self._authorize(needs_token=True)
            if subject is None:
                return
            segments = self.path.strip("/").split("/")
            if len(segments) != 3 or segments[:2] != ["v1", "connections"]:
                self._json(404, {})
                return
            if self._connection(segments[2], subject) is None:
                return
            del store.connections[segments[2]]
            self._json(200, {})

    return Handler


def serve(*, host: str, port: int, client_id: str, client_secret: str, failures: set[str]) -> None:
    server = ThreadingHTTPServer(
        (host, port), make_handler(FakeConnectorStore(client_id=client_id, client_secret=client_secret, failures=failures))
    )
    try:
        server.serve_forever()
    finally:
        server.server_close()
