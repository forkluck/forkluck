# Deployment

How the hosted Forkluck deployment works, and what to copy if you run your own.
For the shape of the running system, see [ARCHITECTURE.md](../ARCHITECTURE.md).

## Release flow

A push to `main` starts the **Deploy** workflow automatically. Verification
happens before that: every pull request runs the **CI** workflow on
GitHub-hosted runners without deployment secrets (frontend checks, the
Postgres-backed backend suite and catalog validation, the connector service
suite, the agent-skill validation, and the browser acceptance suite), and the
`main` branch ruleset only accepts merged pull requests whose checks passed on
an up-to-date branch. Run `pnpm verify` and `pnpm verify:backend` locally
before opening one.

The Deploy workflow therefore has two jobs. **Package** builds the versioned
release artifact on a GitHub-hosted Ubuntu runner, because `sharp` and
`@napi-rs/canvas` ship platform-specific binaries and the artifact must match
the Linux server. **Deploy** runs only when packaging succeeds. A maintainer
can also start the workflow manually from `main` as a fallback. Both jobs
refuse other refs, and the deploy job uses GitHub's `production` environment;
configure that environment to hold the five deployment secrets and, when
desired, require maintainer approval. A manual run therefore cannot deploy an
arbitrary branch, and no machine outside GitHub takes part in any workflow.

The workflow builds the Next.js standalone server and uploads one versioned
release through the restricted `forkluck-deploy` SSH account. The server runs
migrations, switches the `current` symlink atomically, health-checks the two web
services and the configured durable workers, and rolls back automatically if startup
fails. Once a destructive migration has succeeded, the old release is never
automatically restored against the new schema — recovery is the new release or
a database restore.

It requires these encrypted GitHub repository secrets:

- `DEPLOY_SSH_KEY`
- `DEPLOY_KNOWN_HOSTS`
- `DEPLOY_HOST`
- `DEPLOY_PORT`
- `DEPLOY_USER`

## Server infrastructure

Server templates and the release script live in [`deploy/`](../deploy/). They
are root-owned infrastructure, installed deliberately rather than replaceable by
the SSH deploy account; changes inside `deploy/` must be applied as an
infrastructure update.

Two nginx templates serve the two hosts: `forkluck.conf` is the application on
`app.forkluck.com`, `forkluck-ghost.conf` is the public site on `forkluck.com`.
Both replace temporary upstream failures with a static maintenance page and a
`503 Service Unavailable` response. Install all three files, validate the
configuration, and reload nginx when any template changes:

```bash
sudo install -d -m 755 /var/www/forkluck
sudo install -m 644 deploy/nginx/maintenance.html /var/www/forkluck/maintenance.html
sudo install -m 644 deploy/nginx/forkluck.conf /etc/nginx/sites-available/forkluck
sudo install -m 644 deploy/nginx/forkluck-ghost.conf /etc/nginx/sites-available/forkluck-ghost
sudo ln -sf /etc/nginx/sites-available/forkluck-ghost /etc/nginx/sites-enabled/forkluck-ghost
sudo nginx -t
sudo systemctl reload nginx
```

The application proxy allows 12 MiB per request so an accepted 8 MB receipt
photo still fits after base64 encoding and JSON metadata. The route's original
file limits continue to apply; the transport limit is not a larger file limit.

For `/_next/static/` only, nginx uses a full 40-character hexadecimal `dpl`
query parameter to serve assets from that retained release. Requests without
a valid release id use `current`. Missing releases/assets return 404. This
keeps lazy-loaded dialogs available to tabs opened before a deployment while
`deploy-forkluck` retains that release (currently ten releases). Every dynamic
page, API, and Server Action still goes to the current application. Next's
deployment-id check continues to reload mismatched client navigations.

| Proxy boundary | Invariant |
| --- | --- |
| Syntax and precedence | Only a full release hash selects an older static directory; malformed ids cannot select paths |
| Identity | Only public build assets are served from release directories; application data and actions keep their existing session/tenant checks |
| Lifecycle | Current assets and assets from retained releases remain available; pruned releases return 404 |
| Uploads | The maximum allowed encoded photo passes; a body above 12 MiB is refused before the application |

The `forkluck_signed_in` cookie the two hosts share is scoped to the parent
domain of `FORKLUCK_APP_ORIGIN`'s host (`https://app.forkluck.com` gives
`.forkluck.com`); `FORKLUCK_SIGNED_IN_COOKIE_DOMAIN` overrides it.

A host provisioned before a worker was added must run the current
`provision-forkluck` once before its first release with that worker. Before
upload, the workflow compares exact hashes of the root-owned deploy helper and
all worker units against the repository and fails on missing or stale
infrastructure. The release script stops and restarts every worker it finds a
command for, so a worker left out of it keeps running the previous release.

`forkluck-connector-worker.service` runs the provider-neutral connector queue.
It is the only supplier-document worker in the application deployment.

## Supplier connector service

The application optionally talks to a separately deployed HTTPS service. Its
three settings in `/etc/forkluck/backend.env` are all-or-none:

```env
FORKLUCK_CONNECTOR_SERVICE_URL=https://connectors.example.com
FORKLUCK_CONNECTOR_CLIENT_ID=<confidential client id>
FORKLUCK_CONNECTOR_CLIENT_SECRET=<confidential client secret>
```

The URL is operator configuration, never a value accepted from a browser. The
public application stores only service-issued opaque connection tokens,
encrypted with `FORKLUCK_TOKEN_ENCRYPTION_KEY`. Supplier usernames, passwords,
sessions, provider allowlists, and provider code belong to the other service.
Leaving all three settings empty disables supplier connectors and is the
normal self-hosted default.

To offer Baldor on your own deployment, run the connector service yourself
following `services/connectors/docs/OPERATIONS.md`, register your app with
`manage.py provision_service_client <id> https://<your app origin>/api/integrations/connectors/callback`,
put the printed id and secret plus the service's public URL into the three
settings above, and list your users' ids (or `["*"]`) in the service's
`CONNECTORS_PROVIDER_ALLOWLIST`. For a development machine,
`pnpm connectors:setup` does all of that; see the contributing guide.

The application release artifact contains no connector-service source. The
connector service lives in this repository under `services/connectors/` but
has its own database, worker, encryption key, release artifact, server user,
GitHub environment (`connectors-production`), and deployment workflow
(`.github/workflows/deploy-connectors.yml`). The application package job
copies only `apps/web`, `apps/api`, and `data`.

Routing:

- `forkluck.com` → the public site: a self-hosted Ghost at `/opt/ghost`,
  proxied to `127.0.0.1:2368`. See `deploy/ghost/README.md`. It is a separate
  application with its own release cycle; this repository's deploy never
  touches it.
- `www.forkluck.com` → redirects to `forkluck.com`
- `app.forkluck.com` → application

To create the first staff account, run Django's `createsuperuser` against the
production environment, then sign in at
[app.forkluck.com/mommy/](https://app.forkluck.com/mommy/).

With `FORKLUCK_ADMIN_CODE_LOGIN` enabled, every staff-console URL requires the
admin email-code step, including for staff already signed into the application.
Existing sessions without that proof complete the admin login once after this
release; ordinary application sessions continue working.

## Email verification

The optional feedback board deployment and its shared account/mail setup are
documented in [`deploy/fider/README.md`](../deploy/fider/README.md). It reuses
the host's PostgreSQL and Ghost mail bridge, with a dedicated database and
host-only session secret. It is deployed separately from the app release.

Production requires both of these in `/etc/forkluck/backend.env` and refuses
to start when either requirement is missing:

```env
FORKLUCK_REQUIRE_EMAIL_VERIFICATION=true
ACS_CONNECTION_STRING=<Azure Communication Services connection string>
```

On the hosted installation, all product mail uses Ghost's existing delivery
bridge. Set `FORKLUCK_MAIL_BRIDGE_URL=http://127.0.0.1:3003/v3/forkluck.com/messages`
and `FORKLUCK_MAIL_BRIDGE_API_KEY` to the existing bridge key. These settings
take precedence over ACS and must be configured together. Direct ACS is then
optional. HTTPS is required for a bridge outside loopback. A bridge failure
surfaces to the caller without retrying via ACS and risking duplicate codes.

Verify a live code email before deploying a release that first enables this
gate. An existing unverified user should log out and sign in again, then enter
the emailed code. Stored recipe shares remain present but grant no access until
their recipient verifies.

Newsletter membership is optional: set `GHOST_ADMIN_URL` (for example
`https://forkluck.com`) and `GHOST_ADMIN_API_KEY` to mirror verified accounts
into Ghost, and leave both empty to disable the sync entirely. The key comes
from Ghost admin under Settings → Integrations → Add custom integration, where
the Admin API key is shown as `id:secret` — copy it whole.

## Starter price catalog

Hosted starter-price estimates are deployment data, not source code. To enable
them, point `FORKLUCK_MASTER_PRICE_CATALOG_PATH` at a private JSON file outside
the repository. With no configured catalog the application simply offers no
starter estimates; pantry pricing and imports keep working.

## Billing

Subscriptions are configured entirely through `/etc/forkluck/backend.env`:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID`
- `STRIPE_PRODUCT_ID`
- `STRIPE_WEBHOOK_ENDPOINT_ID`

All-or-nothing: billing turns on only when all five are set, and the backend
refuses to boot on a partial set.

The exact supported setup is one active licensed recurring price: USD $7.00,
one-month interval, attached to the active configured product. The webhook is
enabled at `https://app.forkluck.com/api/billing/stripe-webhook`, uses API
version `2025-12-15.clover`, and subscribes to exactly:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Configure the Customer Portal for cancellation and payment-method updates.
Enable Smart Retries and cancel the subscription after the final retry, so
`past_due` remains a grace state and a terminal failure becomes locked.

Every deploy runs `validate_stripe_billing --preflight` before migrations. It
does live, read-only validation and does not access billing tables. After
migrations, the deploy persists the verified object identities and HMAC secret
digests. An invalid object stops before schema changes. The first normalized
billing release may persist an unproved secret once; all later deploys require
a signed delivery to have proved the current secret.

For an existing endpoint, set all five environment values and deploy. Checkout
will answer `billing_not_ready` until a fresh, correctly signed delivery reaches
the public webhook and records proof. Use Stripe's endpoint delivery tool, then
run:

```bash
/opt/forkluck/shared/venv/bin/python /opt/forkluck/current/backend/manage.py \
  validate_stripe_billing
```

To create a new endpoint from the configured product/price, first run migrations
and provide the API secret, price id, and product id to the command process:

```bash
manage.py provision_stripe_billing --output-env /secure/new-stripe.env
```

The command refuses an existing destination, writes mode `0600`, refuses to
duplicate the public URL, and removes a newly created endpoint if later local
work fails. Install all five emitted values atomically, then restart Django.

To adopt an existing endpoint or recover after secret rotation, put its id and
operator-supplied secret in the process environment and run:

```bash
manage.py provision_stripe_billing --adopt \
  --output-env /secure/adopted-stripe.env
```

Adoption verifies URL, events, status, mode, product, price, and API version
before recording new digests. It deliberately leaves webhook proof pending
until a signed delivery arrives. Do not rotate only in the Stripe dashboard:
Stripe does not reveal a current endpoint secret through its read API, so a
dashboard-only rotation breaks webhook delivery while Checkout still trusts
the last proved local configuration. Immediately adopt the rotated secret,
install the emitted file, restart Django, and send a fresh signed delivery;
Checkout then fails closed until that delivery succeeds.

Before the normalized-state cutover, inventory tagged provider customers and
reconcile all local accounts:

```bash
manage.py reconcile_stripe_billing --inventory-provider --fail-on-orphans
```

An orphan with no subscription history or open Checkout can be retained as a
non-rebindable tombstone with `--tombstone-orphans`. Any orphan with subscription
history, an open Checkout, or a duplicate/ambiguous identity stops for manual
resolution; the command never deletes Stripe customers. After reviewing an
unbound customer whose user still exists, bind it explicitly with
`--adopt-customer cus_... --adopt-user <uuid>`; the command re-fetches the
customer, requires its Forkluck metadata to match the operator-confirmed user,
requires its mode to match the validated configuration, and refuses adoption
until every open Checkout is expired. The retired pre-normalization billing
model, runtime paths, and data backfill were removed in the normalized-state
release. Its verified-empty physical table was dropped in the following
release, completing the repository's required two-release destructive-change
sequence.

## Google sign-in

Google sign-in is optional. Set both values in `/etc/forkluck/backend.env` on
chefclaw, or leave both empty:

```env
GOOGLE_SIGN_IN_CLIENT_ID=
GOOGLE_SIGN_IN_CLIENT_SECRET=
```

A partial pair refuses startup in every environment. With both empty, login
and signup hide the Google button and the start route reports that sign-in is
unavailable. The client secret stays in Django; the Drive picker's public
client remains unchanged. The redirect URI must exactly equal
`FORKLUCK_APP_ORIGIN` + `/api/auth/google/callback`, including scheme, hostname,
port and path, with no trailing slash after `callback`.

In the existing Google Cloud project used by the Drive picker:

1. Open Google Auth Platform. Configure the audience as External and the app
   name as Forkluck. Set the support email, authorized domain `forkluck.com`,
   and the public homepage, privacy policy and terms links. Request only
   `openid`, `email`, and `profile` for sign-in and publish the app to production.
2. Under Clients, create a dedicated **Web application** named **Forkluck
   sign-in**. Use JavaScript origin `https://app.forkluck.com` and authorized
   redirect URI `https://app.forkluck.com/api/auth/google/callback`.
3. Create a second Web application client for development, with origin
   `http://localhost:3000` and redirect URI
   `http://localhost:3000/api/auth/google/callback`.
4. Put the production pair in `/etc/forkluck/backend.env` and restart the
   `forkluck-django.service` after the code release. Put the development pair in
   `apps/api/.env`. Keep both secrets out of Git and the frontend environment.

See Google's [OpenID Connect setup guide](https://developers.google.com/identity/openid-connect/openid-connect#settingupopenauth).

For local verification, run `pnpm dev` and the Django development server,
open `/login?next=/recipes`, and continue with Google. Confirm the return to
Recipes, the last-method caption on the next login visit, cancellation copy,
and **Set a password** in Settings for a new Google-only account. Set a
password and confirm password sign-in uses the same account. Also check a
Google address that already has a password account: its workspace and name
must stay intact. Automated acceptance tests use synthetic OAuth settings and
inspect the links without contacting Google; real consent requires the dev
client pair.

## Google Drive receipts folder

Importing receipts straight from a Drive folder is optional and configured in
`/etc/forkluck/frontend.env` (mode 0640, root-owned, as for every other value
in that file):

```env
GOOGLE_SERVICE_ACCOUNT_JSON=
GOOGLE_SERVICE_ACCOUNT_EMAIL=
```

`GOOGLE_SERVICE_ACCOUNT_JSON` is the base64 of a Google service-account key
JSON granted `drive.readonly`, and `GOOGLE_SERVICE_ACCOUNT_EMAIL` is that
account's address, which merchants share their folder with. Unlike the three
Picker values these are server-only: the key is never sent to the browser,
neither is a token minted from it, and it is never logged. The account can
read every folder anyone shares with it, so the parse route checks each file's
ancestry against the folder that workspace connected before fetching it.
Empty values hide the card on Suppliers → Connections. To rotate, create a new
key in Google Cloud, replace the value, restart `forkluck-next.service`, then
delete the old key in Google Cloud; connected folders are unaffected because
they are stored by folder id, not by credential.

### Drive watcher

`DRIVE_WATCH_INTERVAL_SECONDS` in the same file turns on the poller that
notices new receipts without anyone asking. It is started by
`instrumentation.ts` when the Next process boots — one interval per process,
never per workspace — and each poll reads Google's Changes feed once for the
whole service account, registering every changed file to the workspace whose
connected folder is its ancestor. Unset or `0` disables it; anything under 60
is raised to 60. A folder connected since the last poll is listed in full
first, because files already sitting in it are older than any cursor.

The cursor is a single row in Django. When Google expires it — it is kept for
a matter of weeks — the next poll takes a fresh one and re-lists every
connected folder, so nothing is lost, only re-read. A failed poll leaves the
cursor untouched and records its message, which the Drive card on
Suppliers → Connections shows. "Sync now", on that row, runs exactly this
poll, and joins the timer's run if one is already going.

Each tick also reads what it registered, with the house engine — Forkluck's own
Qwen key — so the merchant opens the inbox to receipts already read rather than
waiting on them. `DRIVE_READ_PER_RUN` (default 5) is how many files per
workspace one tick starts, and a run stops starting new files after four
minutes, leaving the rest for the next tick. Unattended reading is off entirely
under `INVOICE_EXTRACTION_ENGINE=anthropic`, whose per-workspace key exists only
inside a merchant's own session; there every file is read when someone imports
it.

## Uploaded invoice documents

A receipt a merchant drops into the import dialog is kept on our side, so the
invoice page can show the document beside its lines the way a Drive-folder
invoice already does. Where it is kept is configured in
`/etc/forkluck/frontend.env`:

```env
AZURE_STORAGE_CONNECTION_STRING=
AZURE_STORAGE_CONTAINER=documents
```

With `AZURE_STORAGE_CONNECTION_STRING` set, files go to that storage account;
create the account first, and the container named by `AZURE_STORAGE_CONTAINER`
(default `documents`, created on first upload if missing) must stay private —
files are served only through `/api/invoices/document`, which checks the
session before handing out a byte. Left empty, the self-hosted default is
used: a directory on disk, `DOCUMENT_STORE_DIR` (default `.forkluck/documents`
under the Next working directory), which must be writable by the service user
and belongs in whatever backs the host up. Deleting an invoice deletes its
stored file either way.

## Invoice extraction

Which model reads an uploaded or Drive-fetched document is configured in
`/etc/forkluck/frontend.env`:

```env
INVOICE_EXTRACTION_ENGINE=qwen
INVOICE_EXTRACTION_MODEL=qwen3-vl-flash
```

`INVOICE_EXTRACTION_MODEL` is the model every document is read with; it
defaults to `qwen3-vl-flash` on the `qwen` engine and `claude-opus-5` on
`anthropic`. `INVOICE_ESCALATION_MODEL` is the single re-read a document gets
when the first read's arithmetic, header or line items did not check out, named
as a model id on the configured engine. Left unset, that re-read runs on the
same model with the validator's findings as a hint; set it empty to disable the
second pass, so every document costs exactly one read.

Qwen's extraction and optional re-read share a 25-second deadline, leaving
room for upload and matching within the 30-second target for a single invoice.
If the second pass runs out of time, the first usable read remains available
with its review findings. A first-pass timeout returns a retryable error. This
is an AI-work limit, not a guarantee about upload or network latency; bundles
require detection and a separate read for each document. The opt-in Anthropic
engine retains its existing timeout. Per-pass logs include preparation, model
and total elapsed milliseconds without document content.

Who pays depends on the engine. The default `qwen` engine bills Forkluck's own
`QWEN_API_KEY` and sends the document to Alibaba Cloud Model Studio's US region
(`QWEN_BASE_URL` is `dashscope-us`) under the boundary described below, so a
merchant imports receipts without connecting anything and Forkluck pays.
`anthropic` is the opt-in alternative: it bills the workspace's own Anthropic
key, stored per workspace, and a workspace without one is told so instead of
being read. After changing these values, restart `forkluck-next.service`.

**Extraction eval.** `pnpm eval:extraction` scores an engine and model against
a golden set of real receipts. Those receipts carry card digits and addresses,
so the set lives outside the repository, at `RECEIPT_GOLDEN_DIR` (default
`~/forkluck/receipt-golden/`): one case is a receipt file plus
`<file>.expected.json`. `--engine` and `--model` default to what this
deployment is configured with, and the run needs `QWEN_API_KEY` (or
`ANTHROPIC_API_KEY` for that engine) in the shell — it is the only place Forkluck reads a key from
the environment instead of the workspace — and writes its report under
`reports/` in the golden directory. It is a development tool; no server needs
any of this.

**Hosted AI allowance rollout.** Apply migration `0051_invoice_ai_read` and
restart Django before restarting Next (including its Drive reader). Free
workspaces receive 10 AI pages and paid workspaces 100 per UTC calendar month;
an additional attempt budget covers detection, escalation and SDK retries.
Both upload and automatic Drive reads reserve against the same owner ledger
before calling Qwen. A missing/unavailable reservation endpoint refuses AI
work. Existing invoices and manual/template-only imports remain available.
Usage starts at zero on rollout; earlier provider calls are not reconstructed.
Billing-disabled self-hosted installs and the BYOK Anthropic engine are exempt.
The ledger records aggregate token usage without documents or prompts; unknown
usage after provider timeouts remains charged against reserved attempts.

## Primo

Primo is optional and shares the Qwen credential with invoice extraction above.
It is configured in `/etc/forkluck/frontend.env`:

```env
QWEN_API_KEY=
QWEN_BASE_URL=https://dashscope-us.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen3.7-plus
```

An empty key hides the Primo trigger. After changing these values, restart
`forkluck-next.service`. The key is server-only and must never use a
`NEXT_PUBLIC_` name.

Primo conversations and their UI-message parts are stored in Forkluck's own
database per user. They remain until the user deletes the conversation or the
account; account deletion cascades through every transcript.

Primo's USDA FoodData Central search reuses the backend nutrition integration.
Configure its separate server-only key in `/etc/forkluck/backend.env`, then
restart `forkluck-django.service`:

```env
FDC_API_KEY=
```

Without that key, recipe drafting and cost questions still work, while USDA
search returns the same configured error as the Nutrition screen.

The Virginia endpoint stores requests in Virginia; Alibaba performs inference
under its Global processing scope. Each request contains the conversation's
retained user/assistant prose, stable public refs for the open page and bound
mentions, and whichever server-executed tool result the request needs: recipe
titles, product names and SKUs, sales units and revenue, batch and labor
figures, an exact recipe's deterministic cost projection, public USDA candidate
metadata, or the structured recipe draft the model just proposed. Cost
projections can include recipe and ingredient names, prices, supplier labels,
coverage, and price-history dates. Those same five kitchen reads are available
to whichever browser agent drives an authenticated WebMCP
session; unlike Primo, WebMCP does not send them to Alibaba unless that agent's
own implementation does so. Forkluck does not send
browser-supplied historical tool payloads and does not log prompts, tool
results, supplier data, or recipe data. Invoice extraction crosses the same
boundary, sending the document itself: a receipt photo, or a PDF rasterized to
page images. A self-host that cannot accept this external data boundary
should leave `QWEN_API_KEY` empty and set
`INVOICE_EXTRACTION_ENGINE=anthropic`, which hides the Primo trigger and moves
extraction onto each workspace's own Anthropic key.
See Alibaba's [endpoint documentation](https://www.alibabacloud.com/help/en/model-studio/base-url)
and [processing-scope documentation](https://www.alibabacloud.com/help/en/model-studio/regions/)
before enabling it in another jurisdiction.

## Self-hosting

Treat [`deploy/`](../deploy/) as a reference, not a turnkey universal installer.
Supply unique production values for every secret documented in the example
environment files, use PostgreSQL, terminate TLS, disable the demo account, and
expose the Django endpoints through the same origin as Next.js. Leave the three
`STRIPE_*` variables unset and billing stays off entirely — no trial, no
lockout, no webhook route.

### Compare menu forecasts without writing data

After deploying the backtest command, run it on the server with the backend
service environment: `cd /opt/forkluck/current/backend`, then
`set -a; . /etc/forkluck/backend.env; set +a`, then
`sudo -E -u forkluck /opt/forkluck/shared/venv/bin/python manage.py backtest_menu_forecast <menu-public-id> --weeks 26 --horizon 7`.
Repeat with `--horizon 30`, then optionally `--stretch --per-product` at both
horizons. `--as-of YYYY-MM-DD` fixes the kitchen-local cutoff; `--email` can
require a particular owner. This privileged operator command resolves the
menu's owner and all subsequent reads stay in that workspace. It writes no
rows and changes no forecast settings. The table scores production units,
including expanded products, while the page's replay scores menu members;
it is not a sales-accounting unit total. All candidates use the same completed,
nonzero origins with eight weeks of observed menu history; shorter datasets
trim the scored count. The long modifier-history walk can use substantial
memory even though query count stays fixed. A marked row is only the lowest
aggregate error: replace the live basis only after the 7-day result improves
menu WAPE by at least 2 points, median product WAPE rises by at most 0.5,
and the candidate does not lose at 30 days. Busy candidates must also preserve
coverage and add no more than 2 points of signed over-production. Record any
accepted change in the forecast ADR; ties keep the current basis.
