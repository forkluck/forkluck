# Contributing to Forkluck

Bug reports, feature ideas, product feedback, and technical analysis are welcome
from everyone.

By joining in, you agree to the [Code of Conduct](../CODE_OF_CONDUCT.md).

## Before you start

- Search the issues first.
- Open an issue before writing code, so we can agree the problem and approach.
- Never put real recipes, invoices, sales exports, or credentials in an issue,
  fixture, or commit.
- Report vulnerabilities privately, as described in [SECURITY.md](../SECURITY.md).

## Development setup

You'll need Node.js 22+, pnpm 10, Python 3.12+, and SQLite (the default) or
PostgreSQL.

```bash
pnpm install --frozen-lockfile
python3 -m venv apps/api/.venv
apps/api/.venv/bin/pip install -r apps/api/requirements-dev.txt
cp apps/web/.env.example apps/web/.env.local
cp apps/api/.env.example apps/api/.env
pnpm db:migrate
pnpm db:seed
```

The repository is a pnpm workspace: the Next.js app is `apps/web`, the Django
API is `apps/api`, the supplier connector service is `services/connectors`,
and the root `package.json` scripts delegate to them.

`pnpm db:migrate` also runs `manage.py sync_catalog`, which loads the open
ingredient catalog under `data/catalog/` (see its README to contribute). It is
idempotent, so running it again after an unchanged file does nothing.

Run `pnpm backend:dev`, `pnpm dev`, and `pnpm backend:worker` in separate
terminals. The app is at [localhost:3000](http://localhost:3000). The public
site at forkluck.com is a separate self-hosted Ghost and is not part of this
repository.

The example env files carry safe defaults. Never commit real credentials.
Local setup uses SQLite and the console email backend. `db:seed` prints the
synthetic demo account's sign-in details. AI and supplier accounts are optional;
you can develop the core product and run the normal tests without those keys.

Install Chromium once before running browser acceptance tests:

```sh
pnpm --filter @forkluck/web exec playwright install chromium
```

On Linux, use `pnpm --filter @forkluck/web exec playwright install --with-deps chromium` to install
its operating-system dependencies too. Acceptance tests start isolated
synthetic services and a temporary database; they do not use your development
data or real AI/provider credentials.

### Supplier connectors locally

Suppliers such as Baldor have no API, so Forkluck logs in for the kitchen
and collects invoices. That happens in the supplier connector service under
`services/connectors`: a separate process with its own database and
encryption key, so supplier passwords never enter the app. Two ways to run
it on your machine.

**Without a supplier account.** A synthetic service ships with the API for
the browser tests. It offers "Acme Produce", connects without a password,
and syncs made-up invoices:

```bash
pnpm connectors:fake
```

Put these in `apps/api/.env`, restart `pnpm backend:dev`, and start
`pnpm backend:connector-worker` in another terminal:

```env
FORKLUCK_CONNECTOR_SERVICE_URL=http://127.0.0.1:9123
FORKLUCK_CONNECTOR_CLIENT_ID=public-app
FORKLUCK_CONNECTOR_CLIENT_SECRET=public-secret
```

**Baldor.** The real service needs Python 3.13. Set it up once, then let the
setup script register it with your app:

```bash
cd services/connectors
python3.13 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
cd ../..
pnpm connectors:setup
```

The script creates the service's `.env`, generates its encryption key, runs
its migrations, registers the app, and writes the three connector settings
into `apps/api/.env`. Restart `pnpm backend:dev`, then run these in separate
terminals:

```bash
pnpm connectors:dev
pnpm connectors:worker
pnpm backend:connector-worker
```

Baldor appears under Integrations > Suppliers > Connections. Your Baldor
login is entered on the connector service's own page and stored encrypted
in its database, never in the app. `pnpm verify:connectors` runs the
service's checks.

`pnpm verify:skills` validates the agent skills under `skills/`
(`pip install -r skills/requirements-dev.txt` first).

## Making a change

Branch from `main`, keep the PR to one reviewable outcome, and link the issue.
Behavior changes need tests; model changes need a committed migration. Say what
broke, what you did, how you tested it, and anything that affects deployment.

Before you open it:

```bash
pnpm verify
pnpm verify:backend
pnpm test:acceptance
pnpm verify:connectors   # when services/connectors changed
pnpm verify:skills       # when skills/ or a path they name changed
```

Pull requests run frontend, PostgreSQL backend/catalog, connector, skills, and browser checks on
GitHub-hosted runners. The production workflow is restricted to `main`.
Optional live-model checks are described in [AI evaluations](../docs/EVALUATIONS.md).

Use the [README contribution map](../README.md#where-to-contribute) to find an
entry point. For a bug fix, include a focused reproduction or failing test.
For domain changes, preserve the invariants in `AGENTS.md` and the contract.

How review runs once it's open: [docs/REVIEW.md](../docs/REVIEW.md). How the
code fits together: [ARCHITECTURE.md](../ARCHITECTURE.md).

## Contributor License Agreement

By contributing code to Forkluck you grant Forkluck a non-exclusive,
irrevocable, worldwide, royalty-free, sublicenseable, transferable license
under all of Your relevant intellectual property rights (including copyright,
patent, and any other rights), to use, copy, prepare derivative works of,
distribute and publicly perform and display the Contributions on any licensing
terms, including without limitation: (a) open source licenses like the GNU
AGPL; and (b) binary, proprietary, or commercial licenses. Except for the
licenses granted herein, You reserve all right, title, and interest in and to
the Contribution. Contributors retain ownership of their Contributions; the
above is a grant of rights, not an assignment of copyright.

You confirm that you are able to grant us these rights. You represent that You
are legally entitled to grant the above license. If Your employer has rights to
intellectual property that You create, You represent that You have received
permission to make the Contributions on behalf of that employer, or that Your
employer has waived such rights for the Contributions.

You represent that the Contributions are Your original works of authorship, and
to Your knowledge, no other person claims, or has the right to claim, any right
in any invention or patent related to the Contributions. You also represent that
You are not legally obligated, whether by entering into an agreement or
otherwise, in any way that conflicts with the terms of this license.

Forkluck acknowledges that, except as explicitly described in this Agreement,
any Contribution which you provide is on an "AS IS" BASIS, WITHOUT WARRANTIES
OR CONDITIONS OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING, WITHOUT
LIMITATION, ANY WARRANTIES OR CONDITIONS OF TITLE, NON-INFRINGEMENT,
MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
