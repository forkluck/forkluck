---
name: integrating-forkluck
description: Build or change Forkluck POS, supplier, invoice, sales, OAuth, webhook, catalog, or supplier connector integrations. Use when external identities, credentials, sync jobs, accounting attribution, protocol contracts, or provider effects are involved.
---

# Integrating Forkluck

An integration may span the public Forkluck repository and the separately deployed connector service. Discover the active checkouts rather than assuming an absolute path.

## Load the relevant boundaries

For the main Forkluck application, read:

- `AGENTS.md` completely;
- `ARCHITECTURE.md` for integration/domain layering and durable workers;
- `docs/CONTRACT.md` for the Next/Django surface;
- `docs/CONNECTOR_PROTOCOL.md` for supplier connector messages;
- `docs/DEPLOYMENT.md` when process or environment configuration changes.

For the connector service, read the shared `docs/CONNECTOR_PROTOCOL.md` and `services/connectors/docs/OPERATIONS.md` before editing `services/connectors/`.

When the same protocol document exists in both repositories, compare them before work and update both sides together when the contract changes.

## Preserve trust boundaries

- The public application stores only service-issued opaque connection tokens for supplier connectors.
- Supplier usernames, passwords, sessions, provider allowlists, browser automation, and provider-specific code stay in the connector service.
- Browser input never chooses a connector-service base URL or bypasses the configured provider allowlist.
- Tokens and provider credentials must not appear in logs, action errors, receipts, fixtures, committed data, or model prompts.
- Every user-owned connection, import, invoice, and sync run is scoped through the authenticated owner or tenant.

Provider source is public in the connector repository. Keep acquisition in that
service so supplier credentials and sessions stay outside the application and
its AI context; source visibility does not change the runtime boundary.

## Preserve identity and accounting

- Retain provider, channel, external object, connection, and source-import identity across retries and reimports.
- Make external writes idempotent when the provider supports idempotency keys; make local ingestion idempotent regardless.
- Revenue attribution is a view of the source sale, not additional revenue. Allocated product and modifier revenue must never exceed the original net amount.
- Historical invoice and sales money retains its document currency and is never restated as workspace money.
- Adapter code acquires and normalizes provider data. Domain code owns interpretation, authorization, accounting, leases, persistence, and job state.

## Design durable work

Browser requests enqueue bounded work; they do not own a long provider sync. Persist the run before the external effect, claim it durably, bound retries, recover stale claims, and expose an honest terminal state. External effects occur outside the transaction that records their intent.

For every new persisted relation or state, trace create, read, retry, reconnect, import/undo, disconnect, merge, and delete behavior. Test duplicate deliveries, revoked authorization, partial provider failure, concurrent claims, stale claims, and foreign object ids.

## Verify both repositories

Run the relevant contract and integration suites in every changed repository. When a protocol changes, assert both producer and consumer against the same examples and rejection cases. Do not deploy either side until compatibility and rollout order are explicit and the user authorizes deployment.
