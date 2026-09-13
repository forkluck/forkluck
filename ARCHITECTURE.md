# Architecture

How Forkluck is put together, and where the seams are. For the exact HTTP
surface between the two processes, see [docs/CONTRACT.md](docs/CONTRACT.md).

## Runtime processes

Forkluck runs two servers and one durable worker on a host:

- **Next.js** (App Router, React 19) renders every page and is the only client
  of the data API.
- **Django** (5.2) owns accounts, sessions, persistence, and the staff console
  at `/mommy/`. The console is Django's admin; `forkluck/mommy.py` deals its
  tables into the task-shaped sections the index and sidebar show.
- **POS worker** is a Django management process that claims durable `SyncRun`
  rows and executes bounded Square/Shopify passes with retries and stale-claim
  recovery. A browser request only queues work; it does not own execution.

Django listens on localhost only; the Next.js server reaches it at
`DJANGO_INTERNAL_ORIGIN`, which defaults to `http://127.0.0.1:8001`. Nginx
publishes the Next.js server and
Django's public routes; it never publishes the internal ones. The browser
therefore reaches Django directly for authentication and OAuth redirects, and
reaches everything else through Next.js.

The Next.js server answers on one hostname, `app.forkluck.com`. The public site
at `forkluck.com` is a separate self-hosted Ghost, proxied by its own nginx
server block; nothing in this repository renders it.

## Route groups

| Prefix                                              | Caller             | Auth                                                                                      |
| --------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| `/api/auth/`, `/api/integrations/`, `/api/billing/` | Browser → Django   | Django session cookie; CSRF token on writes, except the signed Stripe webhook             |
| `/api/invoices/`, `/api/primo/`                     | Browser → Next.js  | Django session checked by the route; each route applies its own input and origin boundary |
| `/internal/v1/`                                     | The Next.js server | Session cookie **and** `X-Forkluck-Internal-Secret`                                       |

`internal_user` in `apps/api/forkluck/http/auth.py` guards user-scoped internal
views. The explicit `system_get`/`system_post` category requires only the
internal secret; `auth-methods/` uses it so signed-out pages can discover
Google sign-in availability and the public Turnstile site key. A missing or
wrong secret answers **404** — the
route denies its own existence. A user-scoped view with a valid secret but no
session answers **401**.

`apps/web/lib/backend/client.ts` is the only code that speaks to `/internal/v1/`. It
forwards the incoming cookie header, attaches the secret, revives the
allowlisted timestamp keys into `Date`, and turns a 401 into
`BackendUnauthorizedError`.

## A read

```
app/(app)/<page>.tsx        Server Component; calls requireUser() first
  lib/backend/queries.ts    one function per endpoint, returns typed rows
    djangoGet(Parsed)       lib/backend/client.ts — cookie + internal secret
      internal_urls.py      require_GET(internal_user(view))
        domains/<d>/views.py
          domains/<d>/serializers.py
```

Pages are Server Components and are dynamic: the client sends `cache:
"no-store"`, because every response is scoped to one authenticated user. The
browser keeps a page it has visited for thirty seconds (`staleTimes.dynamic`
in `next.config.ts`), so a list comes back at once after a detour into one of
its rows; every Server Action revalidates, which purges that copy, and
`useRefresh` refetches the rest. There is no `loading.tsx`: a navigation keeps
the old page on screen and the shell dims it once the wait passes 200 ms.

Five payloads — session, ingredients, recipes, recipe cost diff, and sales
overview — go through
`djangoGetParsed`, which checks the response against a strict zod schema in
`apps/web/lib/backend/schemas.ts` outside production and then returns the original
object. The check is a drift alarm, not a parser: what callers receive is
identical in every environment.

## AI boundaries

AI runs inside the Next.js server. Each task owns its model, prompt, limits,
and output handling; shared provider configuration lives in `apps/web/lib/ai/`.

| Responsibility | Entry point |
| --- | --- |
| Shared Qwen endpoint | `apps/web/lib/ai/providers.ts` |
| Primo chat model and generation limits | `apps/web/lib/primo/model.ts` |
| Primo instructions, tools, and draft schemas | `apps/web/lib/primo/prompt.ts`, `tools.ts`, `recipe.ts` |
| Attachment admission and extraction | `apps/web/app/api/primo/attachments/route.ts`, `apps/web/lib/primo/attachment-server.ts` |
| Invoice model calls and extraction limits | `apps/web/lib/invoice-extract.ts` |
| Invoice validation, escalation findings, and usage budget | `apps/web/lib/invoice-import.ts`, `invoice-escalation.ts`, `invoice-ai-usage.ts` |
| Authenticated reads and writes | `apps/web/lib/backend/` and Django `domains/` |

The shared provider module has no dependency on Primo, invoice logic, Django,
or request state. A provider change must preserve each caller's structured
output settings, deadlines, and key selection. There is no shared agent
framework or separate AI service to run locally.

Model output is untrusted input. Recipe drafts require explicit confirmation;
invoice extraction goes through deterministic validation and review. Django
continues to authorize every operation and owns persisted state. The five
kitchen tools are also used by WebMCP, so their calculations stay independent
of a model provider.

| Invariant | Verification |
| --- | --- |
| Changing the shared endpoint preserves task-specific models and limits | Primo route/stream and invoice extraction tests |
| Credentials stay on the server | `server-only` imports and mocked provider tests |
| A model cannot grant access to another user's records | Primo access/tool tests and Django owner-scoped queries |
| Attachment cancellation and partial reads remain visible | Primo extraction and browser acceptance tests |
| Invoice totals and uncertainty are validated outside the model | Invoice extraction/escalation tests and synthetic fixtures |

See [AI evaluations](docs/EVALUATIONS.md) for optional live-provider checks.
The normal test suites run without paid AI calls.

## A Primo turn

```
Home Chat / Primo rail             one useChat survives client navigation
  POST /api/primo/chat             conversation id + messages + bound context
    Django save-turn               user message persisted before Qwen
    24k-character context fit      newest whole turns; newest user always kept
    Qwen chooses tools by intent   eight tools; at most four model/tool steps
      find_recipes / find_products owner-scoped discovery of stable public refs
      get_product_sales            exact product + period; as-sold accounting
      show_recipe_batch            exact recipe + portions or multiplier
      get_recipe_cost_change       exact recipe + optional earlier period
      search_usda_foods({query, scope?})
        Django action              authenticated + 20 searches/user/minute
      read_attachment({...})     admitted, owner/conversation-scoped source text
      draft_recipe({...})          schema-valid model draft; no backend call
  result.view                      explicit guarded Open recipe/product action
  result cards / one-line markers  deterministic data followed by brief prose
  stream finish                    assistant parts/status persisted once
  parallel title                   data-title updates Recent immediately
    user clicks Create recipe      Next Server Action validates + loads pantry index
      save-recipe                  explicit owner-scoped persistence
```

The five kitchen tools are declared once in `apps/web/lib/primo/kitchen-tools.ts` as a
name, description, strict zod input schema, and read-only annotations. Primo's
server adapter and the browser's WebMCP adapter both consume that registry and
both call `runKitchenTool`; there is no second input contract or kitchen
calculation. Primo also exposes the existing USDA search and draft tool, plus a private
conversation attachment reader. A batched manifest resolves all user-bound
sources before history trimming can hide them; bounded sections are read on
demand with the same ownership checks. The reader is not a WebMCP tool.

The model never invents or prints ids. Its allowed refs begin with the current
recipe, current product, and exact refs bound by user `@` mentions, then widen
only with refs returned by `find_recipes` or `find_products` in the same
request. The route renders the page refs and each mention's label-to-ref mapping
into an explicitly untrusted identity-context data block in the model
instructions; assistant metadata grants no refs. An unknown ref is a returned
failure, not a query. The backend's
authenticated owner/kitchen query remains the security boundary. WebMCP has no
conversation-level allow-list; the browser agent must discover a ref first,
and Django still scopes every read.

Discovery reports every normalized name that occurs more than once. An
explicit mention wins over page or prose inference; otherwise ambiguity is
shown as bound choices and neither adapter silently picks a row. Tool-returned
names and descriptions are untrusted data, never instructions.

Django uses today's recipe structure at both cost boundaries; only
ingredient-price history changes. `get_recipe_cost_change` therefore accepts
an exact recipe ref and optional period start, while the deterministic card is
authoritative and Qwen only explains it.

The batch tool derives a temporary production scale from the saved commercial
portion and compatible Total Yield/UOM equivalency; its card opens the existing
Batch Size lens through `?batch=<factor>` on every recipe tab and writes
nothing. The Cost tab and tool share `scaleBatchCost`, so ingredients, portions,
and labor use the same factor. The sales tool reads an explicit calendar window
and opens `?start=…&end=…&view=as_sold`, so the page shows the same Units and Net
sales figures and bundle allocation is never counted as additional revenue.

Periods are resolved by Forkluck against the kitchen's local date. Accepted
forms are a year, month, date, bounded date range, or one of the eight dashboard
presets. Current periods clamp to today and future periods fail.

`search_usda_foods` calls the existing `search-nutrition-foods` action. Its
FoodData Central rows are candidates — description, data type, brand, and FDC
id — and neither create nor link a pantry ingredient. `draft_recipe` only
validates and echoes a proposed title, yield, lines, and steps for a review
card. Persistence begins outside the model loop when the user clicks **Create
recipe**. That Server Action validates the draft again and links a line only
when one and only one row in the owner's active pantry has the same normalized
name. Zero matches or two or more rows with that normalized name leave the line
unlinked; query order never chooses among duplicates. The action then calls the
existing `save-recipe` action. USDA ids are never used as pantry ids, and no
draft supplies a trusted object identity.

Primo is presence-enabled by `QWEN_API_KEY`. Requests use the Virginia
DashScope-compatible endpoint and the moving `qwen3.7-plus` alias by default.
Sanitized conversation prose and the data used in the model loop leave
Forkluck for Alibaba: tool inputs, recipe titles, product names and SKUs, USDA
candidate metadata, the proposed recipe draft, sales units and revenue, batch
and labor figures, and, for a cost request, at most the 40 largest absolute line
deltas plus totals and coverage. Request storage is in Virginia and inference uses
Alibaba's Global processing scope. A USDA search separately sends its query and
the server-only `FDC_API_KEY` to `api.nal.usda.gov`; the key is never sent to
the browser or Qwen. The active-pantry index, the identities selected at
confirmation, and the confirmed `save-recipe` call remain server-side and
outside the model loop. Forkluck request logs contain only request id, model,
duration, and finish reason; they do not contain prompts, tool payloads,
supplier data, or recipe data.

Primo transcripts live in Forkluck's database, scoped to the signed-in user.
The user can list, rename, archive, restore, and delete them; deleting the
account cascades through both conversations and messages. They are retained
until the user deletes them. Persistence is not a new data-egress path: only
the fitted prose and existing tool loop data cross the already documented
Alibaba boundary. Primo attachments additionally send images/scanned pages to
the existing Qwen vision provider and bounded extracted document content to
the chat model. Attachment references and feedback are owner-scoped in Django;
files use the shared private document store. See the attachment lifecycle and
experience matrix in `docs/CONTRACT.md`.

## A WebMCP turn

```
authenticated AppShell                 feature-detects document.modelContext
  registry's five descriptors          strict JSON Schema, read-only annotations
    executeKitchenTool                 progress line + cancellation checks
      runKitchenToolAction             requireUser first; same server runner
        runKitchenTool                 existing owner/kitchen-scoped Django reads
      result.view                      confirmed navigation; await transition
    plain result object                returned to the browser agent
```

The five tools register for the authenticated shell's lifetime with one
`AbortSignal`. Unsupported or permission-disabled browsers keep the ordinary
app unchanged, and one rejected registration cannot stop the others. WebMCP
returns the plain tool result: there is no content envelope and no toast. A
successful acting result navigates to the normal recipe or product screen and
resolves after the route transition, raced against a three-second timeout. No
second Django route or business-logic implementation exists.

The invariant matrix for both adapters is:

| Concern     | Accepted state                                             | Refused or preserved state                                       |
| ----------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| identity    | bound mention, open page, or same-turn discovery           | guessed/foreign ref returns `unknown_ref` or `not_found`         |
| ambiguity   | one exact row                                              | duplicate normalized names are exposed, never picked             |
| periods     | preset, year, month, day, or ≤365-day range                | future start and malformed/oversized ranges fail                 |
| batch       | portions with a saved portion size, or explicit multiplier | no scale returns `needs_scale`; factor clamps to the lens limits |
| accounting  | product's as-sold units and net sales                      | allocated bundle revenue is not added again                      |
| lifecycle   | one chat in the app shell; Primo navigates only on a user click    | closing/docking does not stop or duplicate a stream              |
| persistence | all five kitchen tools are reads                           | batch and navigation never update the recipe or product          |
| trust       | returned names are rendered as data                        | returned prose cannot direct another tool call                   |

## A write

```
form / client component     <form action={...}> or a transition
  app/(app)/<area>/actions.ts   "use server"; validate, POST, revalidate
    djangoAction(slug, body)    POST /internal/v1/actions/<slug>/
      http/dispatch.py          ACTIONS registry + the error funnel
        domains/<d>/actions.py  handler(user, payload) -> dict
          models.py
```

Every mutation is one POST to `actions/<slug>/`. There is no second write
route. `dispatch.action` is the only place a backend failure becomes an HTTP
status code, and every error body is exactly `{"error": "<message>"}`. A
handler's returned dict _is_ the response body.

Server Actions are separately reachable entry points; a page-level check does
not cover the actions defined beside it. An action whose only work is its
Django POST is authenticated by `internal_user` on that POST. An action that
does any local or third-party work before its first backend call must call
`requireUser()` first, or that work becomes an unauthenticated endpoint.

Every action returns its payload or `{ error: string }` — expected failures are
data, because Next redacts uncaught Server Action errors in production. The
shape is always the same: validate with zod, `await djangoAction(...)` inside a
`try`, `revalidatePath` every affected route, and in the `catch` return
`actionErrorMessage(cause, "<fallback>")` from `apps/web/lib/backend/action-error.ts`,
which sends an expired session to `/login` instead of a dead page.

## Backend layers

```
internal_urls.py / public_urls.py   route tables
  http/dispatch.py                  the one action route, registry, error funnel
    domains/                        accounts ingredients invoices labor
                                    recipes sales search workspace
      integrations/                 square shopify pos_sync pos_oauth
                                    emails exchange_rates token_crypto
                                    turnstile
        models.py                   every table
```

Imports run one way down that list. Each domain holds its own `views.py`
(reads), `actions.py` (writes and the `ACTIONS` registry it owns), and
`serializers.py` (JSON shapes). Sales keeps all three in `core.py` and
`views.py`.

Leaf modules — `http/request.py`, `http/auth.py`, `domains/shared/` — import
nothing from domains, integrations, or dispatch, so anything may import them.
Domains are independent of each other.

These rules are executable, not advisory: import-linter contracts in
`apps/api/pyproject.toml` enforce the layering, the leaves, and the domain
independence. POS adapters live in `integrations/pos_sync.py` and only acquire
and normalize provider data; `domains/sales/pos_sync.py` owns interpretation,
persistence, accounting, leases, and job state, and
`domains/sales/connections.py` owns the connection rows, their JSON shape, and
the connect/disconnect slugs. This removes the former
integration-to-sales-domain exception.

Every action handler is registered from a domain. The layers contract cannot
say so on its own — integrations legitimately sits below dispatch, so
`dispatch -> integrations` reads as a downward import even when what it pulls
up is a user-facing write. Two guards close that gap: the
"Dispatch reaches integrations only through domains" contract forbids the
direct import (`token_crypto` excepted, because the error funnel names its
exception type), and `test_contract.py` asserts every handler in
`dispatch.ACTIONS` lives under `forkluck.domains.`.

```bash
cd backend && .venv/bin/lint-imports
```

## Where the contract is pinned

The HTTP surface between the two processes is described in four places, and
they must move together:

| Place                                             | Pins                                                                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/forkluck/test_contract.py`               | Route tables, every action slug and its handler (`EXPECTED_ACTIONS`), serializer keys recursively, and that `docs/CONTRACT.md` lists the same slugs |
| `docs/CONTRACT.md`                                | The same surface in prose, including the error funnel                                                                                               |
| `apps/web/lib/backend/types.ts` + `apps/web/lib/backend/schemas.ts` | The payload shapes the frontend expects                                                                                                             |
| The reviver in `apps/web/lib/backend/client.ts`            | Which keys arrive as `Date` rather than `string`                                                                                                    |

The reviver allowlist is the one that fails quietly: a serializer that emits a
timestamp under a key outside the list delivers a `string` to a frontend that
expects a `Date`. Date-only fields (`periodStart`, `periodEnd`, `invoiceDate`,
`effectiveFrom`, `currentRateEffectiveFrom`) are excluded on purpose — reviving
them would shift the day by a timezone.

## How to add an action

1. Write `action_<name>(user, payload) -> dict` in the owning domain's
   `actions.py` (`domains/sales/core.py` for sales). Validate the payload with
   the helpers in `domains/shared/values.py`; raise `ValueError` for anything
   the user can fix.
2. Register the slug in that module's `ACTIONS` dict. Dispatch composes the
   per-domain registries and refuses to start if two domains claim one slug.
3. Add the slug to `EXPECTED_ACTIONS` in `apps/api/forkluck/test_contract.py`.
   The count is frozen there too.
4. Add it to the action list in `docs/CONTRACT.md`.
5. Call it from a `"use server"` action that validates its input, awaits
   `djangoAction` in a `try`, revalidates the routes it changes, and returns
   `{ error: actionErrorMessage(cause, "…") }` on failure.

   An action whose caller handles rejection throws instead: the `undo*`
   receipts, `mergeIngredients`, `setPreferredSupplierItem`,
   `getCurrencyConversionQuote`, `loadPosSyncRun`. Those call
   `await requireUser()` first, because they have no catch to redirect an
   expired session from. `apps/web/tests/action-auth-pins.test.ts` pins every action to
   one shape or the other.

6. If the response carries a new payload shape, describe it in
   `apps/web/lib/backend/types.ts` (and `apps/web/lib/backend/schemas.ts` if the endpoint is one
   of the validated reads).
7. If it emits a timestamp under a new key, add that key to the reviver
   allowlist in `apps/web/lib/backend/client.ts` and to `docs/CONTRACT.md`.

## Repository layout

The repository is a pnpm workspace. The Next.js app, the Django API, the
connector service, the catalog, and the agent skills live side by side; the
root `package.json` scripts delegate to them.

| Path                   | What lives there                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/`            | The Next.js app (`@forkluck/web`): `app/` routes ((app) pages and their `"use server"` actions, (auth), `shared/`, `api/`), `components/` (with `components/ui` the shadcn/Base UI primitives), `hooks/`, `lib/` (the `lib/backend/` Django seam plus framework-free parsing, costing, and import modules), `tests/` (Vitest suites and real-stack Playwright acceptance tests), `scripts/` (the acceptance harness and the extraction and Primo evals: `pnpm eval:extraction`, `pnpm eval:primo`) |
| `apps/api/`            | The Django project; `apps/api/forkluck/` is the app. `forkluck/paths.py` locates `data/` by walking up, so the same code runs from a checkout and from a release tree |
| `services/connectors/` | The supplier connector service: its own Django project, worker, Dockerfile, `deploy/`, and operations guide. It talks to the app only over the protocol in `docs/CONNECTOR_PROTOCOL.md` |
| `data/`                | Shared data read by both sides: `parser-vocabulary.json`, `volume-measures.json`, and the open CC0 ingredient catalog under `data/catalog/`                          |
| `skills/`              | Agent Skills for coding agents working on this repository, validated by `scripts/validate-skills.py`                                                                 |
| `deploy/`              | Reference nginx, systemd, and provisioning for a self-hosted server                                                                                                   |
| `docs/`                | The internal API contract, connector protocol and schema, deployment guide, review workflow, and ingredient-measure policy                                             |
| `scripts/`             | Repository-level scripts: the publication audit, skill validation, and Codex skill links                                                                              |

The production release tree differs from the repository tree: the package job
in `.github/workflows/deploy.yml` assembles `frontend/` (the standalone Next
build), `backend/` (the Django project), and `data/`, which is what
`deploy/deploy-forkluck` and the systemd units expect.

## Money and currency

Every persisted `*_cents` column belongs to one of three kinds, and the kind
decides what a workspace currency change does to it.

**Workspace money** is an estimate the workspace owns and compares against
itself: ingredient and supplier pack prices, price history, menu prices, bench
costs, the default wage, employee rates, time-entry costs, labour-import
totals, and the menu worksheet's sell prices and original snapshots. It is
denominated in the workspace's current currency, carries no
currency column, and is restated in place by
`domains/workspace/currency.py::convert_workspace_currency`. These have to move
together — labour cost is read as a percentage of revenue and ingredient cost,
so converting one and not another silently corrupts the ratio.

**Document money** is a fact about a past transaction with a third party: what
a supplier billed (`Invoice`, `InvoiceLine`) and what a POS took (`SalesImport`,
`SalesLine`, `SalesModifierOption`, and `SalesLineModifier` via its line). It
carries its own `currency_code`, is never restated, and must always be
formatted with that code rather than the workspace's. Restating it would
falsify the record.

`IngredientInvoicePrice` is a tenant-owned many-to-many reference from an
ingredient to an `InvoiceLine`, not another money value. Its displayed price is
always derived from the immutable document line and formatted in that line's
currency. Its optional size/unit describe how that purchase prices the
ingredient. `InvoiceLine.ingredient` remains the single expense classification
and `SupplierItem.ingredient` remains the single remembered supplier mapping;
neither limits how many ingredients may reference the same purchase price.

The master price catalog (`CatalogProduct`, `CatalogPriceObservation`) is
global USD reference data that every workspace reads and none owns, so it is
neither converted nor stamped.

`forkluck/test_currency_invariant.py` enumerates every money column in the
schema and fails when a new one is added without being classified, so this
decision cannot be skipped by accident.

## Billing

`integrations/stripe.py` is the stdlib Stripe client. It pins
`2025-12-15.clover`; subscription periods therefore come from subscription
items, not the top-level subscription object. It URL-encodes provider ids and
accepts stable idempotency keys for create commands. Safe provider errors log
only method, status, and error code.

`domains/accounts/billing_configuration.py` validates one exact hosted setup:
the Stripe account, active $7 USD monthly licensed price, its active product,
and the enabled public webhook with exactly four event types and the pinned API
version. The five environment values are all-or-none: API secret, webhook
secret, price id, product id, and endpoint id. Deploy performs live provider
validation before migrations and persists HMAC secret digests after them.
Checkout reads that local attestation, including signed-delivery proof for the
current webhook secret; it does not add configuration round trips to the
locked-user recovery path. A provider dashboard change becomes current through
the validation/provisioning command or the next deploy.

Provider identity and entitlement are normalized under `BillingAccount`:
multiple `StripeCustomer` and `StripeSubscription` rows are retained, while
`status`, `trial_end`, and `locked` are the one denormalized account decision.
`domains/accounts/billing_reconciliation.py` is its sole writer. A pass claims
a monotonically increasing generation in a short transaction, reads every
provider customer and subscription outside a transaction, then commits only if
no newer generation superseded it. Missing snapshot rows stop contributing to
access. Precedence is active, trialing, past due, then the newest lapsed status.
`locked` means one thing only: the account is being deleted. A lapsed
subscription unlocks and goes read-only. The dispatch and guest-link gates read
only the stored decision plus the account's own clock, at one query regardless
of customer count, while disabled/demo/staff exemptions remain zero-query.

`domains/shared/billing.py` holds the plan catalog those gates spend. The
hosted plans are `paid`, `trial` and `expired`. Status maps to a plan: active,
trialing and past due are paid, and every other status is trial or expired by
the clock. The trial is app-side and calendar-based, computed as
`max(user.date_joined, TRIAL_FLOOR) + 14 days` with no extra column and no
extra query; `TRIAL_FLOOR` is the launch date, so accounts older than it get
their full 14 days from launch, and editing `date_joined` in the admin is how a
trial gets extended. Stripe never trials: Checkout starts a paid subscription
and nothing else. The disabled/demo/staff exemptions are paid with no clock.
The plan indexes one declarative dict of entitlements per plan, which
`billing_json` ships to the session together with `trialDaysLeft`. Trial and
paid share every flag, Primo included; expired has none, and there is no recipe
cap on any plan. Expired means read-only: every read works, and every action
outside billing is refused with `subscription_required` and a sentence that
says whether the trial or the subscription ended (`write_refusal`). A new
account needs no card, and a canceled one keeps everything it made. Changing a
limit is an edit to that dict; the gates raise `EntitlementError`, which
dispatch turns into a 403 carrying the raiser's code.

`domains/accounts/billing.py` owns Checkout, portal, return-page sync, webhook,
and account deletion. Checkout reserves a local customer and attempt before a
provider call; their UUID-based idempotency keys survive timeouts and repeated
clicks. A provider customer can bind only to its unique local reservation (or
an already persisted binding), never from a user-id metadata claim alone.
Completed attempts retain Stripe's subscription id; replacement Checkout and
account deletion stay fenced until that exact subscription appears in the
normalized mirror. Portal choices carry tenant-scoped local customer UUIDs,
not provider ids.

Signed webhook events are durably unique by Stripe event id and use a
recoverable processing lease. Supported events trigger the same complete
account reconciliation as browser sync; duplicate and out-of-order payloads
therefore cannot overwrite the current provider snapshot. Busy, unknown, and
failed work answers 503 so Stripe retries; processed and retired-customer
deliveries answer 200. User deletion first marks the account deleting, expires
in-flight Checkout, reconciles, cancels every cancellable provider
subscription, and tombstones customer ids. Only then is local user data
deleted; provider failure leaves the user locked and retryable.

## The analysis model

`apps/web/lib/recipe/` holds the deterministic paste parser, ingredient profiles, source
matcher, and calculation engine.

- Water and dry matter are complementary and sum to 100% of mapped mass.
- Fat, protein, sugars, starch, fiber, salt, and other are subdivisions of dry
  matter.
- Bread signals are baker's percentages relative to mapped flour mass.
- User-selected USDA FoodData Central profiles override the visible local seed
  profiles. Unmapped ingredients stay in total batch mass but are excluded from
  composition; coverage falls accordingly and suppresses the numeric panel.
- Values describe the raw entered batch. Cooking loss, evaporation, fermentation
  changes, and final baked yield are not modeled here.
- Source similarity uses normalized ingredient-set overlap. Current records are
  clearly labeled demo entries, not live web-search results.
- `/recipes/compare` (`apps/web/lib/recipe/compare.ts`) is where the bread
  signals surface: saved recipes arrive weighed by the nutrition read, a
  pasted recipe is weighed by the paste parser in the browser, and both are
  aligned as baker's percentages. Pasted formulas stay in the browser and are
  never saved as recipes.

The label preview on a recipe's Nutrition tab is a different engine:
`apps/api/forkluck/domains/recipes/nutrition.py` walks the normalized recipe
lines (and nested recipes) in Python, weighs each line through the same
ladder costing uses, keeps each line's yield after cooking, and divides by
the declared finished weight when one is stated. TypeScript only rounds and
formats what that read returns. The invariants are pinned in
`docs/INGREDIENT_MEASURES.md` under "Nutrition invariant matrix".

Private recipes are never published, indexed, or added to a shared similarity
corpus.

## Self-hosting

SQLite is the default and needs no configuration; setting `DATABASE_URL`
switches Django to PostgreSQL and marks the environment as production, which
also disables the demo account and seed. `deploy/` carries the reference
setup — nginx in front, Gunicorn, the Next.js standalone server, and the POS
worker under systemd.

Every third-party check is optional and off until configured: leave the five
`STRIPE_*` variables unset and billing stays off, leave the Turnstile pair unset
and sign-up is ungated.

[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) covers releases and the server layout.
