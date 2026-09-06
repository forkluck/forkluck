import base64
import importlib
import io
import json
import os
import tempfile
import threading
import unittest
from datetime import timedelta
from pathlib import Path
from unittest import mock

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection, connections
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from .crypto import decrypt, encrypt
from .models import (
    AuthorizationCode,
    ConnectorConnection,
    ConnectorRun,
    DocumentPage,
    ServiceClient,
)
from .providers.baldor import BaldorClient, normalize_document
from .services import provider_allowed, random_token
from .worker import execute

KEY = "a" * 64


@override_settings(
    CONNECTORS_ENCRYPTION_KEY=KEY,
    CONNECTORS_PUBLIC_BASE_URL="https://connectors.example.test",
    CONNECTORS_PROVIDER_ALLOWLIST={"baldor": ["user-a"]},
)
class ProtocolTests(TestCase):
    def setUp(self):
        self.secret = "correct horse battery staple"
        self.client_row = ServiceClient.objects.create(
            client_id="forkluck-prod",
            secret_hash=ServiceClient.hash_secret(self.secret),
            redirect_uri="https://app.example.test/api/connectors/callback",
        )
        self.headers = {
            "HTTP_AUTHORIZATION": "Basic "
            + base64.b64encode(f"forkluck-prod:{self.secret}".encode()).decode(),
            "HTTP_X_FORKLUCK_SUBJECT": "user-a",
        }
        self.connection_token = "opaque-token"
        self.connection = ConnectorConnection.objects.create(
            client=self.client_row,
            subject_id="user-a",
            provider_key="baldor",
            credential_encrypted=encrypt('{"username":"person","password":"secret"}'),
            token_hash=ConnectorConnection.hash_token(self.connection_token),
        )

    def request_headers(self, token=True, subject="user-a"):
        return {
            **self.headers,
            "HTTP_X_FORKLUCK_SUBJECT": subject,
            **(
                {"HTTP_X_FORKLUCK_CONNECTION_TOKEN": self.connection_token}
                if token
                else {}
            ),
        }

    def test_credentials_are_aes_gcm_envelopes(self):
        self.assertNotIn("secret", self.connection.credential_encrypted)
        self.assertEqual(
            decrypt(self.connection.credential_encrypted),
            '{"username":"person","password":"secret"}',
        )

    def test_connection_token_cannot_cross_subject_boundary(self):
        response = self.client.get(
            f"/v1/runs/{self._run().id}", **self.request_headers(subject="user-b")
        )
        self.assertEqual(response.status_code, 404)

    def test_connection_token_is_required(self):
        response = self.client.get(
            f"/v1/runs/{self._run().id}", **self.request_headers(token=False)
        )
        self.assertEqual(response.status_code, 401)

    def test_unacknowledged_page_is_replayed_then_ack_is_idempotent(self):
        run = self._run()
        page = DocumentPage.objects.create(
            run=run,
            sequence=1,
            payload={"documents": [self._document()]},
            next_cursor={"complete": True},
        )
        first = self.client.post(
            f"/v1/runs/{run.id}/pages/next",
            data='{"cursor": {}}',
            content_type="application/json",
            **self.request_headers(),
        )
        replay = self.client.post(
            f"/v1/runs/{run.id}/pages/next",
            data='{"cursor": {}}',
            content_type="application/json",
            **self.request_headers(),
        )
        self.assertEqual(first.json()["pageId"], str(page.id))
        self.assertEqual(replay.json()["pageId"], str(page.id))
        self.assertEqual(
            self.client.post(
                f"/v1/runs/{run.id}/pages/{page.id}/ack",
                data="{}",
                content_type="application/json",
                **self.request_headers(),
            ).status_code,
            200,
        )
        self.assertEqual(
            self.client.post(
                f"/v1/runs/{run.id}/pages/{page.id}/ack",
                data="{}",
                content_type="application/json",
                **self.request_headers(),
            ).status_code,
            200,
        )
        exhausted = self.client.post(
            f"/v1/runs/{run.id}/pages/next",
            data='{"cursor": {}}',
            content_type="application/json",
            **self.request_headers(),
        )
        self.assertEqual(exhausted.status_code, 409)
        self.assertEqual(exhausted.json()["error"]["code"], "cursor_consumed")

    def test_acknowledged_cursor_cannot_consume_the_next_page(self):
        run = self._run()
        first = DocumentPage.objects.create(
            run=run,
            sequence=1,
            payload={"documents": [self._document()]},
            next_cursor={"sequence": 2},
        )
        second = DocumentPage.objects.create(
            run=run,
            sequence=2,
            payload={"documents": [self._document()]},
            next_cursor={"complete": True},
        )
        self.client.post(
            f"/v1/runs/{run.id}/pages/{first.id}/ack",
            data="{}",
            content_type="application/json",
            **self.request_headers(),
        )
        stale = self.client.post(
            f"/v1/runs/{run.id}/pages/next",
            data='{"cursor": {}}',
            content_type="application/json",
            **self.request_headers(),
        )
        self.assertEqual(stale.status_code, 409)
        current = self.client.post(
            f"/v1/runs/{run.id}/pages/next",
            data='{"cursor": {"sequence": 2}}',
            content_type="application/json",
            **self.request_headers(),
        )
        self.assertEqual(current.json()["pageId"], str(second.id))

    def test_run_creation_is_idempotent(self):
        payload = {
            "connectionId": str(self.connection.id),
            "idempotencyKey": "stable-run-key",
        }
        first = self.client.post(
            "/v1/runs",
            data=json.dumps(payload),
            content_type="application/json",
            **self.request_headers(),
        )
        second = self.client.post(
            "/v1/runs",
            data=json.dumps(payload),
            content_type="application/json",
            **self.request_headers(),
        )
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.json()["runId"], second.json()["runId"])
        self.assertEqual(
            ConnectorRun.objects.filter(idempotency_key="stable-run-key").count(), 1
        )

    def test_worker_uses_zero_based_supplier_pages(self):
        calls = []

        class ProviderClient(BaldorClient):
            def login(self, username, password):
                calls.append(("login", username, password))

            def invoices(self, from_date, to_date, page):
                calls.append(("invoices", page))
                return {
                    "data": [
                        {
                            "id": "IV26-000001",
                            "attributes": {
                                "relatedCredits": [
                                    {
                                        "id": "CR26-000002",
                                        "date": "2026-08-26 00:00:00",
                                        "amount": "2.50",
                                    }
                                ]
                            },
                        }
                    ],
                    "meta": {"pagination": {"pageCount": 1}},
                }

            def lines(self, document_number, page):
                calls.append(("lines", document_number, page))
                return {"data": [], "meta": {"pagination": {"pageCount": 1}}}

        run = ConnectorRun.objects.create(
            connection=self.connection,
            client=self.client_row,
            subject_id="user-a",
            idempotency_key="worker-run",
        )

        def normalized(row, lines):
            document = self._document()
            document["invoiceNumber"] = row["id"]
            document["documentType"] = (
                "credit_memo" if row["id"].startswith("CR") else "invoice"
            )
            return document

        with (
            mock.patch(
                "connectors.worker.PROVIDERS", {"baldor": {"client": ProviderClient}}
            ),
            mock.patch(
                "connectors.providers.baldor.normalize_document", side_effect=normalized
            ),
        ):
            self.assertTrue(execute(run.id))
        self.assertIn(("invoices", 0), calls)
        self.assertIn(("lines", "IV26-000001", 0), calls)
        self.assertIn(("lines", "CR26-000002", 0), calls)
        self.assertEqual(len(DocumentPage.objects.get(run=run).payload["documents"]), 2)

    def test_worker_rejects_unbounded_invoice_pagination(self):
        class ProviderClient(BaldorClient):
            def login(self, username, password):
                pass

            def invoices(self, from_date, to_date, page):
                return {
                    "data": [],
                    "meta": {"pagination": {"pageCount": 101}},
                }

        run = ConnectorRun.objects.create(
            connection=self.connection,
            client=self.client_row,
            subject_id="user-a",
            idempotency_key="bounded-worker-run",
        )
        with mock.patch(
            "connectors.worker.PROVIDERS", {"baldor": {"client": ProviderClient}}
        ):
            self.assertFalse(execute(run.id))
        run.refresh_from_db()
        self.assertEqual(run.status, ConnectorRun.Status.FAILED)
        self.assertEqual(run.error, "Provider sync failed")

    @override_settings(CONNECTORS_PROVIDER_ALLOWLIST={"synthetic": ["user-a"]})
    def test_worker_accepts_an_independent_provider_and_bounds_delivery_pages(self):
        """An adapter needs no Baldor endpoints, payloads, or document numbers."""
        calls = []
        document = self._document()
        document.update(
            supplier="synthetic",
            supplierName="Synthetic Supplier",
            invoiceNumber="custom/document-A",
        )

        class SyntheticClient:
            def login(self, username, password):
                calls.append((username, password))

            def document_batches(self, from_date, to_date, *, start_page=0):
                calls.append((from_date.isoformat(), to_date.isoformat(), start_page))
                yield []
                yield [dict(document) for _ in range(41)]

        self.connection.provider_key = "synthetic"
        self.connection.save(update_fields=["provider_key"])
        run = ConnectorRun.objects.create(
            connection=self.connection,
            client=self.client_row,
            subject_id="user-a",
            idempotency_key="synthetic-provider",
            cursor={"fromDate": "2026-01-01", "toDate": "2026-02-01"},
        )
        with mock.patch(
            "connectors.worker.PROVIDERS", {"synthetic": {"client": SyntheticClient}}
        ):
            self.assertTrue(execute(run.id))
        run.refresh_from_db()
        pages = list(run.pages.order_by("sequence"))
        self.assertEqual([len(page.payload["documents"]) for page in pages], [40, 1])
        self.assertEqual(pages[0].next_cursor, {"sequence": 2})
        self.assertEqual(pages[1].next_cursor, {"complete": True})
        self.assertEqual(run.progress, {"pagesDone": 2, "documents": 41})
        self.assertEqual(calls, [("person", "secret"), ("2026-01-01", "2026-02-01", 0)])

    def test_worker_empty_sync_has_a_terminal_page(self):
        client = mock.Mock()
        client.document_batches.return_value = iter([[]])
        run = ConnectorRun.objects.create(
            connection=self.connection,
            client=self.client_row,
            subject_id="user-a",
            idempotency_key="empty-provider",
        )
        with mock.patch(
            "connectors.worker.PROVIDERS", {"baldor": {"client": lambda: client}}
        ):
            self.assertTrue(execute(run.id))
        self.assertEqual(run.pages.get().payload, {"documents": []})
        self.assertEqual(run.pages.get().next_cursor, {"complete": True})

    def test_worker_splits_on_total_line_budget(self):
        document = self._document()
        document["lines"] *= 300
        client = mock.Mock()
        client.document_batches.return_value = iter([[document, document]])
        run = ConnectorRun.objects.create(
            connection=self.connection,
            client=self.client_row,
            subject_id="user-a",
            idempotency_key="line-budget",
        )
        with mock.patch(
            "connectors.worker.PROVIDERS", {"baldor": {"client": lambda: client}}
        ):
            self.assertTrue(execute(run.id))
        self.assertEqual(run.pages.count(), 2)
        self.assertEqual([len(p.payload["documents"]) for p in run.pages.all()], [1, 1])

    def test_worker_never_persists_arbitrary_provider_exception_text(self):
        client = mock.Mock()
        client.document_batches.side_effect = RuntimeError(
            "password=synthetic-private-value"
        )
        run = ConnectorRun.objects.create(
            connection=self.connection,
            client=self.client_row,
            subject_id="user-a",
            idempotency_key="provider-error",
        )
        with mock.patch(
            "connectors.worker.PROVIDERS", {"baldor": {"client": lambda: client}}
        ):
            self.assertFalse(execute(run.id))
        run.refresh_from_db()
        self.assertEqual(run.error, "Provider sync failed")
        self.assertEqual(run.status, ConnectorRun.Status.FAILED)
        self.assertEqual(run.pages.count(), 0)

    @override_settings(CONNECTORS_PROVIDER_ALLOWLIST={})
    def test_worker_refuses_revoked_provider_before_contacting_supplier(self):
        client = mock.Mock()
        run = ConnectorRun.objects.create(
            connection=self.connection,
            client=self.client_row,
            subject_id="user-a",
            idempotency_key="revoked-provider",
        )
        with mock.patch("connectors.worker.PROVIDERS", {"baldor": {"client": client}}):
            self.assertFalse(execute(run.id))
        client.assert_not_called()

    def test_partial_pages_are_not_delivered_before_success(self):
        run = self._run()
        DocumentPage.objects.create(
            run=run,
            sequence=1,
            payload={"documents": [self._document()]},
            next_cursor={"sequence": 2},
        )
        for status in (
            ConnectorRun.Status.QUEUED,
            ConnectorRun.Status.RUNNING,
            ConnectorRun.Status.FAILED,
        ):
            with self.subTest(status=status):
                run.status = status
                run.save(update_fields=["status"])
                response = self.client.post(
                    f"/v1/runs/{run.id}/pages/next",
                    data='{"cursor": {}}',
                    content_type="application/json",
                    **self.request_headers(),
                )
                self.assertEqual(response.status_code, 409)
                self.assertNotIn("documents", response.json())

    def test_credit_totals_are_negative_spend(self):
        document = normalize_document(
            {
                "id": "CR26-000002",
                "attributes": {
                    "formattedInvoiceDate": "2026-08-26",
                    "invoiceTotal": "2.50",
                    "isCredit": True,
                },
            },
            [],
        )
        self.assertEqual(document["documentType"], "credit_memo")
        self.assertEqual(document["totalCents"], -250)

    def test_code_exchange_is_single_use_and_bound_to_client_and_subject(self):
        raw_code, token = "one-time-code", "returned-token"
        session = __import__(
            "connectors.models", fromlist=["AuthorizationSession"]
        ).AuthorizationSession.objects.create(
            client=self.client_row,
            subject_id="user-a",
            provider_key="baldor",
            state="s" * 32,
            redirect_uri=self.client_row.redirect_uri,
            expires_at=timezone.now() + timedelta(minutes=10),
        )
        AuthorizationCode.objects.create(
            code_hash=AuthorizationCode.digest(raw_code),
            client=self.client_row,
            subject_id="user-a",
            provider_key="baldor",
            connection=self.connection,
            session=session,
            token_encrypted=encrypt(token),
            expires_at=timezone.now() + timedelta(seconds=60),
        )
        exchange = {
            "code": raw_code,
            "sessionId": str(session.id),
            "state": session.state,
        }
        response = self.client.post(
            "/v1/authorization-codes/exchange",
            data=json.dumps(exchange),
            content_type="application/json",
            **self.headers,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["accessToken"], token)
        self.assertEqual(
            self.client.post(
                "/v1/authorization-codes/exchange",
                data=json.dumps(exchange),
                content_type="application/json",
                **self.headers,
            ).status_code,
            400,
        )
        other = {**self.headers, "HTTP_X_FORKLUCK_SUBJECT": "user-b"}
        self.assertEqual(
            self.client.post(
                "/v1/authorization-codes/exchange",
                data=json.dumps(exchange),
                content_type="application/json",
                **other,
            ).status_code,
            400,
        )

    def test_redirect_uri_is_exact(self):
        response = self.client.post(
            "/v1/authorization-sessions",
            data=json.dumps(
                {
                    "providerKey": "baldor",
                    "state": "x" * 32,
                    "callbackUrl": "https://attacker.example/callback",
                }
            ),
            content_type="application/json",
            **self.headers,
        )
        self.assertEqual(response.status_code, 400)

    def test_stale_run_does_not_block_a_new_manual_run(self):
        stale = self._run()
        stale.status = ConnectorRun.Status.RUNNING
        stale.heartbeat_at = timezone.now() - timedelta(minutes=16)
        stale.save()
        response = self.client.post(
            "/v1/runs",
            data=json.dumps(
                {
                    "connectionId": str(self.connection.id),
                    "idempotencyKey": "replacement-run",
                }
            ),
            content_type="application/json",
            **self.request_headers(),
        )
        self.assertEqual(response.status_code, 201)
        stale.refresh_from_db()
        self.assertEqual(stale.status, ConnectorRun.Status.FAILED)

    def test_public_contract_shapes_and_header_names(self):
        catalog = self.client.get("/v1/providers", **self.headers)
        self.assertEqual(set(catalog.json()), {"providers"})
        self.assertEqual(
            set(catalog.json()["providers"][0]),
            {"key", "displayName", "description", "icon", "capabilities", "available"},
        )
        session = self.client.post(
            "/v1/authorization-sessions",
            data=json.dumps(
                {
                    "providerKey": "baldor",
                    "state": "s" * 32,
                    "callbackUrl": self.client_row.redirect_uri,
                }
            ),
            content_type="application/json",
            **self.headers,
        )
        self.assertEqual(
            set(session.json()), {"sessionId", "authorizationUrl", "expiresAt"}
        )
        run = self.client.post(
            "/v1/runs",
            data=json.dumps(
                {
                    "connectionId": str(self.connection.id),
                    "idempotencyKey": "contract-run",
                }
            ),
            content_type="application/json",
            **self.request_headers(),
        )
        self.assertEqual(set(run.json()), {"runId"})
        remote = self._run()
        DocumentPage.objects.create(
            run=remote,
            sequence=1,
            payload={"documents": [self._document()]},
            next_cursor={"complete": True},
        )
        status = self.client.get(f"/v1/runs/{remote.id}", **self.request_headers())
        self.assertEqual(set(status.json()), {"runId", "status", "progress", "error"})
        page = self.client.post(
            f"/v1/runs/{remote.id}/pages/next",
            data=json.dumps({"cursor": {}}),
            content_type="application/json",
            **self.request_headers(),
        )
        self.assertEqual(
            set(page.json()), {"pageId", "documents", "done", "nextCursor", "progress"}
        )

    def test_create_run_persists_the_supplied_idempotency_key(self):
        response = self.client.post(
            "/v1/runs",
            data=json.dumps(
                {"connectionId": str(self.connection.id), "idempotencyKey": "run-1"}
            ),
            content_type="application/json",
            **self.request_headers(),
        )
        self.assertEqual(response.status_code, 201)
        run = ConnectorRun.objects.get(pk=response.json()["runId"])
        self.assertEqual(run.idempotency_key, "run-1")

    def test_completed_runs_can_create_a_new_run_when_the_idempotency_key_changes(self):
        first = self.client.post(
            "/v1/runs",
            data=json.dumps(
                {"connectionId": str(self.connection.id), "idempotencyKey": "run-1"}
            ),
            content_type="application/json",
            **self.request_headers(),
        )
        self.assertEqual(first.status_code, 201)
        ConnectorRun.objects.filter(pk=first.json()["runId"]).update(
            status=ConnectorRun.Status.SUCCEEDED
        )
        second = self.client.post(
            "/v1/runs",
            data=json.dumps(
                {"connectionId": str(self.connection.id), "idempotencyKey": "run-2"}
            ),
            content_type="application/json",
            **self.request_headers(),
        )
        self.assertEqual(second.status_code, 201)
        self.assertNotEqual(first.json()["runId"], second.json()["runId"])

    @override_settings(CONNECTORS_PROVIDER_ALLOWLIST={"baldor": ["other-user"]})
    def test_allowlist_revocation_blocks_status_and_pages_but_not_disconnect(self):
        run = self._run()
        self.assertEqual(
            self.client.get(f"/v1/runs/{run.id}", **self.request_headers()).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                f"/v1/runs/{run.id}/pages/next",
                data="{}",
                content_type="application/json",
                **self.request_headers(),
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.delete(
                f"/v1/connections/{self.connection.id}", **self.request_headers()
            ).status_code,
            204,
        )

    @override_settings(CONNECTORS_PROVIDER_ALLOWLIST={"baldor": ["*"]})
    def test_wildcard_allowlist_allows_an_unknown_subject(self):
        self.assertTrue(provider_allowed("baldor", "never-seen-user"))
        self.assertFalse(provider_allowed("other", "never-seen-user"))

    def test_explicit_allowlist_still_refuses_an_unlisted_subject(self):
        self.assertTrue(provider_allowed("baldor", "user-a"))
        self.assertFalse(provider_allowed("baldor", "never-seen-user"))

    def test_bootstrap_local_prepares_a_checkout_and_is_repeatable(self):
        from connectors.management.commands import bootstrap_local

        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            with (
                mock.patch.object(bootstrap_local, "ENV_PATH", env_path),
                override_settings(CONNECTORS_PUBLIC_BASE_URL="http://localhost:8010"),
            ):
                first = io.StringIO()
                call_command("bootstrap_local", stdout=first)
                key = dict(
                    line.split("=", 1)
                    for line in env_path.read_text().splitlines()
                    if "=" in line and not line.startswith("#")
                )["CONNECTORS_ENCRYPTION_KEY"]
                self.assertEqual(len(bytes.fromhex(key)), 32)
                client = ServiceClient.objects.get(client_id="forkluck-local")
                self.assertEqual(
                    client.redirect_uri,
                    "http://localhost:3000/api/integrations/connectors/callback",
                )
                self.assertIn(
                    "FORKLUCK_CONNECTOR_SERVICE_URL=http://localhost:8010",
                    first.getvalue(),
                )
                self.assertIn(
                    "FORKLUCK_CONNECTOR_CLIENT_ID=forkluck-local", first.getvalue()
                )
                first_secret = (
                    first.getvalue()
                    .split("FORKLUCK_CONNECTOR_CLIENT_SECRET=")[1]
                    .strip()
                )
                self.assertTrue(client.verify_secret(first_secret))

                second = io.StringIO()
                call_command("bootstrap_local", stdout=second)
                self.assertIn(f"CONNECTORS_ENCRYPTION_KEY={key}", env_path.read_text())
                self.assertEqual(
                    ServiceClient.objects.filter(client_id="forkluck-local").count(), 1
                )
                second_secret = (
                    second.getvalue()
                    .split("FORKLUCK_CONNECTOR_CLIENT_SECRET=")[1]
                    .strip()
                )
                self.assertNotEqual(first_secret, second_secret)
                client.refresh_from_db()
                self.assertTrue(client.verify_secret(second_secret))

    def test_bootstrap_local_refuses_production(self):
        with (
            override_settings(CONNECTORS_ENVIRONMENT="production"),
            self.assertRaises(CommandError),
        ):
            call_command("bootstrap_local", stdout=io.StringIO())

    def test_settings_validation_accepts_the_wildcard_allowlist(self):
        import config.settings

        try:
            with mock.patch.dict(
                os.environ, {"CONNECTORS_PROVIDER_ALLOWLIST": '{"baldor":["*"]}'}
            ):
                reloaded = importlib.reload(config.settings)
            self.assertEqual(reloaded.CONNECTORS_PROVIDER_ALLOWLIST, {"baldor": ["*"]})
        finally:
            importlib.reload(config.settings)

    def _run(self):
        return ConnectorRun.objects.create(
            connection=self.connection,
            client=self.client_row,
            subject_id="user-a",
            idempotency_key=random_token(),
            status=ConnectorRun.Status.SUCCEEDED,
        )

    def _document(self):
        return {
            "supplier": "acme",
            "supplierName": "Acme",
            "documentType": "invoice",
            "invoiceNumber": "INV-1",
            "invoiceDate": "2026-01-01",
            "totalCents": 1000,
            "currencyCode": "USD",
            "fileName": "INV-1.pdf",
            "lines": [
                {
                    "sku": "one",
                    "description": "One",
                    "quantity": 1,
                    "unit": "EA",
                    "packSize": "1",
                    "unitPriceCents": 1000,
                    "lineAmountCents": 1000,
                    "sourcePayload": {},
                }
            ],
        }


@unittest.skipUnless(
    connection.vendor == "postgresql", "concurrent row-lock test requires PostgreSQL"
)
@override_settings(
    CONNECTORS_ENCRYPTION_KEY=KEY,
    CONNECTORS_PROVIDER_ALLOWLIST={"baldor": ["user-a"]},
)
class RunCreationConcurrencyTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        self.secret = "high-entropy-service-secret"
        self.client_row = ServiceClient.objects.create(
            client_id="forkluck-prod",
            secret_hash=ServiceClient.hash_secret(self.secret),
            redirect_uri="https://app.example.test/api/connectors/callback",
        )
        self.connection_token = "opaque-token"
        self.connection = ConnectorConnection.objects.create(
            client=self.client_row,
            subject_id="user-a",
            provider_key="baldor",
            credential_encrypted=encrypt('{"username":"person","password":"secret"}'),
            token_hash=ConnectorConnection.hash_token(self.connection_token),
        )

    def test_two_first_requests_return_one_active_run(self):
        barrier = threading.Barrier(2)
        responses = []
        failures = []
        headers = {
            "HTTP_AUTHORIZATION": "Basic "
            + base64.b64encode(f"forkluck-prod:{self.secret}".encode()).decode(),
            "HTTP_X_FORKLUCK_SUBJECT": "user-a",
            "HTTP_X_FORKLUCK_CONNECTION_TOKEN": self.connection_token,
        }

        def request_run(key):
            connections.close_all()
            try:
                response = Client().post(
                    "/v1/runs",
                    data=json.dumps(
                        {
                            "connectionId": str(self.connection.id),
                            "idempotencyKey": key,
                        }
                    ),
                    content_type="application/json",
                    **headers,
                )
                responses.append((response.status_code, response.json()["runId"]))
            except Exception as exc:
                failures.append(exc)
            finally:
                connections.close_all()

        with mock.patch(
            "connectors.worker.fail_stale_runs", side_effect=lambda: barrier.wait()
        ):
            threads = [
                threading.Thread(target=request_run, args=("concurrent-1",)),
                threading.Thread(target=request_run, args=("concurrent-2",)),
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=10)

        self.assertFalse(failures)
        self.assertEqual({status for status, _ in responses}, {200, 201})
        self.assertEqual(len({run_id for _, run_id in responses}), 1)
        self.assertEqual(ConnectorRun.objects.count(), 1)


@override_settings(
    CONNECTORS_ENCRYPTION_KEY=KEY,
    CONNECTORS_PROVIDER_ALLOWLIST={"baldor": ["*"]},
)
class ProviderRunGapTests(TestCase):
    """The worker spaces consecutive runs of one provider apart."""

    def setUp(self):
        self.client_row = ServiceClient.objects.create(
            client_id="forkluck-prod",
            secret_hash=ServiceClient.hash_secret("high-entropy-service-secret"),
            redirect_uri="https://app.example.test/api/connectors/callback",
        )
        self.connection = self._connection("baldor", "user-a")

    def _connection(self, provider_key, subject_id):
        return ConnectorConnection.objects.create(
            client=self.client_row,
            subject_id=subject_id,
            provider_key=provider_key,
            credential_encrypted=encrypt('{"username":"person","password":"secret"}'),
            token_hash=ConnectorConnection.hash_token(random_token()),
        )

    def _finished(self, connection_row, seconds_ago=0):
        return ConnectorRun.objects.create(
            connection=connection_row,
            client=self.client_row,
            subject_id=connection_row.subject_id,
            idempotency_key=random_token(),
            status=ConnectorRun.Status.SUCCEEDED,
            heartbeat_at=timezone.now() - timedelta(seconds=seconds_ago),
        )

    def _queued(self):
        return ConnectorRun.objects.create(
            connection=self.connection,
            client=self.client_row,
            subject_id="user-a",
            idempotency_key=random_token(),
        )

    def _run_worker_once(self, finished):
        """Run the loop with a fake clock: sleeping ages the last finish time."""
        slept, executed = [], []

        def fake_sleep(seconds):
            slept.append(seconds)
            if len(slept) > 200:
                raise AssertionError("Worker slept without making progress")
            ConnectorRun.objects.filter(pk=finished.pk).update(
                heartbeat_at=finished.heartbeat_at - timedelta(seconds=sum(slept))
            )

        def fake_execute(run_id):
            executed.append(run_id)
            ConnectorRun.objects.filter(pk=run_id).update(
                status=ConnectorRun.Status.SUCCEEDED, heartbeat_at=timezone.now()
            )
            return True

        with (
            mock.patch(
                "connectors.management.commands.run_connector_worker.time.sleep",
                fake_sleep,
            ),
            mock.patch(
                "connectors.management.commands.run_connector_worker.execute",
                fake_execute,
            ),
            # The loop closes old connections on every pass; inside a
            # TestCase transaction that severs Postgres from the test itself.
            mock.patch(
                "connectors.management.commands.run_connector_worker"
                ".close_old_connections"
            ),
        ):
            call_command("run_connector_worker", "--once")
        return slept, executed

    @override_settings(CONNECTORS_PROVIDER_RUN_GAP_SECONDS=6)
    def test_a_just_finished_run_of_the_same_provider_delays_the_next_claim(self):
        finished = self._finished(self.connection)
        run = self._queued()
        slept, executed = self._run_worker_once(finished)
        self.assertEqual(executed, [run.id])
        self.assertLessEqual(max(slept), 0.5)
        self.assertAlmostEqual(sum(slept), 6, delta=0.5)

    @override_settings(CONNECTORS_PROVIDER_RUN_GAP_SECONDS=6)
    def test_a_run_of_another_provider_does_not_delay_the_claim(self):
        finished = self._finished(self._connection("other", "user-b"))
        run = self._queued()
        slept, executed = self._run_worker_once(finished)
        self.assertEqual(executed, [run.id])
        self.assertEqual(slept, [])

    @override_settings(CONNECTORS_PROVIDER_RUN_GAP_SECONDS=0)
    def test_a_zero_gap_disables_the_wait(self):
        finished = self._finished(self.connection)
        run = self._queued()
        slept, executed = self._run_worker_once(finished)
        self.assertEqual(executed, [run.id])
        self.assertEqual(slept, [])
