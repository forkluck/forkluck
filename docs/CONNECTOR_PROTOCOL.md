# Connector protocol

`supplier_documents:v1` is the versioned HTTPS contract between Forkluck and
the separately deployed supplier-connector service in
[`services/connectors/`](../services/connectors/). The connector service owns
supplier credentials and acquisition. Forkluck only persists a service-issued
opaque connection token, encrypted at rest.

All requests carry confidential-client HTTP Basic authentication and
`X-Forkluck-Subject` (the authenticated Forkluck user UUID). Requests that act
on a connection or run also carry `X-Forkluck-Connection-Token`. The service
must independently verify the complete `(client, subject, provider,
connection, run)` binding before acting.

## Endpoints

- `GET /v1/providers` returns `{"providers": [{"key", "displayName", "description", "icon", "capabilities", "available"}]}`.
- `POST /v1/authorization-sessions` accepts `providerKey`, a high-entropy
  `state`, and the exact registered `callbackUrl`; it returns `sessionId`, a
  connector-hosted `authorizationUrl`, and an ISO `expiresAt`. Supplier
  credentials are submitted only to that hosted page.
- `POST /v1/authorization-codes/exchange` accepts the original `sessionId`,
  `state`, and the callback's 60-second single-use `code`; it returns
  `connectionId`, `providerKey`, `accessToken`, and `status`.
- `DELETE /v1/connections/{connectionId}` disconnects the caller's connection.
- `POST /v1/runs` accepts `connectionId` and a stable `idempotencyKey`; it
  returns the same `runId` when that key is retried for the same bound tuple.
  The service's durable worker creates the run's pages.
- `GET /v1/runs/{runId}` reports `queued`, `running`, `succeeded`, or `failed`
  with progress. Forkluck waits for `succeeded` before consuming pages.
- `POST /v1/runs/{runId}/pages/next` accepts an opaque `cursor` object (the
  first cursor is `{}`) and returns one `supplier_documents:v1` page.
- `POST /v1/runs/{runId}/pages/{pageId}/ack` acknowledges a committed page.

## Delivery semantics

`pages/next` replays the first unacknowledged page for a cursor until its
acknowledgement succeeds. Forkluck validates every response against the JSON
Schema in [`docs/schemas/supplier_documents.v1.schema.json`](schemas/supplier_documents.v1.schema.json),
imports the whole page in one database transaction, persists the cursor and
pending page ID, then calls the acknowledgement endpoint. After acknowledgement
succeeds, Forkluck moves the pending ID to the acknowledged page ID. Invoice
fingerprints make a replay effectively-once for users. Acknowledgements must be
idempotent; once a page is acknowledged, its former cursor is rejected instead
of being interpreted as a request for new work, so an acknowledged cursor can
never silently skip data.

Pages contain normalized invoices and credit memos only. The service never
returns supplier passwords, raw session cookies, captured web responses,
supplier endpoints, or arbitrary URLs.

A page request before the run succeeds, including a failed run with partial
acquisition, returns HTTP 409. Partially acquired pages are never delivered.

## Where the pieces live

- Consumer: `apps/api/forkluck/integrations/connectors.py` and
  `apps/api/forkluck/domains/invoices/connector_sync.py`; the schema is
  validated on import.
- Synthetic service for tests: `apps/api/forkluck/fake_connector_service.py`
  (`manage.py run_fake_connector_service`), used by the browser acceptance
  suite.
- Service implementation: [`services/connectors/`](../services/connectors/),
  with [Adding a provider](../services/connectors/docs/ADDING_A_PROVIDER.md)
  and [Operations](../services/connectors/docs/OPERATIONS.md).

A protocol change updates this document, the schema, the consumer and its
tests under `apps/api`, and the service under `services/connectors` in one
pull request.
