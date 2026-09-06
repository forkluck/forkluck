# Forkluck Connectors

Supplier invoice and credit acquisition for [Forkluck](../../README.md). It
lives in the Forkluck monorepo under `services/connectors/` and shares the
repository's [AGPL-3.0-or-later](../../LICENSE) license. Supplier credentials,
sessions, documents, and deployment secrets are private runtime data.

The service has its own HTTP process, durable worker, database, and encryption
key. Forkluck receives normalized documents and stores an opaque connection
token; supplier passwords never enter the application or its AI prompts.

```mermaid
flowchart LR
  App["Forkluck application"] -->|"client authentication + subject + connection token"| API["Connector API"]
  API --> DB[("Connector database")]
  Worker["Durable worker"] --> DB
  Worker --> Provider["Supplier adapter"]
  Provider --> Supplier["Supplier account"]
  API -->|"normalized, acknowledged document pages"| App
```

Baldor is the first adapter. See [Adding a provider](docs/ADDING_A_PROVIDER.md)
for the extension contract and synthetic test examples.

## Local development

Python 3.13 is used in CI. From the repository root:

```sh
cd services/connectors
python3.13 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
cp .env.example .env
set -a
. ./.env
set +a
export CONNECTORS_ENCRYPTION_KEY="$(.venv/bin/python -c 'import secrets; print(secrets.token_hex(32))')"
.venv/bin/python manage.py migrate
.venv/bin/python manage.py runserver 127.0.0.1:8010
```

Keep the generated encryption key in your untracked `.env` to retain access to
locally stored credentials across shell sessions. Start the worker in another
terminal with the same environment:

```sh
.venv/bin/python manage.py run_connector_worker
```

To connect a local Forkluck instance, provision a service client with
`manage.py provision_service_client <id> <exact-callback-url>`, then configure
that client and its one-time secret in Forkluck's backend environment. Enable
the provider for your authenticated user in `CONNECTORS_PROVIDER_ALLOWLIST`.
This setup is optional: the test suite uses synthetic providers and makes no
live supplier calls.

## Verification

From the repository root, `pnpm verify:connectors` runs the same five checks:

```sh
.venv/bin/ruff format --check config connectors manage.py
.venv/bin/ruff check config connectors manage.py
.venv/bin/python manage.py test
.venv/bin/python manage.py makemigrations --check --dry-run
.venv/bin/python manage.py check
```

CI runs these checks with PostgreSQL so concurrency and locking tests also run.
The service ships through `.github/workflows/deploy-connectors.yml` on pushes
to `main` that touch this directory. See the shared
[protocol](../../docs/CONNECTOR_PROTOCOL.md) and [operations](docs/OPERATIONS.md).

## Contributing

No supplier account is needed to run the tests. For a new supplier, follow
[Adding a provider](docs/ADDING_A_PROVIDER.md) and include synthetic examples
of its document formats and failures.

Keep changes scoped to one behavior. Preserve client, subject, provider,
connection, and run identity throughout authorization and delivery. A protocol
change updates [`docs/CONNECTOR_PROTOCOL.md`](../../docs/CONNECTOR_PROTOCOL.md),
the schema under `docs/schemas/`, and the consumer and its tests in `apps/api`
in the same pull request.

Use fabricated accounts, invoice numbers, products, and amounts. Never submit
captured account pages, cookies, passwords, customer documents, or production
configuration. Errors and logs must not expose raw provider responses.

Report security issues through the repository's
[private reporting process](../../SECURITY.md). Copyright © 2026 Forkluck.
