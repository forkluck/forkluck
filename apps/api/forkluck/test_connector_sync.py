"""Real-HTTP tests for the public supplier connector client and durable import."""

import base64
import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from django.db import close_old_connections, connection as db_connection
from django.test import Client, override_settings
from django.test import TransactionTestCase
from django.utils import timezone

from .domains.invoices import connector_sync, views as invoice_views
from .integrations import connectors
from .integrations.token_crypto import decrypt_token, encrypt_token
from .models import (
    ConnectorAuthorizationSession,
    ConnectorConnection,
    ConnectorSyncRun,
    Invoice,
    User,
)
from .testing import InternalApiTestCase, internal_payload


class FakeConnectorService:
    """A real HTTP `acme` service; no application code is mocked across HTTP."""

    subject_id = ""
    fail_next_ack = False
    acknowledgements: list[str] = []
    requests: list[tuple[str, str, dict]] = []
    malformed_page = False
    run_status = "succeeded"
    malformed_provider = False
    missing_cursor = False

    @classmethod
    def reset(cls, subject_id: str) -> None:
        cls.subject_id = subject_id
        cls.fail_next_ack = False
        cls.acknowledgements = []
        cls.requests = []
        cls.malformed_page = False
        cls.run_status = "succeeded"
        cls.malformed_provider = False
        cls.missing_cursor = False

    @classmethod
    def handler(cls):
        service = cls

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):  # noqa: A002
                return

            def _body(self):
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length)
                return json.loads(raw or b"{}")

            def _reply(self, status: int, body: dict) -> None:
                encoded = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def _authorized(self) -> bool:
                auth = self.headers.get("Authorization", "")
                subject = self.headers.get("X-Forkluck-Subject", "")
                expected = "Basic " + base64.b64encode(b"public-app:public-secret").decode()
                return auth == expected and subject == service.subject_id

            def do_GET(self):  # noqa: N802
                if not self._authorized():
                    self._reply(403, {})
                    return
                service.requests.append(("GET", self.path, {}))
                if self.path == "/v1/providers":
                    if service.malformed_provider:
                        self._reply(200, {"providers": [{"key": "acme"}]})
                        return
                    self._reply(
                        200,
                        {
                            "providers": [
                                {
                                    "key": "acme",
                                    "displayName": "Acme Produce",
                                    "description": "Synthetic local connector",
                                    "icon": "acme",
                                    "capabilities": ["invoices", "credit_memos"],
                                    "available": True,
                                }
                            ]
                        },
                    )
                    return
                if self.path == "/v1/runs/run-acme":
                    self._reply(
                        200,
                        {"runId": "run-acme", "status": service.run_status, "progress": {}},
                    )
                    return
                self._reply(404, {})

            def do_POST(self):  # noqa: N802
                if not self._authorized():
                    self._reply(403, {})
                    return
                body = self._body()
                service.requests.append(("POST", self.path, body))
                if self.path == "/v1/authorization-sessions":
                    self._reply(
                        200,
                        {
                            "sessionId": "session-acme",
                            "authorizationUrl": f"http://{self.headers['Host']}/authorize/acme",
                            "expiresAt": (timezone.now() + timedelta(minutes=10)).isoformat(),
                        },
                    )
                    return
                if self.path == "/v1/authorization-codes/exchange":
                    self._reply(
                        200,
                        {
                            "connectionId": "connection-acme",
                            "providerKey": "acme",
                            "accessToken": "opaque-acme-token",
                            "status": "connected",
                        },
                    )
                    return
                if self.path == "/v1/runs":
                    self._reply(200, {"runId": "run-acme"})
                    return
                if self.path == "/v1/runs/run-acme/pages/next":
                    if service.malformed_page:
                        self._reply(200, {"bad": True})
                    else:
                        next_cursor = None if service.missing_cursor else {"page": 2}
                        self._reply(
                            200,
                            {
                                "pageId": "page-acme-1",
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
                                        "lines": [
                                            {
                                                "sku": "apple-1",
                                                "description": "Apples",
                                                "quantity": 2,
                                                "unit": "case",
                                                "packSize": "10 lb",
                                                "unitPriceCents": 617,
                                                "lineAmountCents": 1234,
                                                "sourcePayload": {},
                                            }
                                        ],
                                    }
                                ],
                                "done": service.missing_cursor is False,
                                "nextCursor": next_cursor if service.missing_cursor else None,
                                "progress": {},
                            },
                        )
                    return
                if self.path == "/v1/runs/run-acme/pages/page-acme-1/ack":
                    if service.fail_next_ack:
                        service.fail_next_ack = False
                        self._reply(503, {})
                        return
                    service.acknowledgements.append("page-acme-1")
                    self._reply(200, {})
                    return
                self._reply(404, {})

            def do_DELETE(self):  # noqa: N802
                if not self._authorized():
                    self._reply(403, {})
                    return
                service.requests.append(("DELETE", self.path, {}))
                self._reply(200, {})

        return Handler


class ConnectorSyncTests(InternalApiTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeConnectorService.handler())
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join()
        cls.server.server_close()
        super().tearDownClass()

    def setUp(self):
        self.user = User.objects.create_user(
            email="connector@example.com", name="Connector Chef", password="a-long-passphrase-123"
        )
        self.client = Client()
        self.client.force_login(self.user)
        FakeConnectorService.reset(str(self.user.id))
        self.settings = override_settings(
            FORKLUCK_CONNECTOR_SERVICE_URL=f"http://127.0.0.1:{self.server.server_port}",
            FORKLUCK_CONNECTOR_CLIENT_ID="public-app",
            FORKLUCK_CONNECTOR_CLIENT_SECRET="public-secret",
        )
        self.settings.enable()
        self.addCleanup(self.settings.disable)

    def _connect(self) -> ConnectorConnection:
        started = self.post_internal("connect-connector", {"providerKey": "acme"})
        self.assertEqual(started.status_code, 200, started.content)
        state = connector_sync.ConnectorAuthorizationSession.objects.get(user=self.user).state
        completed = self.post_internal(
            "complete-connector-authorization", {"state": state, "code": "code-acme"}
        )
        self.assertEqual(completed.status_code, 200, completed.content)
        return ConnectorConnection.objects.get(user=self.user, provider_key="acme")

    def test_real_http_flow_imports_and_acknowledges_a_final_page(self):
        connection = self._connect()
        queued = self.post_internal("enqueue-connector-sync", {"connectionId": str(connection.id)})
        self.assertEqual(queued.status_code, 200, queued.content)

        self.assertTrue(connector_sync.process_next_run())

        run = ConnectorSyncRun.objects.get(connection=connection)
        self.assertEqual(run.status, ConnectorSyncRun.Status.SUCCEEDED)
        self.assertEqual(run.acknowledged_page_id, "page-acme-1")
        self.assertEqual(run.pending_page_id, "")
        self.assertEqual(FakeConnectorService.acknowledgements, ["page-acme-1"])
        invoice = Invoice.objects.get(user=self.user)
        self.assertEqual(invoice.source, "connector")
        self.assertEqual(invoice.supplier, "acme")
        self.assertEqual(invoice.unresolved_line_count, 1)

    def test_lost_final_ack_is_durably_retried_without_duplicate_import(self):
        connection = self._connect()
        self.post_internal("enqueue-connector-sync", {"connectionId": str(connection.id)})
        FakeConnectorService.fail_next_ack = True

        self.assertTrue(connector_sync.process_next_run())
        run = ConnectorSyncRun.objects.get(connection=connection)
        self.assertEqual(run.status, ConnectorSyncRun.Status.QUEUED)
        self.assertEqual(run.pending_page_id, "page-acme-1")
        self.assertEqual(Invoice.objects.filter(user=self.user).count(), 1)

        run.available_at = timezone.now()
        run.save(update_fields=["available_at"])
        self.assertTrue(connector_sync.process_next_run())
        run.refresh_from_db()
        self.assertEqual(run.status, ConnectorSyncRun.Status.SUCCEEDED)
        self.assertEqual(run.pending_page_id, "")
        self.assertEqual(FakeConnectorService.acknowledgements, ["page-acme-1"])
        self.assertEqual(Invoice.objects.filter(user=self.user).count(), 1)

    def test_malformed_page_fails_without_invoice_write(self):
        connection = self._connect()
        self.post_internal("enqueue-connector-sync", {"connectionId": str(connection.id)})
        FakeConnectorService.malformed_page = True

        connector_sync.process_next_run()

        run = ConnectorSyncRun.objects.get(connection=connection)
        self.assertEqual(run.status, ConnectorSyncRun.Status.FAILED)
        self.assertEqual(Invoice.objects.filter(user=self.user).count(), 0)
        connection.refresh_from_db()
        self.assertEqual(connection.last_error_code, "invalid_document")

    def test_local_worker_waits_for_the_remote_durable_worker(self):
        connection = self._connect()
        self.post_internal("enqueue-connector-sync", {"connectionId": str(connection.id)})
        FakeConnectorService.run_status = "running"

        self.assertTrue(connector_sync.process_next_run())

        run = ConnectorSyncRun.objects.get(connection=connection)
        self.assertEqual(run.status, ConnectorSyncRun.Status.QUEUED)
        self.assertEqual(Invoice.objects.filter(user=self.user).count(), 0)

        FakeConnectorService.run_status = "succeeded"
        run.available_at = timezone.now()
        run.save(update_fields=["available_at"])
        self.assertTrue(connector_sync.process_next_run())
        run.refresh_from_db()
        self.assertEqual(run.status, ConnectorSyncRun.Status.SUCCEEDED)
        self.assertEqual(Invoice.objects.filter(user=self.user).count(), 1)

    def test_missing_cursor_on_a_nonfinal_page_fails_without_importing(self):
        connection = self._connect()
        self.post_internal("enqueue-connector-sync", {"connectionId": str(connection.id)})
        FakeConnectorService.missing_cursor = True

        connector_sync.process_next_run()

        run = ConnectorSyncRun.objects.get(connection=connection)
        self.assertEqual(run.status, ConnectorSyncRun.Status.FAILED)
        self.assertEqual(Invoice.objects.filter(user=self.user).count(), 0)
        connection.refresh_from_db()
        self.assertEqual(connection.last_error_code, "invalid_document")

    def test_authorization_url_must_match_configured_service_origin(self):
        with mock.patch(
            "forkluck.domains.invoices.connector_sync.connectors.create_authorization_session",
            return_value={
                "sessionId": "session-acme",
                "authorizationUrl": "https://connectors.forkluck.com@evil.test/authorize",
            },
        ):
            response = self.post_internal("connect-connector", {"providerKey": "acme"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Connector service returned an invalid authorization URL")

    def test_connect_action_surfaces_a_private_service_rejection_without_a_500(self):
        with mock.patch(
            "forkluck.domains.invoices.connector_sync.connectors.providers",
            side_effect=connectors.ConnectorUnauthorized("Connector authorization was rejected"),
        ):
            response = self.post_internal("connect-connector", {"providerKey": "acme"})

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "connector_unauthorized")
        self.assertEqual(response.json()["error"], "Connector authorization was rejected")

    def test_exchange_conflict_returns_a_retryable_action_error(self):
        started = self.post_internal("connect-connector", {"providerKey": "acme"})
        self.assertEqual(started.status_code, 200, started.content)
        state = connector_sync.ConnectorAuthorizationSession.objects.get(user=self.user).state

        with mock.patch(
            "forkluck.domains.invoices.connector_sync.connectors.exchange_authorization_code",
            side_effect=connectors.ConnectorConflict("Connector state has changed; try again"),
        ):
            response = self.post_internal(
                "complete-connector-authorization", {"state": state, "code": "code-acme"}
            )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "connector_conflict")
        self.assertEqual(response.json()["error"], "Connector state has changed; try again")

    def test_service_rejects_a_subject_not_bound_to_the_client_request(self):
        with self.assertRaises(connectors.ConnectorUnauthorized):
            connectors.providers(subject_id="00000000-0000-0000-0000-000000000000")

    def test_malformed_provider_catalog_degrades_to_an_empty_catalog(self):
        FakeConnectorService.malformed_provider = True

        response = self.get_internal("invoices-overview/")

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            response.json()["connectors"],
            {"configured": True, "providers": [], "connections": []},
        )

    def test_catalog_outage_keeps_existing_connection_visible_and_actionable(self):
        connection = self._connect()

        with mock.patch(
            "forkluck.domains.invoices.connector_sync.connectors.providers",
            side_effect=connectors.ConnectorError("Catalog unavailable"),
        ):
            response = self.get_internal("invoices-overview/")

        self.assertEqual(response.status_code, 200, response.content)
        payload = response.json()["connectors"]
        self.assertEqual(
            payload["providers"],
            [
                {
                    "key": "acme",
                    "displayName": "Supplier connector",
                    "description": "Connector details are temporarily unavailable.",
                    "icon": "cable",
                    "capabilities": [],
                    "available": True,
                }
            ],
        )
        self.assertEqual(payload["connections"][0]["id"], str(connection.id))

    def test_connector_snapshot_query_count_does_not_grow_with_run_history(self):
        for provider_index in range(3):
            connection = ConnectorConnection.objects.create(
                user=self.user,
                provider_key=f"acme-{provider_index}",
                remote_connection_id=f"remote-{provider_index}",
                access_token_encrypted="synthetic-not-read",
                status=ConnectorConnection.Status.CONNECTED,
            )
            for run_index in range(3):
                ConnectorSyncRun.objects.create(
                    user=self.user,
                    connection=connection,
                    status=ConnectorSyncRun.Status.SUCCEEDED,
                    remote_run_id=f"run-{provider_index}-{run_index}",
                )
        with mock.patch(
            "forkluck.domains.invoices.connector_sync.connectors.providers",
            return_value=[],
        ):
            with self.assertNumQueries(
                2,
                msg="Connector connections and all latest-run reads stay two tenant-scoped queries.",
            ):
                payload = connector_sync.connector_payload(self.user)
        self.assertEqual(len(payload["connections"]), 3)

    def test_connector_run_list_names_its_connection_without_a_query_per_row(self):
        connection = ConnectorConnection.objects.create(
            user=self.user,
            provider_key="acme",
            remote_connection_id="remote-list",
            access_token_encrypted="synthetic-not-read",
            status=ConnectorConnection.Status.CONNECTED,
        )
        for run_index in range(3):
            ConnectorSyncRun.objects.create(
                user=self.user,
                connection=connection,
                status=ConnectorSyncRun.Status.SUCCEEDED,
                remote_run_id=f"run-{run_index}",
            )
        with self.assertNumQueries(
            1,
            msg="Naming each run's provider must not re-read its connection per row.",
        ):
            payload = internal_payload(invoice_views.connector_sync_runs, self.user)
        self.assertEqual(len(payload["items"]), 3)
        self.assertEqual({row["providerKey"] for row in payload["items"]}, {"acme"})

    def test_callback_requires_one_scalar_state_and_code(self):
        response = self.client.get(
            "/api/integrations/connectors/callback?state=state-1&code=code-1"
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(
            response["Location"], "/integrations/suppliers/connections?state=state-1&code=code-1"
        )
        malformed = self.client.get(
            "/api/integrations/connectors/callback?state=one&state=two&code=code-1"
        )
        self.assertEqual(malformed.status_code, 302)
        self.assertEqual(
            malformed["Location"], "/integrations/suppliers/connections?connector_error=invalid_callback"
        )


@unittest.skipUnless(
    db_connection.vendor == "postgresql",
    "Connector fencing needs PostgreSQL row-lock semantics",
)
class ConnectorSyncConcurrencyTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        self.user = User.objects.create_user(
            email="connector-race@example.com",
            name="Connector Race",
            password="a-long-test-passphrase-2468",
        )
        self.connection = ConnectorConnection.objects.create(
            user=self.user,
            provider_key="acme",
            remote_connection_id="connection-old",
            access_token_encrypted=encrypt_token("old-token"),
            status=ConnectorConnection.Status.CONNECTED,
        )

    def _run_worker(self):
        close_old_connections()
        try:
            return connector_sync.process_next_run()
        except Exception as exc:  # returned for assertion in the main thread
            return exc
        finally:
            close_old_connections()

    def _active_run(self) -> ConnectorSyncRun:
        return ConnectorSyncRun.objects.create(
            user=self.user,
            connection=self.connection,
            remote_run_id="run-old",
            status=ConnectorSyncRun.Status.QUEUED,
        )

    def test_disconnect_during_provider_io_cancels_without_crashing_the_worker(self):
        run = self._active_run()
        provider_started = threading.Event()
        release_provider = threading.Event()

        def delayed_status(*args, **kwargs):
            provider_started.set()
            if not release_provider.wait(timeout=5):
                raise AssertionError("Disconnect did not release provider call")
            return {"status": "succeeded"}

        page = {
            "pageId": "page-old",
            "documents": [],
            "done": True,
            "nextCursor": None,
            "progress": {},
        }
        with (
            mock.patch(
                "forkluck.domains.invoices.connector_sync.connectors.run_status",
                side_effect=delayed_status,
            ),
            mock.patch(
                "forkluck.domains.invoices.connector_sync.connectors.next_page",
                return_value=page,
            ),
            mock.patch("forkluck.domains.invoices.connector_sync.connectors.disconnect"),
        ):
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(self._run_worker)
                self.assertTrue(provider_started.wait(timeout=5))
                self.assertEqual(
                    connector_sync.action_disconnect_connector(
                        self.user, {"connectionId": str(self.connection.id)}
                    ),
                    {"ok": True},
                )
                release_provider.set()
                result = future.result(timeout=5)

        self.assertEqual(result, True)
        self.assertFalse(ConnectorConnection.objects.filter(pk=self.connection.pk).exists())
        self.assertFalse(ConnectorSyncRun.objects.filter(pk=run.pk).exists())

    def test_reconnect_fences_an_old_unauthorized_run_from_the_fresh_connection(self):
        run = self._active_run()
        provider_started = threading.Event()
        release_provider = threading.Event()

        def delayed_unauthorized(*args, **kwargs):
            provider_started.set()
            if not release_provider.wait(timeout=5):
                raise AssertionError("Reconnect did not release provider call")
            raise connectors.ConnectorUnauthorized("Old token was revoked")

        session = ConnectorAuthorizationSession.objects.create(
            user=self.user,
            provider_key="acme",
            state="state-reconnect",
            remote_session_id="session-reconnect",
            expires_at=timezone.now() + timedelta(minutes=1),
        )
        with (
            mock.patch(
                "forkluck.domains.invoices.connector_sync.connectors.run_status",
                side_effect=delayed_unauthorized,
            ),
            mock.patch(
                "forkluck.domains.invoices.connector_sync.connectors.exchange_authorization_code",
                return_value={
                    "connectionId": "connection-new",
                    "providerKey": "acme",
                    "accessToken": "new-token",
                    "status": "connected",
                },
            ),
        ):
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(self._run_worker)
                self.assertTrue(provider_started.wait(timeout=5))
                connector_sync.action_complete_connector_authorization(
                    self.user, {"state": session.state, "code": "code-reconnect"}
                )
                release_provider.set()
                result = future.result(timeout=5)

        self.assertEqual(result, True)
        run.refresh_from_db()
        self.assertEqual(run.status, ConnectorSyncRun.Status.CANCELLED)
        self.assertEqual(run.error, "Connection was reconnected")
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.remote_connection_id, "connection-new")
        self.assertEqual(decrypt_token(self.connection.access_token_encrypted), "new-token")
        self.assertEqual(self.connection.status, ConnectorConnection.Status.CONNECTED)
        self.assertEqual(self.connection.last_error, "")
