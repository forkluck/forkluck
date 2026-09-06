# Adding a supplier provider

The worker consumes normalized document batches. Provider modules own login,
HTTP requests, pagination, rate limits, document identity, related credits,
and normalization. Django owns credential storage, claims, delivery pages,
acknowledgements, and authorization.

## Implement the current adapter contract

Add a module under `connectors/providers/` and register its client in
`connectors/providers/__init__.py`. Use the existing metadata keys: `key`,
`displayName`, `description`, `icon`, `capabilities`, `available`, and `client`.

A client implements these methods; no base class is required:

```python
class SupplierClient:
    def __init__(self, timeout=30.0):
        # Keep the timeout finite and choose a fixed supplier endpoint.
        self.timeout = timeout

    def login(self, username, password):
        # Establish a session or raise an exception.
        ...

    def document_batches(self, from_date, to_date, *, start_page=0):
        # Yield lists of supplier_documents:v1 documents.
        # Paginate and deduplicate using this supplier's stable document IDs.
        ...
```

This is a signature sketch. `BaldorClient` is the working implementation, and
`test_worker_accepts_an_independent_provider_and_bounds_delivery_pages` is a
synthetic example requiring no Baldor payloads or network access. The hosted
sign-in form currently accepts username/password; OAuth or MFA needs an
explicit authorization-flow change as well as an adapter.

Each yielded batch represents a bounded acquisition step, including an empty
listing page. It lets the worker refresh its claim between steps. Bound HTTP
timeouts, retries, listing pages, and line pages inside the provider; a supplier
that keeps changing pagination must still terminate. The legacy run cursor's
`invoicePage` is passed as `start_page`; it is separate from the opaque delivery
cursor used by Forkluck.

Normalize to the document definition in
[`supplier_documents.v1.schema.json`](../../../docs/schemas/supplier_documents.v1.schema.json).
Return integer minor-unit money amounts, preserve currency, make credit totals
negative, and include only reviewed metadata in `sourcePayload`. Never return
raw responses, credentials, cookies, or supplier URLs. The worker batches at
most 40 documents and 500 total lines per delivery page, and emits a terminal
page even for an empty sync. Arbitrary exception text is never sent to clients.

## Verify the boundary

| Behavior | Required evidence |
| --- | --- |
| Authentication | Success, rejected session, expired session; no leaked secrets |
| Acquisition | Empty listing, multiple pages, bounded retries and pagination |
| Identity | Duplicate listing/related-credit entries emit one document |
| Accounting | Invoice and credit amounts, rounding, currency, unit and pack fields |
| Delivery | Documents can be split across page and total-line limits |
| Failure | Partial acquisition fails the run; failed pages cannot be consumed |
| Access | Provider allowlist revocation blocks new acquisition |

Use the provider tests for acquisition and `connectors/tests.py` for worker and
HTTP behavior. Run the complete suite before committing. Consumer-side examples
live in Forkluck's `backend/forkluck/test_connectors.py`.

Enable the provider for test subjects through `CONNECTORS_PROVIDER_ALLOWLIST`.
Registry presence does not automatically grant hosted users access.
