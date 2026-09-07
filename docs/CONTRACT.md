# Internal API contract

Reference for the HTTP surface between the Next.js app and the Django
backend. Everything below is pinned by `apps/api/forkluck/test_contract.py`
and typed in `apps/web/lib/backend/types.ts`. Change one, change all three.

## Domain glossary: Products and Menu forecast

These terms are contract-level names. They keep provider identity, ledger
facts, and read-time planning projections distinct.

**Provider channel** — an external sales system (`square` or `shopify`) that
owns provider accounts, catalog identities, variants, and sync jobs. A
provider channel is not a synonym for every source of a ledger fact.

**Ledger channel** — the source classification of a stored financial fact.
Provider channels are ledger channels; a manual ledger entry has no provider
account or provider object identity. Every row retains its source channel for
attribution and audit.

**Manual entry** — a user-authored ledger fact with a local business date and
tenant currency/timezone. Repeated SKU or name text remains repeated source
rows; matching must not deduplicate repeated identity text.

**Menu membership** — a product's membership in a selected `Menu`, through a
`MenuItem`. Membership scopes menu forecast reads; it does not rewrite the
product catalog or historical sales.

**Product composition** — the product's current linked recipe/material graph,
expanded at read time with canonical UOM, yield, and efficiency semantics. It
is not a historical snapshot and does not mutate sales facts. A recipe
component's `unit` is blank for whole batches per sold product, or a unit for a
measured share of the recipe batch (500 g of a 20 kg batch), resolved against
the recipe's yield the way a nested recipe line is.

**Daily consumption** — physical quantity attributed to a product or material
for a workspace-local calendar day after canonical line interpretation, variant
multipliers, bundle expansion, mapped modifiers, and product-composition
expansion. Each row names its `source`: `base` for the product the variant
sold, `bundle` for a product reached inside a bundle, `modifier` for a mapped
modifier occurrence. Revenue attribution is separate; refunds reverse physical
consumption.

**Forecast basis** — the selected menu's product membership and the eight prior
matching weekdays in the workspace timezone, each week back weighted at 80% of
the one after it and counted only from when the product existed. It is not a
tenant-wide product set, nor an undifferentiated aggregate of the window.

**Projected demand** — a read-time, non-persisted estimate derived from daily
consumption in the forecast basis and product composition. It is a planning
projection, never a ledger fact, import, sync result, or undo target.

**Manual monthly import** — a manual ledger batch used to enter monthly
history. It is hidden from import history/latest and the generic
`undo-sales-import` action refuses it; hiding is not deletion or ignoring.

## Route groups

| Prefix             | Module                              | Caller              | Auth                                                                     |
| ------------------ | ----------------------------------- | ------------------- | ------------------------------------------------------------------------ |
| `/api/...`         | `apps/api/forkluck/public_urls.py`   | Browser             | Django session cookie; CSRF token on writes (`/api/auth/csrf` issues it) |
| `/internal/v1/...` | `apps/api/forkluck/internal_urls.py` | Next.js server only | Forwarded Django session cookie **and** `X-Forkluck-Internal-Secret`     |

Next.js also owns `POST /api/invoices/parse`, `GET /api/invoices/drive-file`
and `POST /api/primo/chat`. They are browser-facing route handlers rather than
part of Django's public route table — nginx sends only `/api/auth/`,
`/api/billing/` and `/api/integrations/` to Django, everything else reaches
Next. Primo requires an explicit same-origin `Origin`, a valid Django session,
a configured provider, and a strict body before it contacts Qwen.
`drive-file` streams one document out of the connected Drive folder for the
import dialog's review pane, under the same same-origin, session and
`invoiceAi` entitlement guards as `parse`, and refuses any file whose ancestry
is not the folder this workspace connected. There is no cross-origin handler:
the marketing site signs newsletter subscribers up through Ghost's own
double-opt-in form, not through the app.

The browser auth client bounds the CSRF handshake and its one POST with a
shared 30-second deadline. Network, timeout, and unreadable-response failures
return an error to the form; they never leave a rejected promise holding the
control pending, and POSTs are not automatically retried.

| Browser auth boundary | Invariant |
| --- | --- |
| Admission and precedence | A failed CSRF handshake does not send the write; existing verification responses retain their meaning |
| Lifecycle | An interrupted request releases the pending control and permits an explicit retry |
| Identity and downstream | Sign-out errors preserve the current page and local drafts; only a confirmed sign-out clears that user's drafts and navigates to login |

`parse` returns one JSON result (`{documents}` or `{error}`). After validating
the origin, session, entitlement and upload body, it sends leading JSON
whitespace immediately and every 15 seconds until the result is ready. The
response disables buffering and caching, keeping nginx's 120-second idle
timeout from cutting off a scan that needs a second AI pass. Callers still
read the response with `response.json()`; a disconnected or non-JSON response
is a retryable read failure, never an import.

| Invoice read boundary | Invariant |
| --- | --- |
| Admission | Refused origins, sessions, plans and bodies never start extraction or a heartbeat |
| Upload transport | The maximum 8,000,000-byte photo, base64-encoded with JSON metadata, must fit through nginx's 12 MiB body limit before the route applies its file limits |
| Long reads | Uploads and Drive reads keep sending bytes while either AI pass runs; one final JSON result preserves line identities and boxes |
| AI latency | Default Qwen Flash reads and optional escalation share 25 seconds per document; an expired second pass keeps the first usable read and its review findings |
| Failure and lifecycle | Read errors remain JSON; completion, failure and response cancellation clear the heartbeat |
| Retry and file identity | Retry or reselecting a failed upload (name and size) or Drive file (id) reuses its queue entry and clears stale batch errors; queued, running and completed files are reused without a duplicate warning or another read |
| Downstream | Reading does not import invoices or apply prices; a broken response offers Retry without exposing proxy HTML |

Receipt normalization recognizes Wegmans' quantity/price prefix layout. A
misplaced positive pair may move only to the immediately following purchase
line when it contradicts the source amount, matches the next amount within
two cents, the next line has no quantity or unit price, and both document boxes
confirm the printed order on the same page. Explicit source units or model
uncertainty prevent that correction. Normalization preserves the reader's
rectangles, item amounts, names, positions and raw extraction evidence. A
price prefix misfiled as pack size still participates in
arithmetic validation, so an inferred unit price cannot hide its mismatch.

For new image-backed AI reads, that same verified quantity transfer also
checks the already prepared pixels. A source rectangle containing exactly two
separated text rows, with ink in the amount column on the first row alone, is
split at their blank gap: the first item's highlight ends there and the next
item's highlight includes its quantity prefix. Ambiguous or unavailable pixels
preserve the original boxes. This uses no extra model call or PDF render. The
reader stores these refined rectangles with the extraction; normalization
preserves them and the numeric transcription. Existing stored extractions need
a fresh read to gain pixel-refined highlights. When adjacent same-page item
rectangles overlap, the pixel check also looks through the next rectangle to
find both amount rows, then trims the first at their blank gap. A quantity
prefix added above the item preserves that corrected bottom edge. All box
comparisons use normalized page fractions, including mixed model grounding,
pixel and refined fractional coordinates. Refining only one rectangle must
preserve numeric normalization and must not trigger an extra AI read. The
prefix pixel crop stops at the following item's top so that an oversized
source rectangle cannot mistake part of that item for another prefix row.
If that crop cuts through the prefix, its visible start still identifies the
gap; the quantity text need not fit entirely inside the crop. A crop with no
visible prefix text remains unchanged.

| Receipt quantity boundary | Invariant |
| --- | --- |
| Syntax and source | Numeric quantity/price fields and an exact `quantity @ price` pack string are accepted; synthetic prompt examples contain no private receipts |
| Identity and precedence | Only Wegmans receipts use prefix reassignment; explicit source units, conflicting target values, uncertainty, missing/reversed boxes or page breaks leave the original assignment for review |
| Arithmetic | A pair already matching its source stays there; a mismatch that does not match the immediate next line remains a finding, never an automatic price update |
| Lifecycle | Uploads, attended Drive reads and stored inbox extraction normalization use the same rule; raw evidence is unchanged, and this release does not rewrite imported invoices |
| Downstream | Corrected quantities and unit prices reach matching, review and import together with their reader-supplied rectangles; line amounts and identities never move |
| Highlight ownership | New reads split a verified misplaced prefix only at an unambiguous pixel gap; quantities, amounts and item identities are unchanged by the pixel pass, and the two highlights share a boundary without overlap |

`internal_user` in `http/auth.py` guards every internal view: a missing or wrong
secret returns **404** (the route denies its own existence), a valid secret
without an authenticated session returns **401**. `apps/web/lib/backend/client.ts` is the
only client — it forwards the incoming cookie header, attaches the secret
from `FORKLUCK_INTERNAL_SECRET`, and turns a 401 into
`BackendUnauthorizedError`.

## Public routes (`/api/`)

The feedback board's confidential OAuth client uses three additional public
routes: `GET auth/feedback/authorize`, `POST auth/feedback/token` (form-encoded
client authentication), and `GET auth/feedback/profile` (bearer token). They
are disabled without `FORKLUCK_FEEDBACK_CLIENT_SECRET`; codes and tokens live
for two minutes and disclose only the verified user's UUID, display name and
email. The exact callback, client, scope, lifecycle and rejection matrix are in
[FEEDBACK.md](FEEDBACK.md). Neither browser cookies nor these profile tokens
authorize the other service's data API.

| Route                           | Name                     |
| ------------------------------- | ------------------------ |
| `auth/csrf`                     | `csrf`                   |
| `auth/session`                  | `public-session`         |
| `auth/register`                 | `register`               |
| `auth/verify-email`             | `verify-email`           |
| `auth/resend-code`              | `resend-code`            |
| `auth/request-password-reset`   | `request-password-reset` |
| `auth/reset-password`           | `reset-password`         |
| `auth/change-password`          | `change-password`        |
| `auth/login`                    | `login`                  |
| `auth/logout`                   | `logout`                 |
| `integrations/square/connect`   | —                        |
| `integrations/square/callback`  | —                        |
| `integrations/shopify/connect`  | —                        |
| `integrations/shopify/callback` | —                        |
| `billing/stripe-webhook`        | `stripe-webhook`         |

Every route that opens a session (`auth/register`, `auth/verify-email`,
`auth/login`) also sets `forkluck_signed_in=1` — a script-readable, no-identity
cookie on the parent domain that lets forkluck.com show Log out instead of
Sign in; `auth/logout` deletes it.

`auth/change-password` requires an authenticated session, CSRF, the current
password, and a new password accepted by Django's configured validators. The
new password must differ from the current one. A successful change preserves
the requesting session, invalidates other sessions through Django's password
hash, and retires unused password-reset codes. Wrong-current-password attempts
are limited per account and client address for 15 minutes; the demo account
cannot change its shared password.

| Password-change state                              | Result                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| no session or CSRF                                 | refused before password comparison                               |
| wrong current password or exhausted attempt budget | no password or session change                                    |
| weak, reused, or mismatched new password           | client/server validation; no password change                     |
| accepted new password                              | current session kept; other sessions and reset codes invalidated |

The four `integrations/` routes are OAuth redirect endpoints served by
`integrations/pos_oauth.py`; they redirect rather than return JSON.

When `FORKLUCK_ADMIN_CODE_LOGIN` is enabled, every `/mommy/` endpoint requires
an active staff session that completed the admin-purpose email code. Ordinary
password or email-verification login still grants application access, but
does not grant staff-console access. The proof is bound to the current account
in its session; existing sessions without proof must complete the admin login.
With code login disabled, normal active-staff authorization applies.

`billing/stripe-webhook` is the one unauthenticated public POST: the
`Stripe-Signature` HMAC is the authentication. It answers **404** when billing
is not configured. Signatures cover the exact raw request bytes and must be no
more than five minutes old. A new event is persisted before reconciliation.
Duplicate processed events answer 200 without repeating work; an active lease,
an unknown non-retired customer, a superseded refresh, or a provider failure
answers `503 {"error": "Billing refresh failed", "code": "billing_retry"}`
(the active-lease message differs) so Stripe retries. A retired customer and a
successfully reconciled event answer `200 {"received": true}`. Reusing an event
id with different type, customer, subscription, or live/test mode is 400.

### Throttling

`auth/login` budgets password attempts per normalized address and per client
IP (fixed windows) and answers `429 {"error": ..., "code": "rate_limited"}`
when either is spent. Attempts are counted before the password check; a
successful sign-in refunds the address budget, deliberately not the client
budget. The code-emailing endpoints (`auth/register`, `auth/resend-code`,
`auth/request-password-reset`, unverified `auth/login`) are budgeted the same
way per address+purpose and per client IP and answer `400` with the issuance
message when exhausted. Issuing a code retires the address's previous unused
codes for that purpose; a code whose email fails to send is removed rather
than left usable.

`emailVerifiedAt` means that a signup or password-reset code was consumed. A
development registration may grant a session without setting it; production
requires verification before granting a new session. Verifying an address for
the first time also claims the guest links waiting on it: each becomes a share
row carrying the role it was invited with, and the link is deleted.

The same pass claims the recipe books waiting on the address, and it runs
first: every recipe in a book becomes a share row at the book's role, and the
book is deleted. Books before links means the more specific grant wins where
both name one recipe. A book entry over the new account's own recipe is
dropped rather than shared back, exactly as a link over it is.

The same pass claims the kitchen invites waiting on the address: each becomes
a `KitchenMembership` carrying the role it was invited with, and the invite is
deleted. An invite to the new account's own kitchen is dropped rather than
claimed — an owner needs no membership — and a second claim finds nothing,
because the invitations are gone. A kitchen invite carries no token and never
expires; the address is the whole of it.

## Internal routes (`/internal/v1/`)

Read endpoints (GET) unless noted.

```
session/
primo/conversations/
primo/conversations/<uuid:conversation_id>/
newsletter/
search-index/
ingredients/
ingredient-options/
ingredient-tags/
ingredient-categories/
ingredient-measures/
ingredient-duplicates/
ingredient-imports/
matches/
pricing-entries/
recipes/
recipe-health/
recipes-export/
dashboard-overview/
recipes/<str:recipe_ref>/
recipes/<str:recipe_ref>/cost-diff/
recipes/<str:recipe_ref>/nutrition/
guest/recipes/<str:token>/
guest/books/<str:token>/
recipe-categories/
cost-recipes/
cost-recipes/<str:recipe_ref>/
cost-for-recipe/<uuid:recipe_id>/
menus/
menu/<str:menu_ref>/
menu/<str:menu_ref>/forecast/
menu-sources/
menu-component-price/
business-settings/
kitchen-members/
activity/
labor-overview/
labor-employees/<uuid:employee_id>/
sales-overview/
sales-imports/
pos-connections/
pos-sync-runs/
pos-sync-runs/<uuid:sync_run_id>/
invoices-overview/
invoice-suppliers/
invoice-line-options/
payment-methods/
invoices/<uuid:invoice_id>/lines/
invoices/<str:public_id>/
ai-credential/
drive-folder/
drive-files/
supplier-items/
connector-sync-runs/
connector-sync-runs/<uuid:run_id>/
menu-overview/
menu-items/
menu-product-rows/
product/<str:product_ref>/
product-categories/
sales-identity-lines/
system/drive-watch/
system/invoice-ai-usage/        POST only
system/drive-watch/save/        POST only
system/drive-files/             GET and POST
system/invoice-line-status/     POST only
system/drive-extractions/       POST only
system/drive-extractions/failed/ POST only
actions/<slug:action_name>/     POST only
```

### System routes (`/internal/v1/system/`)

A system route is authorized by the internal secret alone: no session, no URL
token. It is what the Next process calls as itself — today only the Drive
watcher, which runs on a timer in `instrumentation.ts`, polls the Google Drive
Changes feed once for the whole service account, and has no browser request
behind it. A system route never reads `request.user`; the workspace is named
in the body. Without the secret they answer 404 like every other internal
route. `apps/web/lib/backend/client.ts` calls them with `djangoSystemGet` and
`djangoSystemAction`, which send the secret and no cookie.

`GET system/drive-watch/` answers `{pageToken, polledAt, lastError, folders}`.
The first three are the shared Changes cursor, reading `{"", null, ""}` before
the first save. `folders` is every connected Drive folder, newest first, each
`{userId, folderId, folderName, registeredAt}`: `userId` is the workspace the
folder belongs to and what the watcher posts back, and `registeredAt` is null
until the watcher has listed that folder in full at least once — a folder
connected before Changes were tracked, or since the last poll, whose existing
documents no Changes page would mention. Reconnecting a folder resets it to
null.

`POST system/drive-watch/save/` takes `{pageToken, polledAt, lastError}`
(`pageToken` and `lastError` may be `""`, `polledAt` may be null) and returns
`{ok}`. One `DriveWatchState` row serves every workspace: the service account
holds one Changes cursor for every folder shared with it, so the Next process
polls once and registers each changed file to the workspace whose connected
folder is its ancestor.

`POST system/drive-files/` takes `{userId, files, markRegistered?}` and returns
`{registered, removed, newCount}`. `userId` must name a workspace with a
connected folder, else the route answers 404 `{"error": "No connected Drive
folder for that workspace"}`. `files` carries the entries described under
**Drive registry** below, at most 500, and is applied to that workspace alone.
`markRegistered: true` records that this call was a full listing of the folder
rather than a Changes page, setting its `registeredAt`. The whole registration
runs in one transaction and locks the workspace's existing rows for the
submitted ids, so an `import-invoices` naming the same file cannot race it.

The reader stores only what the document says; what the workspace knows about
it is recomputed when the inbox opens.

`GET system/drive-files/?userId=<uuid>&status=<new|ready|failed>&limit=<n>`
answers the same `{files, count}` the session `drive-files/` read does, for the
workspace `userId` names, ordered by modified time **oldest** first (undated
files last) and then by name — a backlog is read in the order the receipts
arrived. `limit` defaults to 20 and is capped at 100; the three statuses are
the reader's business (what it owes a read, what it has read, what it failed
on) and any other value is a 400. A workspace with no connected folder answers
the same 404 as the register call.

`POST system/invoice-line-status/` takes `{userId, ...}` — the rest of the body
is exactly what the `invoice-line-status` action takes — and returns exactly
what that action returns plus `currencyCode`, the workspace's business-settings
currency. Both call one function; the currency is added because an unattended
read has no session to look one up with and a document that printed its own
currency is normalized against the workspace's.

`POST system/drive-extractions/` takes
`{userId, driveFileId, parts, model?, escalated?}` and returns
`{ok, readyCount}`. A file may hold several documents — a scanned bundle of
receipts, a photo of two of them — so `parts` is a list of 1 to 40 of them,
each `{part, document, pageStart?, pageEnd?, region?, model?, escalated?}`.
`part` is the 0-based index and is unique within the call; `document` is a
non-empty object, opaque to Django, at most 200 KB serialized; `model` is at
most 120 characters and `escalated` a boolean, taken from the body when the
part does not name its own. `pageStart`/`pageEnd` are 0-based inclusive PDF
page indexes, absolute within the whole file, and come as a pair;
`region` is `{x0, y0, x1, y1}` as fractions of the prepared photo with
`x0 < x1` and `y0 < y1`. A part carries a page range or a region, never both,
and neither for a whole-file document. A file holding one document may post it
flat instead — `{userId, driveFileId, document, model, escalated}`, the shape
before bundles — which is stored as the single part 0. The parts replace
whatever was stored for the file, and the row moves to `ready` with an empty
`reason`.
`POST system/drive-extractions/failed/` takes `{userId, driveFileId, reason}`
(at most 255 characters), moves the row to `failed`, deletes anything stored
for it, and returns `{ok}`. Both refuse a row that is not `new` or `ready` with
a 400, so a late reader never overwrites an import or a skip, and both answer
404 for an unknown file or an unconnected workspace.

`recipes/<recipe_ref>/cost-diff/?from=YYYY-MM-DD` is owner-only: shared and
foreign recipes answer 404. With no `from`, the start is midnight UTC on the
date 90 days before the one captured `toAt`; an explicit date is exact,
becomes midnight UTC, and cannot be after today. The endpoint has no custom end
date and does not write.

Its `{item}` response contains:

- `recipe: {id, publicId, title}`;
- `window: {fromAt, toAt, fromDate, toDate, days, source, comparison}`, where
  source is `default90Days` or `requestedDate` and comparison is always
  `priceOnlyCurrentRecipeBasis`;
- the explanatory `basis`, complete and comparable `totals`, `coverage`,
  `currencyCode`, and `issues`;
- symmetric `lines` whose boundary states are `priced`, `noHistory`, or
  `unpriceable`;
- `priceChangesInWindow` and nullable `lastChangeBeforeWindow`.

`fromAt < effectiveAt <= toAt` is the price-event window. Current recipe
structure, quantities, efficiencies, preparations, conversions, nested
recipes, and yields are used at both boundaries. Complete totals are null when
a required line cannot be priced; comparable totals include only lines priced
at both boundaries. `fromAt`, `toAt`, and price-history timestamps remain
ISO strings on the TypeScript side, while `fromDate` and `toDate` are date
keys.

### Primo chat route

Primo compares the explicit `Origin` against the public `Host` header and the
protocol in Next's request URL. The nginx proxy preserves `Host` and overwrites
`X-Forwarded-Proto`; Next's URL hostname is its internal listener, so it must
not be used as the public host. `X-Forwarded-Host` does not grant admission.

| Origin invariant | Required behavior |
| --- | --- |
| Syntax and precedence | Missing/opaque origins or a missing host are refused; public host, scheme, and port must match, including behind the proxy |
| Identity and ownership | An accepted origin proceeds to the existing session, plan, and conversation ownership checks |
| Lifecycle and downstream | Refused origins return 403 before a session lookup, saved turn, or model call; valid unauthenticated requests return 401 |

`POST /api/primo/chat` accepts
`{conversationId, parentMessageId, recipeRef, productRef, messages}`. The
conversation id is a client-minted UUID and the parent id is the preceding AI
SDK message id (or an empty string). Page refs
are nullable stable public refs. User messages may carry
`metadata.mentions` with at most ten `{kind, label, ref}` rows; labels are 1–200
characters and refs match the recipe/product public-id shapes. Assistant
metadata is accepted by validation but never grants identity. At most 200
messages are accepted and each user message has at most 4,000 text characters. The route
fits whole messages newest-first into a 24,000-character model context, always
retaining the newest user message and dropping older turns once the budget is
full. Mention identity is collected from all 200 accepted messages before that
fit. Validated model messages retain only non-empty
user/assistant text. Previous tool output, reasoning, file, and data parts are
discarded, but prior assistant prose remains so an offered full date can
support “since then.” The route separately renders the open refs and each
validated user mention's label-to-ref mapping into the model instructions as
untrusted identity data. This is how the model can call an exact-ref tool even
though message metadata itself is removed from model messages.

The route exposes the shared kitchen tools `find_recipes`, `find_products`,
`get_product_sales`, `show_recipe_batch`, and `get_recipe_cost_change`, plus
`search_usda_foods`, `draft_recipe`, and the conversation-scoped `read_attachment`. Tool choice is automatic, the loop
stops after four steps, output is capped at 1,800 tokens per step, and generation
aborts after 45 seconds. A turn with admitted attachments instead allows six
steps, 6,000 output tokens per step and 90 seconds for complete recipe drafts.
Extraction, file count/size, reading and history limits are unchanged.
An exact recipe or product ref is usable only when it came
from a user mention, the open page, or a `find_*` result earlier in the same
request. The cost tool projects the 40 largest absolute line deltas without
removing totals, coverage, empty-window context, or omitted-line count.

The last user message is persisted before Qwen is called. The response is
assembled with the AI SDK UI-message stream: assistant parts are upserted as
complete, aborted, or error when the stream finishes, so terminal tool parts
and stopped partial answers survive reload. On a first turn, a six-word title
is generated in parallel and emitted as a `data-title` part containing
`{conversationId, title}`. `primo/conversations/` returns the authenticated
user's narrow, paged summary list ordered by `lastMessageAt` and id;
`primo/conversations/<uuid>/` returns that user's ordered messages and answers
404 for another user's id. `lastMessageAt` and `archivedAt`, like `createdAt`
and `updatedAt`, are revived to JavaScript `Date` values.

The browser loads that same owner-scoped list and detail through stable
`GET /api/primo/conversations?page=1&archived=0&q=…` and
`GET /api/primo/conversations?id=<uuid>` routes, independent of deployment-generated
Server Action IDs. Responses retain the list `{items,meta}` and detail `{item}`
envelopes with ISO timestamps, `Cache-Control: private, no-store`, and `{error}`
for unauthenticated (401), invalid filters (400), unavailable/foreign IDs (404)
or backend failures (502). Page is 1–100,000, page size is fixed at 50, `archived`
is `0` or `1`, and `q` is at most 200 characters. History does not require a
configured model or active Primo entitlement. Browser reads have a 15-second
deadline and preserve error envelopes; failed lists never show an empty-state claim.

An incomplete tool call or token-truncated turn is an error even when the HTTP
stream closes cleanly. A server deadline emits a retryable SSE error and stores
`error`; the user's Stop stores `aborted`. Successful earlier tool results remain.
Only an unfinished tool in the actively streaming last message shows progress;
older saved partial tools display interruption and an explicit regenerate action,
including legacy messages incorrectly stored as complete. No background draft
continues after its response ends.

`draft_recipe.yield` remains a strict `{amount,unit}` object or null; count yields
use `pcs` or `slice`, with the existing accepted mass/volume slugs. A Primo-only
tool-call repair decodes a JSON-encoded yield string and revalidates the entire
draft before execution. It never interprets free text, changes quantities/units,
or repairs other malformed fields. Separate source recipes retain separate yields
and draft cards. Document draft descriptions identify the filename and available
page, and source conflicts remain visible for review. Creation still requires the
user's Create recipe action. The opt-in `apps/web/scripts/eval-primo-attachments.ts` uses
only synthetic documents and in-memory read/draft tools with the configured model;
it cannot query or mutate kitchen data.

`apps/web/app/(app)/actions.ts::runKitchenToolAction` exposes the same five read-only
kitchen tools to `document.modelContext`. It authenticates first and calls the
same strict schemas and server runner. WebMCP has no conversation allow-list;
Django's owner/kitchen scoping and not-found responses remain authoritative.
Provider and tool failures return generic messages; request logs contain only
request id, model, duration, finish reason, and whether the deadline elapsed.

`session/` returns `{user, billing, kitchens}`, where `billing` is
`{status, trialDaysLeft, locked, plan, entitlements, recipeCount}` — a constant
shape, never null. `status` is
`"disabled"` when billing is switched off (self-hosted), for the demo
account, or for a staff account, `"none"` when the account never subscribed, and otherwise the Stripe
subscription status verbatim. `trialDaysLeft` is a non-negative integer only
while `trialing`, null otherwise. `locked` now means the account is being
deleted and nothing else; it stays authoritative for both Next navigation and
Django's write gate, and the frontend does not repeat the Stripe-status
precedence table.

`plan` is `"paid"` or `"free"`, derived from `status`: `active`, `trialing`
and `past_due` are paid, and every other status — `none`, `canceled`, `unpaid`,
`deleting`, anything unrecognized — is free. The self-hosted, demo and staff
exemptions are paid. `entitlements` is the plan's row of the catalog in
`apps/api/forkluck/domains/shared/billing.py`: `maxRecipes` (an integer, or null
for unlimited) plus the boolean flags `primo`, `posSync`, `connectors`,
`usdaSearch`, `catalogSearch` and `invoiceAi`. Free is the whole app minus
Primo, capped at 10 recipes; changing a limit means editing that one catalog.
`recipeCount` is the account's owned recipe count — every status and both
kinds, recipes shared to the user and recipes in kitchens it belongs to
excluded — on every plan, capped or not: it is also the signal that decides
whether an account with no recipes of its own lands in a kitchen it was
invited to.

`kitchens` is the kitchens this account is a _member_ of, never the one it
owns: `{id, ownerId, ownerName, role}` rows ordered by owner name and then id,
where `id` is the membership row (what a member sends to leave) and `role` is
`viewer` or `editor`. It is empty while the address is unverified, exactly as
the access a membership grants is dormant until then.

`guest/recipes/<token>/` and `guest/books/<token>/` are the two routes with no
session: they take the internal secret like every other, but the capability
token in the URL is the authorization, and they answer `{item}` with a lean
read-only payload carrying no ids, costs, or nutrition. Both carry the invited
`role`, which is the standing waiting for the address once it has an account;
the link itself only ever reads. A book answers
`{item: {title, ownerName, role, recipes}}`, where each entry of `recipes` is
the recipe payload the single-recipe route serves and the order is the order
the owner shared them in. `title` is the one the owner typed, or
`"N recipes from <owner>"` when they typed none. The recipes inside a book stay
live, so one deleted since the share simply drops out; a book whose recipes are
all gone answers 404, like a revoked link.

Browse endpoints over tenant-owned editable documents — `ingredients/`,
`recipes/` and `menu-items/` — default to `-updatedAt`, so the row saved most
recently leads. The catalog reads keep their alphabetical order.

`ingredients/` and `recipes/` are browse endpoints: `page`, `limit` (default
50, cap 100), `q`, and `order` (`name`, `-name`, `updatedAt`, `-updatedAt`;
recipe `name` is title, and recipes also accept `category`/`-category`, which
orders by category name case-insensitively with uncategorized rows last), plus
recipe `status`, a tenant-owned category UUID,
`attention`, `tags`, `allergens`, `ingredients`, `ownership`, and `kitchen`.
`kitchen` is a user id and lists one kitchen at a time: the caller's own, or
one they hold a membership in — any other id is 400 `Invalid kitchen`. Without
it the list is the caller's own recipes plus the ones shared with them one by
one, and a kitchen membership adds nothing to it, so a member's default list
never mixes two kitchens. `hasAnyRecipe` is evaluated after the kitchen
filter, so it answers for the kitchen on screen. Recipe detail, nutrition and
search index take no such parameter: a membership reaches those rows the same
way a share does.

Ingredient browse takes `status`, where absent lists the active pantry, `archived` lists
the archived rows, `all` lists both and anything else is 400, plus `category`,
a tenant-owned ingredient category UUID. The legacy
`kind` filter remains accepted during the staged column cleanup but is not a
user-facing distinction. Responses are `{items, meta: {pagination: ...}}`; recipes also
return `queryCount` and strict `facets` (`status`, `attention`, `category`,
`tags`, `ingredients`, `allergens`, and `ownership`) computed from the same accessible,
tenant-scoped queryset. ingredients
adds the unfiltered existence signal `hasAnyIngredient` so a zero-match search
is distinct from an empty pantry. Ingredient browse also returns `queryCount`
and strict `facets` (`attention`, `category`, `tags`, and `allergens`) computed
from the filtered tenant queryset. `category` counts are
`{id, name, count}` rows sorted by name. Invalid parameters return 400.

Each ingredient includes `measureName`, the stable identity that resolves
shared household measures. Its precedence is a direct catalog-ingredient
activation, then an adopted product's catalog ingredient, then the pantry
name, so either catalog link survives a pantry rename. Every ingredient also says
`categoryId`, `category` (the name, null when unfiled or filed under another
tenant's category) and `status`.

Ingredient detail also says `editVersion`, the counter the ingredient form
sends back as `expectedEditVersion`, and adds `usedInRecipes`: one
`{id, publicId, title, status, quantity, unit}` entry per recipe of the same
tenant with a line naming this ingredient, active recipes first and then by
title. `quantity` is the sum of that recipe's lines when they all ask in one
unit; when the units differ the first line's quantity and unit stand for the
recipe, and a line with no quantity reads as null.

`ingredient-measures/` returns reviewed active shared defaults plus the user's
overrides, scoped through their owned ingredient; shared records carry no
tenant data. `ingredient-tags/` returns the authenticated tenant's complete
ingredient-tag vocabulary as `{id, name, count}` rows, where `count` is the
number of the tenant's ingredients using that tag. `ingredient-categories/` and
`recipe-categories/` return the tenant's whole ingredient- and recipe-category
vocabulary as `{id, name, count}` rows sorted by name, `count` being the
tenant's ingredients or recipes filed under that category. Both list every
category the tenant owns, including the ones nothing uses, which the detail
page and the Settings editor need even when the browse is filtered.

`product-categories/` returns the tenant's product-category vocabulary as
`{id, label}` rows sorted case-insensitively. A product's category is a plain
string rather than a row, so the list is the distinct non-blank values the
tenant's products carry, and the id is the name.

`matches/` returns tenant-scoped
`{line, targetId, targetName, targetKind, source}` so measure resolution
follows the same selected identity as pricing. A saved match and its ingredient
or recipe target always belong to the same tenant. `ingredient-options/` is the
`{id, name, nonEdible}` index loaded when an import or matching dialog opens,
and it lists active ingredients only; `nonEdible` is what lets a picker group
supplies apart from food and lets the invoice review file a picked item under
a supply category;
`ingredient-duplicates/` returns at most twenty suggestions for the pantry
banner.

`pricing-entries/` is the unpaginated compatibility/new-recipe read: pantry
pricing fields plus the recipe fields needed to cost a recipe used as an
ingredient. No timestamps, price history, or supplier data. Archived
ingredients stay in it, each entry saying its `status`, because a line already
naming one still costs from it; only the picker skips them.

A recipe entry carries its `equivalency` (the same shape the recipe detail
sends, or null), because a line asking for a cup of a recipe whose yield is a
weight has nothing else to relate the two families. On a custom equivalency,
the yield and every filled amount describe the same one batch, so 2.75 cup,
700 g and 8 each are three readings of one batch. On a standard equivalency,
the weight and volume are a reusable density ratio, such as 8 oz-weight per
cup, and are scaled to Total Yield before the batch is priced or weighed.

`search-index/` returns at most nine `{label, href, type}` palette
records for an optional `q`, loaded only after the palette opens.

`recipe-health/` takes the recipe browse parameters and returns finalized
health rows, categories, facets, `hasAnyRecipe`, and `currencyCode`. Rows carry
owner/role capabilities; cost and labor values are populated only for the
owner; a row's `labor` is `{centsPerBatch, centsPerPiece}` or null, and
commercial `ingredientCents`, `foodCost`, `overTarget`, `suffix`, and the
per-portion labor display use the saved costing portion. An absent portion or
one that cannot be related to Total Yield returns null commercial values and a
specific issue; it never falls back to a yield unit or batch. Nested-recipe
pricing continues to use the child's Total Yield and UOM equivalency.
`dashboard-overview/` is a constant-size payload of recipe metrics and the
five largest ingredient price moves. Both cost tenant-side with the same
resolution rules as the recipe editor.

`menu-items/` is the Products table's browse endpoint: `page`, `limit`
(default 50, cap 100), `q` (product name, variant SKU, variant external name),
`order` (`name`, `-name`, `sku`, `-sku`, `category`, `-category`, `price`,
`-price`, `updatedAt`, `-updatedAt`) and `status` (`active` or `inactive`).
It returns the `menu-overview` `items` rows with `components[]`, the standard
`{items, meta: {pagination: ...}}` envelope, and `hasAnyProduct` so a
zero-match search is distinct from an empty catalog. Products is a catalog:
a row carries no sales figures, so its `sales` block is the shared zero block
and there is no sales window — sales analytics live on the Menu page and the
product's Sales tab.
`sku` orders by a product's lowest non-blank variant SKU, case-insensitively;
products without one sort last in both directions. `category` orders by name
case-insensitively, with uncategorized products last in both directions.
`price` orders by `sellPriceCents`.

`menu-product-rows/` is the same catalog read with the figures a menu
worksheet needs: `q` (same three fields, at most 200 characters) and an
optional `start`/`end` sales window, where `end` requires `start`, defaults to
it, and may span at most one year — a bad window is a 400, as on
`product/<product_ref>/`. It returns `{items}` only: active products, each a
`menu-items/` row whose `sales` block is the attributed rollup over that
window — all-time when no window is given — with bundles expanded, so a box's
units and money reach the products inside it. Rows come back sorted by
`sales.totalQuantity` descending then name, capped at 100, and there is no
pagination; search reaches what the cap leaves out. The menu worksheet's
"Import from products" and "Connect product" dialogs are its only callers:
they show "N units · $X" for the menu's own period and seed a new row's
`qty_sold` from it.

A product's `baseUnit` says what one sold unit of it is: a slug from the
shared unit vocabulary, restricted to what a menu item can be sold by — the
everyday weights and volumes, plus each, dozen, slice, portion and serving.
`PRODUCT_UNIT_SLUGS` in `apps/api/forkluck/units.py` is the list, mirrored in
`apps/web/lib/unit-registry.ts`. Blank is the default and reads as each. It names the
unit a variant multiplier and a consumption figure are counted in; nothing
converts by it, and it does not enter costing, so a product sold by weight
composes and costs exactly as one sold by the piece.

A product's `skus[]` is the ordered list of POS SKUs that sell it, rows of
`{id, sku, quantityMultiplier, position}`. Each row is one SKU sold as a count
of `quantityMultiplier` units, and the list may be empty. `sku` carries the
first row at 1, or the first row, for the list and exports.

`product/<product_ref>/` returns `{item}` for the tenant-scoped product
identified by its stable `prd_...` reference, or a not-found response when the
reference is not owned by the caller. Optional `start` and `end` query values
are `YYYY-MM-DD`; `end` requires `start`, defaults to it when omitted, and
scopes only the returned sales/consumption period. Product detail carries the
same row fields plus nullable `costCents`, `marginCents`, and `marginPercent`,
`costIssues[]`, the `currencyCode` used for its money, and
`incompleteManualRevenue`. `costIssues[]` is `{code, path[], detail}` and says
why `costCents` is null — an unpriced ingredient, an unresolved conversion, a
recipe cycle — with `path` naming the trail that reached it, outermost first.
It is empty whenever a cost resolved, and a null cost always carries at least
one entry. Its
`sales.dailySales[]` rows are one product,
channel, business date, and currency bucket; ledger channels are `square`,
`shopify`, or `manual`, and a count-only manual row has `netSalesCents: null`.

A `sales` block is `{lineCount, quantity, totalQuantity, grossCents,
discountCents, netSalesCents, attributedNetSalesCents, taxCents, refundCents,
sharedToMembers, asSoldNetSalesCents, splitBasis}`. It is the _including
bundles_ view: it adds what reached the product inside a bundle. A bundle's own
row carries its units, `sharedToMembers: true`, zero in every money field
because the money moved to the products inside it, `asSoldNetSalesCents` for
what the bundle itself sold, and `splitBasis` — `"price"`, `"cost"` or
`"count"` — for which rung of the value ladder divided it. Everywhere else
`sharedToMembers` is false, `splitBasis` is null, and `asSoldNetSalesCents` is
the part of `netSalesCents` the product sold under its own name. `lineCount`
counts each tracked line once, on the product the line actually sold, so the
counts sum to the ledger's. Product detail additionally carries `salesAsSold`
in the same shape plus `dailySales` and `manualSales`: the _as-sold_ view,
which is immutable and reconciles to the channel, so the page can show both
without a second request.
Each `components[]` row of any product is an ordered editable
composition entry: `{id, recipeId, recipePublicId, recipeName, ingredientId,
ingredientPublicId, ingredientName, productId, productPublicId, productName,
quantity, unit, position, nonEdible}`.
Exactly one of `recipeId`, `ingredientId` and `productId` is set; the matching
public id and name are set with it, and the other targets' fields are null.
Recipe rows use an empty `unit`; ingredient rows use a vocabulary unit slug, and
`nonEdible` is false for recipes. A product row is a bundle member: its `unit`
is empty and its `quantity` is how many of that product's own base units one of
this product contains. A product's cost is the sum of its members' costs plus
whatever it adds itself, so `costIssues[]` may name a member's reason under the
member's name; a composition that reaches itself is refused on save and reports
`product-cycle`. Cost and margin are backend-derived from
this current composition; no alternate variant-by-channel or generic
cost/warning envelope is part of this payload. Dates are business dates, not
timestamps, and are interpreted in the workspace timezone.

`menu-overview/` takes comma-separated `sections` (`modifiers`, `review`,
`ignored`, `items`, `recipes`, `stats`; omitted returns everything) and an
optional `q` for the Catalog section. Unrequested blocks come back empty but
present, so the shape never changes; `stats` implies `items`, and `items`
implies `recipes`. Search matches name, provider variant title, SKU, and
provider category across the complete tenant-scoped union before display
capping; the 200-row cap is per category, `reviewCount` is the complete
union size, and catalog-only rows carry zeroed sales fields.

`sales-identity-lines/` takes `channel`, `account` (blank for CSV
identities), and `key` — one external identity's scope — and returns
`{items, lineCount}`: the 50 most recent financial lines for that identity,
newest first, with the full count. Variant state is not consulted, so a
just-tracked identity still answers.

`pos-sync-runs/` lists the user's latest durable jobs; `pos-sync-runs/<id>/`
returns one as `{syncRun}` with status `queued`/`running`/`succeeded`/`failed`,
or terminal `cancelled`, progress, attempts, heartbeat, result, safe error
text, the copied `connectionGeneration`, and a provider-neutral watermark
cursor. Connection rows expose their positive `generation`; clients match a
run only when provider, provider account, and generation all agree. Connection
status is `active`, `needs_reconnect`, or the transient durable
`disconnecting`; reconnect is refused while provider revocation is in flight.

`connector-sync-runs/` is the supplier-connector counterpart: `{items}`, the 20
most recent runs newest first, each naming its `providerKey` so a run reads
without the connection list beside it;
`connector-sync-runs/<id>/` returns one as `{run}`.

`sales-imports/` returns `{items}` — provider `sales_import_json` rows, newest
first, capped at 20. Manual monthly imports are intentionally absent from
history/latest; the generic `undo-sales-import` action refuses a manual
monthly batch. A dedicated manual correction flow must identify its source
rows explicitly and must not pretend they came from a provider.

Sales financial fields have fixed signs: `grossCents`, `discountCents`,
`netSalesCents`, and `taxCents` are signed provider facts, so a return carries
negative quantity and negative money. `refundCents` is instead the
non-negative magnitude of reversed net sales excluding tax: `-netSalesCents`
only when both quantity and net sales are negative, otherwise zero. Import
`refundCents` is the sum of its line magnitudes; it is descriptive and is
never added to or subtracted from net revenue.

`topProducts[]` rows are `{productId, productName, channel, quantity,
netSalesCents, sharedToMembers}` in the _including bundles_ view: a bundle row
carries its units and `sharedToMembers: true` with zero money, because that
money is already counted on the products inside it. The `summary` and
`netSalesTrend` figures stay as-sold, straight from the ledger.

`sales-overview/`'s single-figure sections (`summary`, `scope`,
`netSalesTrend`, `topProducts`) are one currency, named `currencyCode` — the
workspace currency — counting only rows recorded in it; excluded rows are
reported as counts. Per-identity rows carry their own `currencyCode` and must
be formatted with it. (Sales and invoices are document money; see
ARCHITECTURE.md, Money and currency.) An optional `timezone` query evaluates
the trend, `topProducts`, and the date window in that IANA timezone; omitted,
the latest tracked sale's timezone.

Rows that name an external identity expose `providerAccountId`; mutations
send the complete `channel + providerAccountId + matchKey` scope — `matchKey`
alone is never an authorization or identity boundary.

`pricing-entries/` carries the sale unit (`purchaseSize`, `purchaseUnit`), the
ingredient's `conversion` and its `preparations` alongside the price, because
costing is per unit of sale: a case of 36 eggs prices a "2 each" line with no
weight involved. Ingredients and their price rows carry no weight of their own;
a weight is one unit among the others, on `purchaseUnit`.

A preparation says `source` and `confidence`, the same pair a household measure
says. `catalog` means the yield came from the reviewed shared table because the
chef created the preparation without stating one; `save-preparation` writes
`user` at high confidence on every edit, so a yield anyone touched is theirs.
An ingredient's `conversion` says the same pair, and it means the same thing:
`catalog` is the shared estimate a workspace was given, and
`save-ingredient-conversion` writes `user` at high confidence.

Preparation notes are compared as exact normalized comma- or
semicolon-delimited clauses. A standard preparation stores no measures and
uses the ingredient conversion plus the qualifier-free standard ladder. A
custom preparation uses only its own complete positive measure pairs; an empty
or incomplete custom conversion is unresolved and never falls through to
ingredient measures, density, or an inferred gram value. A recipe weight that
was explicitly written remains authoritative.

Every unit on the wire is a slug from `data/parser-vocabulary.json` — the one
catalog `apps/web/lib/unit-registry.ts` and `forkluck.units` both read, so a unit is
spelled the same on either side. A household measure's unit is one whose family
is `volume` or `count`: you measure with a cup or a bunch, never with a gram.

A recipe's `yieldUnit` is one of a shorter list: `pcs`, `slice`, the four
weights and the six volumes. `save-recipe` rejects anything else once a
`yieldAmount` is set. `pcs` and `slice` both count what one batch cuts into, so
everything that reads a yield treats a slice as one piece: an 8 slice tart is
8 pieces, a slice line asking for a piece-yield batch is one of that count, and
a component built from either publishes its piece basis as `componentYieldUnit`
`"pcs"`. `countedAsEach` in `apps/web/lib/unit-registry.ts` and `counted_as_each` in
`forkluck.units` are the two sides of that one rule.

An ingredient and its price history say `purchaseCostCents`, `purchaseSize` and
`purchaseUnit` — what the kitchen buys. A manually created, not-yet-priced
ingredient may leave `purchaseSize` and `purchaseUnit` null or blank; supplier
imports require a complete pack, whose unit is one of the purchasing slugs
`PACK_UNIT_SLUGS` names in `apps/web/lib/unit-registry.ts` and `forkluck.units` — the
weights, the volumes and the counts a pack is bought by. A supplier item's
`packGrams` is a cache of that pack's weight and is null whenever the unit
carries no weight of its own, so a case of gallons or of pieces is priced by
what it was bought by and the per-piece weight stays the ingredient's own
conversion. Master and catalog prices remain weight-only.

The ingredient detail payload and `pricing-entries/` also say `yieldPercent`:
the usable share left after trim, bounded (0, 100], 100 for no loss. Costing
divides the sale units by it, so a $10 case of tomatoes at 90 costs $11.11 a
case of usable tomato. It is the ingredient's own factor and applies only to a
line naming no preparation; a line naming one is costed by that preparation's
`yieldPercent` instead, never by both. `apps/web/lib/pricing.ts` and
`forkluck.domains.recipes.health` are the two sides of that one rule.
`save-ingredient` accepts it as an optional number in the same range; omitted,
the saved yield is left alone, so a payload that only reprices cannot reset it.
Supplier items, catalog products and
starter prices keep `pack*`: those describe a pack somebody else assembled, and
`search-catalog-prices` is translated into the purchase vocabulary as it crosses
into the pantry.

`invoice-line-options/` searches invoice lines by item, vendor or ID for the
ingredient screen's invoice-price picker, newest first and capped at 20;
`linkedIngredients` lists every ingredient already using that exact invoice
line as a price reference, and `quantity` is how many packs the line bought, so
a caller can divide `lineAmountCents` back down to one pack. Existing links are
informational, not exclusive: the same whole-egg purchase may be referenced by
both Egg and Egg yolk.

`link-invoice-line` adds the line to an ingredient's `invoicePrices` with the
reviewed `purchaseSize` and `purchaseUnit`. The purchase price stays document
money on `InvoiceLine`; the relation does not change `InvoiceLine.ingredient`,
move a `SupplierItem`, or alter the ingredient's active cost or yield.
`disconnect-invoice-line` takes `ingredientId` and `invoicePriceId` and removes
only that relation. `use-invoice-price` takes the same pair and is the explicit
ingredient-side choice that copies the invoice line's per-pack price and the
relation's measure into active costing. All three lock the ingredient, bump its
`edit_version`, and answer `{ok, editVersion}`. A foreign-currency invoice may
remain visible as history, but `use-invoice-price` refuses it because document
money is never silently restamped as workspace money.

Ingredient detail returns `invoicePrices[]` as
`{id, lineId, supplier, title, externalId, rawSize, purchaseCostCents,
purchaseSize, purchaseUnit, currencyCode, invoiceNumber, invoiceDate,
isUsedForCosting, createdAt, updatedAt}`. `purchaseCostCents` is derived from
the invoice line on read (unit price, else line total divided by quantity), so
correcting an invoice cannot leave a stale duplicate price on the ingredient.
The measure is nullable only for historical matches created before Forkluck
could identify the pack; those rows stay visible but cannot be chosen for
costing until a complete measure is connected.

`menus/` returns `{menus, hasAnyMenu}`: one row per menu-engineering
worksheet, newest first, with `itemCount` annotated so the list stays a single
query. `menu/<menu_ref>/` takes either the `mnu_` public id or the row's UUID,
is always scoped to the authenticated user, and answers 404
`{"error": "Menu not found"}` otherwise; the Next.js layer maps that to `null`.
It returns `{menu, items, recipes, ingredients, products, currencyCode}` — the
picker's sources travel with the worksheet so opening one is a single read.

`menu/<menu_ref>/forecast/` accepts the same owner-scoped public-id or UUID
forms and returns a non-persisted projection beginning on the workspace-local
current date. `?days=` is `7` (the default) or `30` and `?plan=` is `typical`
(the default) or `busy`; anything else is 400
(`{"error": "Forecast plan must be typical or busy"}`). Its `basis` names the
56 complete historical days, `historyWeeks: 8`, `horizonDays`, the horizon's
own first and last date, the active `plan`, `seasonalAdjustment`, workspace
timezone, and `compositionBasis: "current"`. Each horizon day is projected from
its own eight matching weekdays, each week back counted at 80% of the one after
it and samples from before the product existed dropped rather than averaged in
as zeroes; "existed" is the earliest of the product's creation date, its first
observed sale, and its first sale in last year's window, so a workspace that
backfills history onto products created this morning is not read as a shelf of
products that launched last week. When a product sold in both of last year's windows, its
projection is scaled by a damped ratio — half the deviation, clamped to
0.5–2 — of last year's horizon-aligned days to last year's history-aligned
eight weeks, both shifted back 364 days so the weekdays line up;
`basis.seasonalAdjustment` says whether any product was scaled, and the
backtest applies the same rule per replayed week. The factor is 1 for a product
that did not exist through the whole of last year's history window: its launch
ramp is not a season. Only the sums are reported:
`products[]` publishes both `typicalQuantity` and the `busyQuantity` that
history stayed under about nine weeks in ten (variance pooled across the
horizon, never per-day peaks summed),
`totalQuantity` echoes the requested plan, and `weeksObserved` says how many of
the eight history weeks the product sold in at all. No per-day product row is
published — a single day's average is a weekday profile, not a dated
prediction. `revenue` prices menu members only — a bundle member or modifier
reached through closure is demand whose money already sits in the box or the
base — using the first linked menu row's price by position when it is above
zero, else the product's own; zero is unpriced and counted rather than treated
as free. `revenue.busyCents`, the horizon `series[].busyCents`, and
`backtest[].busyCents` pool variance across the priced products (at price
squared) and days rather than summing each product's own busy money, so the
menu-level busy is the same nine-weeks-in-ten level as a product's
`busyQuantity`; the horizon's `typicalCents` rows sum to `revenue.typicalCents`. `series` is 28 history days followed by the horizon: history carries
`actualCents`, the horizon carries `typicalCents`/`busyCents`, and the last
history day carries all three equal so the projection begins where history
ends. Series history and backtest actuals are units times the _current_ price,
not net sales, so both sides share one price basis and the accuracy figure
measures quantity error only. `backtest` replays the same projection at four
past weeks it could not have seen, out of the same single ledger read, and
scores it with a volume-weighted absolute percent error over the weeks that
sold anything (`errorPercent` is null when none did). Menu membership comes
only from saved `MenuItem.product` links; recipe rows have no sales and are
left out, rows with no link at all appear in `unresolved`, the products inside
an in-menu bundle join the scope and are marked `menuMember: false`, and mapped
modifier products enter only when the same sale has an in-menu base
contribution. `recipeRequirements` and `materialRequirements` expand the
requested plan's Product demand through current composition, with usage and
purchase-unit quantities kept separate. Missing yields, conversions, purchase
units, and cyclic paths are structured `unresolved` rows rather than zeroes.
The response does not subtract inventory, round packs, or write a forecast, and
its money is projected demand at today's prices, never recorded sales.
Forecasts for different Menus are independent and therefore must not be summed
without accounting for overlap.

A menu row is a link to one recipe or one product, or a plain named row
awaiting one; never a composition of its own. Each `items[]` row is
`{id, name, position, sellPriceCents, qtySold, recipeId, recipePublicId,
recipeName, productId, productPublicId, productName, category, foodCostCents,
sourceSellPriceCents, sourceQtySold, original}` with at most one of `recipeId`
and `productId` set. `name` and `category` are the link's, read live; an
unlinked row keeps the name it was saved with, and its `category`,
`foodCostCents`, `sourceSellPriceCents` and `sourceQtySold` are all null. `foodCostCents` is never
stored: a product row costs what its product page shows, a recipe row costs
the recipe's cost per unit of sale as its Cost tab computes it, and both are
null when the source cannot be costed. `sourceSellPriceCents` is the product's
sell price or the recipe's costing price, null when there is none, so the
worksheet can flag a `sellPriceCents` that differs. `sourceQtySold` is the
product's units sold over the menu's period (all time when the menu has no
period, the window `menu-product-rows/` prices with), and null for a recipe
row, whose `qtySold` is typed by hand. `original` is the snapshot the row was
frozen at, `{sellPriceCents, qtySold, foodCostCents}`, with a null
`foodCostCents` when the row could not be costed then, and is what the Track
variance switch compares against; only a rebaselining `save-menu` moves it.
`periodStart` and `periodEnd` are date-only strings, both set or both null.

`menu-sources/` returns `{recipes, ingredients, products, currencyCode}`:
every recipe the workspace owns with `ingredientCents` (cost per unit of sale,
null when the recipe cannot be costed), `suffix`, the label for that unit,
`batchMeasures`, one batch in every unit its yield or equivalency states (the
yield first, empty without one), and `servingAmount`/`servingUnit`, the saved
portion, so a product's composition editor can offer the units a recipe
component may be measured in and say what a batch makes,
plus every ingredient as `{id, name, purchaseUnit}`, by name, plus every active
product as `{id, publicId, name, componentProductIds}`, by name.
`componentProductIds` are the products that product already contains, so a
picker can keep a composition out of its own loop without a second call. It is the picker for a
worksheet that has not been saved yet, so it is deliberately uncapped rather
than a page of `recipe-health/`.

`menu-component-price/` takes `ingredientId` and `unit` in the query string and
returns `{unitCostCents}` for one of that unit — how the worksheet re-prices a
component the moment its unit changes, without saving. A malformed id or a unit
outside the vocabulary is 400; an ingredient the caller does not own is 404
`{"error": "Ingredient not found"}`.

`invoice-suppliers/` returns the workspace's suppliers by name as
`{id, key, name, email, phone, accountNumber, notes, defaultCategoryId,
invoiceCount, itemCount, ignoreCount}`. `defaultCategoryId` is the expense
category this supplier's lines fall back to when no line of their own
remembers one, and is null until the workspace sets it; `invoice-line-status`
returns it as `lastCategoryId` for a line with no memory. The counts are taken off the supplier key the invoice, pantry
and skip-list rows still carry as a string, so they include rows a supplier
record was backfilled for. Invoice rows expose
`unresolvedLineCount` (drives review status) distinct from `matchedLineCount`
(ingredient-price matches only). They also expose `source`: `"connector"` for
a supplier-connector import, `"manual"` for one typed in by hand, `null` for a
document the user uploaded.
`invoices/<public_id>/` returns one invoice as the whole document:
`{item: {id, publicId, editVersion, supplier, supplierName, documentType,
invoiceNumber, invoiceDate, dueDate, totalCents, taxCents, subtotalCents,
notes, paymentMethod, currencyCode, source, fileName, driveWebViewLink,
driveFileId, driveFilePart, documentKey, lineCount, matchedLineCount,
unresolvedLineCount,
createdAt, lines}}`, each line the same shape
`invoices/<id>/lines/` returns. `editVersion` is the counter the editor sends
back as `expectedEditVersion`. `driveFileId` is the Drive file the invoice was
read from (null for an upload or a typed-in invoice) and `driveFilePart` is
`{part, pageStart, pageEnd, region}` when the watcher read that file as a
bundle and this invoice is one document of it, null for a whole file; the
invoice page shows the document beside its lines with them. `documentKey` is
the file the merchant uploaded, kept on our side at import time and fetched
from Next by that key, null for a Drive or typed-in invoice; the page shows it
the same way.
404 `{"error": "Invoice not found"}` when it is not the caller's. `taxCents`
is the tax already inside `totalCents`, 0 when the document prints none, and
`paymentMethod` is `""` (not recorded), one of the four built-ins `cash`,
`card`, `bank_transfer`, `on_account`, or the name of one of the workspace's
own methods. It is stored as free text up to 64 characters and is validated by
`save-invoice` against that vocabulary, not by a database constraint.

`payment-methods/` returns the workspace's own payment methods as
`{items: [{id, name}]}`, name-ordered. The four built-ins are wire values every
client already knows, so they are not listed.

`invoices-overview/` keeps every total separated by `currencyCode`.
`summary`, `byCategory`, `bySupplier` and `months` are always the month in
`month`; the `invoices` rows are not. `q` searches every month — invoice
number, supplier name, any line's description or code, or the whole query read
as an amount (`88.73` finds a total of 8873, either sign) — and `tab=attention`
lists every month's invoices that still need something: no lines, an
unresolved line, no supplier, or a printed total more than 50¢ away from its
lines plus tax. Without either it is the month. Each mode returns at most 200
rows; `needsReviewCount` is the uncapped count of attention rows in the whole
workspace, so it says what the cap and the month hid. A malformed `month` is
400; an unknown `tab` is simply not the attention tab.

Each invoice row carries `taxCents`, `issueKind` — `"no-lines"`,
`"unmatched-lines"`, `"total-mismatch"`, `"unknown-supplier"` in that
precedence, or null — and `totalDeltaCents`, the printed total less the lines
less tax. `totalDeltaCents` is null and `total-mismatch` unreachable on a row
read without those aggregates.
`driveNewCount` and `driveReadyCount` ride along with it: the workspace's Drive
files in status `new`, and the documents read out of files in status `ready`
(a bundle counts once per receipt), which is the badge on the Drive tab —
waiting to be read, and read and waiting to be confirmed.

### Activity log

`activity/` returns the workspace log newest first:
`{items: [{id, actorName, resourceType, resourceId, event, name, context,
createdAt}], nextBefore}`. `before` is an exclusive ISO datetime cursor,
`events` and `types` are comma-separated filters, `resourceId` narrows to one
resource's own history (a malformed uuid is 400, and the filter is applied
inside the caller's own log, never instead of it), and `limit` defaults to 100
and caps at 200. `nextBefore` is the last item's `createdAt` when the page came
back full, null otherwise. An unknown `events` or `types` value is 400.

`resourceType` is one of `recipe`, `ingredient`, `menu`, `invoice`, `category`,
`import`, `settings`, `connection`, `workspace`. `event` is one of `added`,
`edited`, `deleted`, `archived`, `restored`, `imported`, `connected`,
`disconnected`. `context` is a free-form object: recipes, ingredients and menus
carry `publicId`, a category carries `kind`, an import carries its counts, a
settings edit carries `changed`. `actorName` is the actor's name copied in at
write time, and is blank for a background connector sync.

Lines are written by save-recipe (added or edited), delete-recipe,
update-recipe-status (archived or restored), save-ingredient, archive-ingredient,
delete-ingredient, merge-ingredients (as an edit of the surviving row),
save-menu, delete-menu, the recipe and ingredient category renames and deletes,
the ingredient, labor and POS sales imports, the recipe paste,
import-invoices (one `added` line per invoice, carrying its `resourceId` and
`context` of `publicId`, `fileName` and `source`, rather than one line for the
batch), review-invoice-line (an `edited` line carrying
`context.reviewedLine`) and delete-invoice, update-business-settings, the Square,
Shopify and supplier-connector connects and disconnects, and delete-kitchen-data. Nothing
else writes to the log, and no action deletes from it.

A recipe autosaves every few seconds with the same payload, so an `edited` line
is written only when a digest of the save body differs from the digest the last
recorded edit of that recipe carried; the digest is kept in `context.hash`.

## Actions

Every mutation goes through the single `actions/<slug>/` POST route, which
dispatches on the `ACTIONS` registry in `http/dispatch.py`, composed from
one per-domain registry each:

**Primo conversations (6)** `primo-attachment`, `primo-feedback`, `primo-save-turn`,
`primo-rename-conversation`, `primo-archive-conversation`, and
`primo-delete-conversation`. Save-turn creates or owner-scopes the supplied
conversation UUID, upserts messages by conversation plus AI SDK message id,
sets a generated title only while the title is blank, and advances
`lastMessageAt`. Rename trims a 1–200 character title. Archive/unarchive changes
the archive fields without changing `updatedAt` or `lastMessageAt`, preserving
the conversation's list position. Delete cascades through its messages.

**Recipes / normalized content and bench costing (29)**
`save-recipe`, `delete-recipe`, `update-recipe-status`,
`update-recipe-costing`
(with `{recipeId, servingAmount|null, servingUnit, menuPriceCents|null}`, owner
only; the portion amount and unit are both supplied or both cleared, the amount
is positive, the unit is supported, and the price is null or a positive integer
no greater than 100,000,000 cents),
`set-recipe-nutrition-serving` (with
`{recipeId, amount?|null, unit?, packageAmount?|null, packageUnit?}`, owner only:
the serving and retail package a label preview describes, each both or neither,
in a weight, volume or count unit; each pair changes only when one of its keys
is present), `set-recipe-item-yield-after-cooking` (with
`{recipeId, itemId, percent}`, owner or shared editor: the share of one
ingredient or sub-recipe line that stays in the dish, 0 to 100; the line is
found through its recipe, so another recipe's item id answers "Recipe line
not found"; `save-recipe` restates every line's yield, so it locks the recipe,
bumps `edit_version` and answers `{ok, editVersion}`),
`set-recipe-item-excluded-from-cost` (with `{recipeId, itemId, excluded}`, owner
only: whether one ingredient or sub-recipe line is left out of the money, set
from the Cost tab; a heading or note answers "Recipe line not found", as does
another recipe's item id; `save-recipe` restates the flag on every line, so it
locks the recipe, bumps `edit_version` and answers `{ok, editVersion}`),
`save-recipe-external-ref`,
`delete-recipe-external-ref`, `rename-recipe-category`,
`delete-recipe-category`, `open-cost-for-recipe`, `create-step`, `update-step`,
`delete-step`, `reorder-steps`, `add-timing`, `delete-timing`,
`commit-recipe-paste`, `undo-recipe-paste`,
`share-recipe`, `share-recipes`, `update-recipe-share`, `remove-recipe-share`,
`remove-recipe-guest-link`, `remove-recipe-book`,
`save-recipe-comment`, `delete-recipe-comment`.

`share-recipe` (with `{recipeId, email, role}`, owner only) answers one of
two shapes. A verified account gets a share row and
`{id, recipeId, recipientId, recipientName, role}`, and is mailed a
notification carrying a sign-in link to the recipe; that mail is best effort
and its failure does not fail the share. An address with no verified account
gets a mailed capability link instead and `{guest: {id, email, role}}`, for
either role: the link itself only reads, and the invited role is what the
address receives once it verifies. The owner's own address answers "You already
own this recipe". Re-sharing the same address rotates its link, so the
previous URL stops working, and restates the role.
`share-recipes` (with `{recipeIds, email, role, title?}`, owner only) shares a
selection with one address in one send. `recipeIds` is 1 to 50 ids,
deduplicated in send order, and every one must be owned: an id the caller does
not own refuses the whole request with "Recipe not found" before anything is
written, rather than sharing the owned part of it. A single id is delegated to
`share-recipe`, so the (recipe, email) rotation and the Share dialog's own
listing are unchanged. A verified account gets one share row per recipe, one
notification mail carrying a sign-in link to the recipe list, and
`{shared: N, guest: null}`; the caller's own address answers "You already own
these recipes". An address with no account gets a _book_ instead — one mailed
capability link over the whole selection — and
`{shared: 0, guest: {id, email, role, title}}`, where `title` is empty in the
delegated single-recipe case and `id` is that recipe's link. Books share the
guest-link daily limit, so twenty invites a day is twenty of either.

A book is a snapshot of the selection, not a living collection: the recipes
inside stay live, adding one later means sharing again, and re-sharing the
same address writes a second book rather than rotating the first one's link.
`remove-recipe-book` (with `{bookId}`, owner only) revokes one by deleting the
row. The recipe detail read lists the owner's books as `bookLinks`
(`{id, email, role, title, recipeCount, createdAt}`) beside `guestLinks`, on
every recipe inside the book, so any of them can revoke it; a collaborator
receives both keys as empty lists.

`remove-recipe-guest-link` (with `{recipeId, linkId}`) revokes by deleting
the row. Guest links do not expire. An existing share row is effective only
while its recipient is verified; an unverified recipient cannot read or
mutate the recipe, and the stored share becomes effective again after
verification. The same is true of a kitchen membership, which reaches every
recipe the kitchen owns rather than one; where both grant, the stronger role
wins, so a kitchen editor stays an editor of a recipe also shared as a viewer.

A write into another account's recipe — a collaborator's save, a comment, a
create in a kitchen — is refused with "This kitchen is closed for edits."
while that account's billing is locked. Dispatch already gates every action on
the caller's own billing; this is the same gate applied to the tenant being
written to. Reads stay open.

Normalized recipe detail reads expose ordered items, preparation steps,
batch sizes, equivalency, tags, comments, media metadata, and owner/editor/
viewer permission flags, and `editVersion`, the counter an editor sends back as
`expectedEditVersion`. Cost fields are populated only for the owner;
collaborators receive the same keys with null cost values. Recipe content saves
replace only collections present in the aggregate payload; omitted collections
are preserved. Each item may carry an `id` UUID: an existing id must belong to
this recipe, an unused id creates a new line, and duplicates are refused.
The editor sends these ids from the first save so identities survive subsequent
saves and reordering. Omitting an id creates a fresh identity for legacy
clients and recipe copies. Shared editors preserve each identified line's
owner-set `excludedFromCost`; new lines default to included. A supplied flag
must be a boolean and shared editors may only echo its stored value. A legacy
shared save without item ids must reload if the recipe has any excluded lines.
Owners can explicitly set or clear the flag; omission preserves an identified
line's setting. Renaming a recipe also updates linked parent lines that still
carry its old canonical title and bumps each affected parent's `editVersion`;
deliberately different line text is preserved as an attention state.
`save-recipe` answers `{id, publicId, code, editVersion, ownerId}`, and
adds `items` in the detail read's own line shape when the payload carried
`items`, so an editor that just linked a sub-recipe adopts its nested payload
without a reload. An owner payload may carry `tags: string[]`, written in the
same transaction as the rest of the aggregate: a tag the workspace does not
have yet is created, and an omitted key preserves the existing memberships.
An update may carry `expectedEditVersion`; the row is locked and checked
against it inside the transaction, so a save written against an older read
answers 409 `stale_write` rather than overwriting. Editors may change title,
description, items, and steps only, and send `expectedEditVersion` with them;
an editor payload carrying `tags` is refused.

A create may carry `ownerId`, the owner of a kitchen the caller is an _editor_
member of; it is refused alongside `id`, because a kitchen is chosen only when
a recipe is created. Everything the create writes then belongs to that
kitchen: its category, its code, its recipe cap and the lock the count is read
under. A kitchen the caller is not an editor of answers "Kitchen not found or
read-only", a kitchen over its cap answers `recipe_limit_reached` with "This
kitchen has reached its recipe limit. Ask the owner to upgrade.", and one
whose billing is locked answers "This kitchen is closed for edits." The
activity line is written in the owner's log with the member as its actor. The
creator is an _editor_ of what they made, not its owner: no costs, no delete,
and the same title/description/items/steps allowlist on the next save.
Editable detail reads also include lightweight `ingredientOptions` and
`recipeOptions` (`{id, publicId, title}`, the public id being what a link to
that recipe is written with) belonging to the recipe owner, without prices.
A recipe is not a separate component type: selecting it in an ingredient row
stores an internal subrecipe reference and the UI badges that target as
`Recipe`.

`rename-recipe-category` takes `{currentName, name}` and renames the tenant's
category, merging into an existing one of that name.
`delete-recipe-category` takes `{name}` and deletes it; the recipes filed under
it become uncategorized, and a name the tenant does not have is a no-op.

A line with `excludedFromCost` true is left out of money only: it adds nothing
to `ingredientCostCents` and reports no costing issue, while weight and
nutrition still count it.

On an owner detail read, every saved item also carries `costCents`: that
line's contribution to one batch after preparation yield and nested-recipe
scaling. It is null when the line cannot be costed, and is always null on
collaborator reads and mutation responses. A sub-recipe value comes from its
saved recipe link, not from matching its displayed title.

Recipe detail reads for a signed-in viewer also carry `usedIn`: one
`{id, publicId, title, status, quantity, unit}` entry per independently
accessible recipe with a line linking this one as a sub-recipe, active recipes
first and then by title. Private parents are omitted even when the viewer can
open the child. `quantity` is the sum of that parent's lines when they all ask
in one unit; when the units differ the first line's quantity and unit stand for
the parent, and a line with no quantity reads as null.

A recipe records two times, each a pair the editor's Additional details writes:
`shelfLifeAmount` with `shelfLifeUnit` in `hours`, `days`, `weeks` or `months`,
and `prepTimeAmount` with `prepTimeUnit` in `minutes` or `hours`. `save-recipe`
takes both halves of a pair or neither, and rejects an amount that is not
positive.

Prep time is the recipe's labor time, unless `autoPrepTimeEnabled` is on, in
which case labor time is the sum of the timed active steps. A step's time is
the mean of its timings, because each timing records one whole batch;
`yieldCount` is not read. Passive steps never count. Labor
cost is that time over an hour times the workspace wage. A recipe with no
labor time reads the issue `No prep time` when the switch is off and
`No timed steps` when it is on, and an auto recipe with some steps untimed
reads `N steps untimed`.

An item with a subrecipe reference also carries `subrecipe`, the linked recipe
one level deep: `{id, publicId, title, yieldAmount, yieldUnit, items[]}`, where
each entry is `{kind, quantity, unit, displayName, preparationNote,
subrecipeId}`. A nested entry names its own subrecipe by id but carries no
lines of its own, so the payload never recurses. `subrecipeId` and
`subrecipeName` stay on the item as before; `subrecipe` is null on every other
kind of row.

`save-recipe-line-match` takes `{line, targetId, targetKind}` and stores the
tenant-scoped identity selected for a recipe line. `targetKind` is
`ingredient` or `recipe`; canonical pantry/recipe names still win over a
saved match during resolution. Saved matches replace the previous line-identity storage
and never appear in browse, detail, picker, or search payloads.

`commit-recipe-paste` takes `{recipeId, body, method, ingredients[]}`, where
each entry is `{name, ingredientId, preparations[], measures[]}` — a null
`ingredientId` proposes creating the ingredient, and each measure is
`{amount, unit, grams, qualifier}` read off a line that stated the same
quantity twice ("1 cup (250 g)"). One transaction writes the ingredients, their
preparations, the household measures an ingredient does not already have, the
matches that keep the pasted lines resolving, and the recipe text, and returns
`{batchId, lines, ingredients, preparations, matches, measures, ingredientIds}`, where `ingredientIds` maps each entry's normalized name to the pantry ingredient id it was written against.
`undo-recipe-paste` takes `{id}` and reverses all five, refusing anything but
the latest non-undone paste. That stack is separate from the supplier-import
stack: a paste and a purchase report do not order against each other.

**Ingredients / prices / nutrition (29)**
`save-ingredient`, `save-preparation`, `delete-preparations`,
`save-ingredient-conversion`, `reset-ingredient-conversion`,
`archive-ingredient`,
`rename-ingredient-category`, `delete-ingredient-category`, `delete-ingredient`,
`merge-ingredients`,
`replace-ingredient-allergens`,
`search-nutrition-foods` (with `{query, scope?}`; `scope` is `common`, the
default, for analyzed USDA foods, or `branded` for transcribed package labels;
each match carries `{fdcId, description, dataType, brand}`),
`set-ingredient-nutrition`, `clear-ingredient-nutrition` (which leaves a
waiting custom request alone),
`update-ingredient-nutrition-settings` (with `{ingredientId, nonEdible?,
sugarsAreAdded?, labelName?}`; a key the payload omits is left alone),
`request-custom-nutrition` (with `{ingredientId, servingGrams, values, note?}`
where `values` holds the package label per serving: `calories, fat,
saturatedFat, sodiumMg, totalCarbohydrate, sugars, protein` required and
`transFat, cholesterolMg, fiber, addedSugars, vitaminDMcg, calciumMg, ironMg,
potassiumMg` optional or null; one pending request per ingredient; five a
minute; returns `{id, status}`; the row is the record and support applies it
from the staff console, where applying refuses to overwrite a record the user
linked after asking unless forced; merging ingredients re-points a pending
request to the target or supersedes it when the target has its own),
`import-ingredients`, `supplier-import-status`, `undo-ingredient-import`,
`set-preferred-supplier-item`, `search-master-prices`,
`match-master-prices`, `adopt-master-price`, `dismiss-master-price`,
`search-catalog-prices`, `match-catalog-prices`, `adopt-catalog-price`,
`search-catalog-ingredients` (with `{query}`, at least 2 characters) returns
`{items: [{id, name, preparations: [name], aliases: [text]}]}`: up to 8 active
catalog identities every query word matches by name or alias, excluding
identities the pantry already holds. `aliases` is every active synonym of the
card, sorted and deduplicated, on every row and not only the ones a synonym
found: it is how a pasted "confectioners sugar" links itself to Powdered sugar
instead of waiting for a pick. It is open data and not rate limited.
`activate-catalog-ingredient` (with `{catalogIngredientId}`) materializes a
tenant-owned pantry ingredient, its active canonical measures and every active
preparation, and returns `{id, name, created, seededMeasures,
seededPreparations, preparations: [name]}`. Catalog reference rows are never returned by ingredient
browse.

`reset-ingredient-conversion` restores the linked catalog conversion at
`source: "catalog"`; an ingredient linked to nothing falls back to the
reference density for its name, or to an estimated `237 g = 1 cup`.

`save-ingredient` takes two half-payloads on an update: the form's, carrying
`name` and no pack, and a pack write's, carrying `purchaseCostCents`,
`purchaseSize` and `purchaseUnit` and no name. An absent key leaves what is
saved alone; a create carries both. It accepts `category`, a category name: a name the tenant does
not have yet is created, a key that is absent leaves the saved category alone,
and an explicit null files the ingredient under nothing. It also accepts
`status`, `active` or `archived`, and `tags: string[]`, the whole tag list,
written in the same transaction as the rest of the ingredient: a tag the
workspace does not have yet is created, and an omitted key preserves the
existing memberships. It answers `{id, publicId, editVersion}`. An update may
carry `expectedEditVersion`; the row is locked and checked against it inside
the transaction, so a save written against an older read answers 409
`stale_write` rather than overwriting.

`save-preparation` takes `{ingredientId, id, name, yieldPercent,
usesStandardConversion, weight, volume, each}`. Yield is null or in
`(0, 1000]`; a blank yield on create adopts an available reviewed catalog
estimate. Each measure is null or `{amount, unit}` with a positive amount and
nonblank unit. Standard preparations require all three measures to be null;
custom preparations may be empty and then remain unresolved. An edit preserves
the submitted mode and blanks rather than inventing measurements.

`merge-ingredients` locks both owner-scoped rows in UUID order, moves every
current ingredient-owned relation, deletes the source, bumps the target, and
returns `{ok, targetId, editVersion, droppedMeasures}`. The target wins scalar
and same-key relational conflicts;
tags are unioned, target allergen overrides win, source-only overrides move,
affirmative nutrition flags are ORed, and blank target category, catalog links,
nutrition label, or nutrition snapshot are filled from the source. The whole
operation rolls back on any failure.

`undo-ingredient-import` and `undo-recipe-paste` retain a created ingredient
when any normalized recipe item still targets it. Import undo removes its own
price history and then rematerializes the latest surviving history; with none,
the retained ingredient becomes unpriced (`0`, null size/unit, `user`) rather
than exposing a price with no provenance. A concurrent recipe link fences the
delete, rolls the undo back, and asks the caller to retry.

`archive-ingredient` takes `{id, archived}` (a JSON boolean) and returns
`{item}`, the saved ingredient. Archiving is a list filter, not a deletion:
recipe lines that already name the ingredient keep costing from it, while the
pantry list and the pickers that start a new line skip it.
`rename-ingredient-category` takes `{currentName, name}` and renames the
tenant's category, merging into an existing one of that name.
`delete-ingredient-category` takes `{name}` and deletes it; the ingredients
filed under it become uncategorized, and a name the tenant does not have is a
no-op.

`delete-ingredient` checks recipe usage and deletes in one transaction. It
returns `{ok: true}` when deleted, or `{error, usedInRecipes[]}` without
deleting when a recipe resolves to the ingredient. That check reads recipe text
as well as normalized lines, which ingredient detail's `usedInRecipes` does
not; it is computed only for this destructive action.

| Ingredient deletion state                         | Result                                         |
| ------------------------------------------------- | ---------------------------------------------- |
| No owned recipe resolves to it                    | Delete and return `{ok: true}`                 |
| A normalized recipe item targets it               | Refuse and return that recipe                  |
| Recipe text resolves by exact name or saved match | Refuse and return that recipe                  |
| Only another tenant’s recipe names it             | Ignore that recipe and delete                  |
| Usage appears while deletion is running           | The transactional usage check refuses deletion |

The normalized `RecipeItem.ingredient` relation is also database-restricted,
so no delete path can orphan a saved direct target if its application-level
usage check races or is bypassed.

**Labor (7)**
`import-labor`, `labor-import-status`, `undo-labor-import`,
`set-employee-rate`, `set-time-entry-rate`, `set-employee-active`,
`set-employee-excluded-from-cost`.

`set-time-entry-rate` takes `{entryId, hourlyRateCents}`: a manual override
for exactly one shift that wins over the employee's rate history and survives
later rate edits; it dies with its time-entry row. `set-employee-active` takes
`{employeeId, isActive}` (a JSON boolean); archiving is a list filter, not a
deletion — hours keep reporting — and `import-labor` restores an archived
employee named in a new timesheet.

`set-employee-excluded-from-cost` takes `{employeeId, excludedFromCost}` (a
JSON boolean). An excluded employee still reports shifts and hours; only
their money stops counting, so `totalLaborCostCents` drops them and their
shifts are not counted as uncosted. `employee_json` carries the flag as
`excludedFromCost`.

`labor-overview/` also returns `overtime` beside `employees`:

```json
"overtime": {
  "weeklyThresholdMinutes": 2400,
  "byEmployee": {
    "<employee-uuid>": [{ "weekStart": "2026-08-09", "totalSeconds": 158400 }]
  }
}
```

Weeks run Sunday to Saturday in the period's timezone and are evaluated whole;
a shift belongs to the week its clock-in date starts. Only weeks strictly
above the workspace threshold appear, ascending by `weekStart`. The week total
is _payable_ time — `paidSeconds` less `unpaidBreakSeconds` — because an unpaid
meal break is not time worked and must not push a cook over the threshold.

`labor-overview/` also returns `policy`, echoing the two workspace settings
behind the money it reports, so the screen can name the rule without a second
fetch:

```json
"policy": {
  "payrollTaxPercent": 9.39,
  "unpaidBreakMinutes": 30,
  "unpaidBreakPerHours": 8
}
```

**Unpaid break.** When `unpaidBreakMinutes` is above zero, a shift loses that
many minutes for every whole `unpaidBreakPerHours` block it runs — whole
completed blocks only, so an 8-hour shift loses 30 minutes at the default rule
and a 7-hour shift loses nothing. The deduction never exceeds the shift. It is
stored per shift as `TimeEntry.unpaid_break_seconds`, reported as
`unpaidBreakSeconds` on shifts, employees and both summaries, and baked into
`laborCostCents`, which is charged on payable time. `paidSeconds` and
`totalSeconds` stay the clocked time the timesheet reported and never move.
`breakSeconds` is a separate, untouched field: it is what the source file said
and is never deducted, because a provider's hours already reflect it.

Changing the rule re-costs every stored shift in the workspace inside the
transaction that saves the setting, so a workspace never reads a break rule
its own shift costs do not obey. Zero minutes is off, and off is the default.

**Payroll tax.** `payrollTaxPercent` is the employer burden loaded on top of
a wage. Nothing stores it: `payrollTaxCents` on employees and on both
summaries is derived from the period total at read time, so changing the rate
needs no backfill and a stored total can never drift from the rate that
produced it. It is taken on the total rather than per shift, which rounds once
instead of accumulating a per-row error, and it carries the sign of the money
it is on. Zero is the default and reports a zero burden.

**Invoices / expenses (28)**
`invoice-ai-usage`,
`import-invoices`, `save-invoice`, `save-receipt-feedback`, `review-invoice-line`,
`invoice-line-status`, `link-invoice-line`,
`disconnect-invoice-line`, `use-invoice-price`, `delete-invoice`, `save-expense-category`,
`delete-expense-category`, `save-payment-method`, `delete-payment-method`,
`save-supplier`, `merge-suppliers`,
`delete-supplier`, `save-anthropic-key`, `delete-anthropic-key`,
`connect-drive-folder`, `disconnect-drive-folder`, `skip-drive-files`,
`unskip-drive-file`, `retry-drive-file`, `relink-supplier-item`,
`ignore-supplier-item`, `unignore-supplier-item`, `delete-supplier-item`.
Reading the stored AI credential is an invoices route (`ai-credential/`), not
an action, and so are reading the connected Drive folder (`drive-folder/`),
the Drive registry (`drive-files/`) and the supplier memory
(`supplier-items/`). The registry is written by the poller alone, through the
system routes above.

**Hosted invoice AI allowance.** `invoice-ai-usage` is an internal action used
by the Next invoice reader, never a browser-supplied accounting instruction.
The system counterpart, `POST system/invoice-ai-usage/`, accepts the same body
plus `userId` and requires a connected Drive folder belonging to that owner.
Both reserve under the workspace's User row lock, before any provider call.

- `{operation: "reserve", readId: null, pages, attempts}` admits one file:
  `pages` is the actual PDF page count (1–200), measured by the server, or 1
  for an image. `attempts` is 1–2, including the SDK's possible transport retry.
- `{operation: "reserve", readId, pages: 0, attempts}` reserves another model
  pass for that same owner-scoped read without charging its pages again.
- Both return `{readId}` (UUID, or null for a billing-exempt installation).
- `{operation: "record", readId, inputTokens, outputTokens}` records cumulative
  nonnegative token totals, each at most one billion, and returns `{ok}`.
  Repeated or older totals cannot decrease the recorded usage or refund work.

Free kitchens receive 10 AI pages and paid kitchens 100 per UTC calendar month.
Each plan also has eight reserved model attempts per allowed page, shared by
detection, extraction, escalation and transport retries. A call reserves both
its initial attempt and its possible retry, conservatively retaining unused
retry capacity. Next bounds outputs to 16,000 tokens per extraction attempt
or 2,000 for detection, detection text to 80,000 characters, and category text
to 8,000. This bounds provider work; it is not a dollar-denominated billing
cap. Actual reported tokens are retained for cost analysis, while provider
timeouts with unknown usage remain charged against the attempt allowance.

The first actual AI call consumes the whole file's pages, including when the
provider later fails or the user closes the reviewer. Template-only and manual
imports consume nothing. Saved invoices have no count limit. Deleting invoices,
undoing imports, merging ingredients/suppliers or reconnecting Drive cannot
refund AI usage. AI reads belong to the existing invoice workspace owner:
recipe collaborators do not gain access to that owner's invoices or allowance.
Account deletion cascades through its AI usage records.

An over-budget reservation answers 403 with `code: "invoice_ai_limit_reached"`
and a reset-date/upgrade message. No model call follows a failed reservation,
including when the backend is unavailable. An already admitted read can finish
at the page cap if attempt capacity remains. A new month refuses further calls
on an old read; a fresh read uses the new month. Upgrades/downgrades change the
limit without erasing usage. Billing-disabled, staff and enabled demo accounts
are exempt; the bring-your-own-Anthropic-key path never reserves hosted usage.
Drive leaves budget-blocked files `new` for a later month or upgrade. They do
not become failed invoices. A declined optional escalation retains the first
usable extraction.

`invoices-overview/` adds `aiUsage: {usedPages, maxPages, resetsOn, exhausted}`.
`maxPages` is null for exempt accounts; `resetsOn` is the next UTC month's first
day as a date-only `YYYY-MM-DD` string, deliberately not revived as a Date.
`exhausted` includes the internal attempt ceiling even if page slots remain.
The overview adds one billing lookup and one aggregate query; neither grows
with the number of AI reads. The invoices screen shows usage and reset date,
and refreshes them when the import dialog closes.

| Invariant | Accepted behavior | Refused/preserved behavior |
| --- | --- | --- |
| Syntax | Integer measured pages; 1–2 reserved attempts; UUID continuation | Booleans, negatives, malformed IDs and added continuation pages fail |
| Identity | Session owner or connected system Drive owner | Body userId cannot redirect a session action; foreign read IDs fail |
| Concurrency | Uploads and Drive reserve under the same owner lock | Parallel requests cannot pass the last page or attempt together |
| Precedence | Deterministic reading first; BYOK bypasses hosted quota | Missing backend reservation never permits Qwen spending |
| Lifecycle | Monthly reset; cumulative tokens; plan change retains usage | Delete, undo, merge and reconnect never refund; account deletion cascades |
| Downstream | Existing invoices, prices and manual imports stay usable | Budget-blocked Drive files remain new; optional escalation keeps first read |

**Drive folder.** The workspace's supplier documents live in one Google Drive
folder. Django stores Drive ids and metadata only — never file bytes; the Next
process fetches a document from Drive when it extracts it.
`connect-drive-folder` takes `{folderId, folderName?}` and returns
`{folder: {folderId, folderName}}`, replacing whatever folder was connected
(one per workspace) and clearing `registeredAt`, so the poller lists the new
folder in full before trusting Changes pages. `disconnect-drive-folder` takes no body and returns
`{ok}`; the registry survives it. Documents imported from Drive carry
`source: "drive"` on `import-invoices`, plus `driveFileId` and `drivePart` —
which document of that file this invoice was read from, 0 unless the file held
several receipts, so two invoices may share a `driveFileId`. Importing a part
marks that part imported and moves the file to `imported` only once no part of
it is still waiting; the readings are dropped when the file is done, not when
the first invoice off it is made.

**Drive registry.** Django keeps one row per file the workspace has seen in
its folder; Next does every piece of Drive I/O. A row's `status` is one of:

- `new` — importable and nobody has decided on it. This is what the Drive
  screen offers, what `driveNewCount` counts, and what the watcher reads next.
- `ready` — the watcher read it unattended and at least one document in it is
  still waiting to be confirmed. The row carries `parts`, one per document the
  watcher read out of it, and `driveReadyCount` counts every part still
  waiting, the way the reviewer shows them.
- `imported` — every document in it is decided and at least one became an
  invoice; `invoiceId` points at one of them, and each invoice carries the
  `drivePart` it was read from. The row outlives the file: deleting the
  document in Drive does not remove it.
- `skipped` — the merchant told Forkluck to stop offering it, or skipped every
  document in it one at a time.
- `failed` — extraction was tried and did not produce an invoice.
- `unsupported` — Next cannot read this kind of file; `reason` is the verdict
  (`heic`, `unsupported`, `too_large`).

A registration entry (the `files` of `POST system/drive-files/`) is
`{driveFileId, name, mimeType, sizeBytes, modifiedTime, webViewLink,
folderPath, support, removed}`: `sizeBytes` and `modifiedTime` may be null,
`support` is `ok`, `heic`, `unsupported` or `too_large`, and `removed` is a
boolean. Per file: `removed: true` deletes the row
unless it is `imported`; otherwise the row is created or refreshed — name,
type, size, modified time, link, folder path and `seenAt` are rewritten every
time. The status is the workspace's own: `imported`, `skipped`, `ready` and
`failed` survive any registration, while a `new`, `unsupported` or brand-new
row is re-decided — `new` when `support` is `ok`, else `unsupported` with the
verdict as its `reason`. A file mentioned twice in one call is registered once,
from its last entry.

Two rules follow the reading. A `ready` or `failed` row whose incoming
`modifiedTime` is later than the one stored goes back to `new` — the bytes
changed, so support is re-decided and what was read of the old document is
deleted. And an `imported` or `skipped` row drops its `parts`: the invoice
holds the truth in the first case, and nobody will confirm the file in the
second. A removed `ready` file is deleted like a `new` one.

`skip-drive-files` takes `{files: [{driveFileId, fileName?, reason?, part?}]}`
(at most 200) and returns `{ok}`: each file's row becomes `skipped` with that
reason, and a file with no row yet gets one under `fileName`. An entry naming
a `part` skips only that document of a file holding several: the part is
marked skipped, the file stays `ready` while any other part is still waiting,
and closes when none is — `imported` if any part of it was imported, else
`skipped` with that reason. A part of a file with no row is nothing to skip.
An entry with no `part` skips the whole file whatever it holds, and wins over
any part of the same file named in the same call. An `imported`
row is never demoted, and re-skipping is a no-op, so a whole selection can be
sent blindly. `unskip-drive-file` takes `{driveFileId}` and returns `{ok}`: the
row goes back to `new` with no reason and the next registration re-reads its
support verdict; an `imported` row is left alone. `retry-drive-file` takes
`{driveFileId}` and returns `{ok}`: a `failed` row goes back to `new` with no
reason so the next poll reads it again, and every other status is left alone.

`drive-folder/` answers `{folder, skipped, watch}`: the connected folder as
`{folderId, folderName}` or `null`, up to 500 `skipped` rows as
`{driveFileId, fileName, reason}` newest first, and `watch` as
`{polledAt, lastError}` — `null` until the poller has saved state for the
first time, and `polledAt` is `null` inside it when the poller has only ever
recorded an error.

`drive-files/?status=<new|ready|imported|skipped|failed|unsupported>&limit=<n>`
answers `{files, count}`. `status` is required and any other value is a 400;
`limit` defaults to 200 and is capped at 500. Each file is
`{driveFileId, name, mimeType, sizeBytes, modifiedTime, webViewLink,
folderPath, status, reason, invoiceId, seenAt, parts}`, ordered by modified
time newest first (files Drive gave no modified time last) and then by name.
`count` is every row in that status, not just the page — except for `ready`,
which counts the `ready` documents those files hold rather than the files
themselves, since the reviewer works through documents. `parts` is empty
except on a `ready` row, where it holds one entry per document the watcher
read out of the file, `part` ascending:
`{id, part, pageStart, pageEnd, region, status, document, model, escalated,
extractedAt}`. `document` is what the watcher read, opaque on the wire;
`pageStart`/`pageEnd` and `region` say which slice of the file it came from
and are null for a whole file; `status` is `ready`, `imported` or `skipped`,
this document's own verdict. They are prefetched for the page — one query for
every part of every row on it, never one per file.

**Supplier item key.** Every line is remembered under one key: the printed
item code lowercased, else `desc:` plus the normalized description, and
nothing when the line has neither. Django derives it (`supplier_item_key`) and
the browser mirrors it (`supplierItemKey` in `apps/web/lib/invoice-import.ts`); a key
sent by the client is never trusted, and `apps/web/tests/fixtures/supplier-item-keys.json`
holds the cases both rules are tested against. It is the `SupplierItem` and
`SupplierItemIgnore` `externalId`, is stored on each line as
`InvoiceLine.item_key`, and is what `invoice-line-status`, `import-invoices`,
and `review-invoice-line` key their supplier-memory lookups and writes on,
so a receipt that prints no codes builds the same memory a Baldor invoice
does. A price updates with no click only when that key already has a
`SupplierItem` — the merchant confirmed it once; a name match is only a
prefilled suggestion. A memory that turned out wrong is repointed, ignored
or deleted through the mapping table below.

`invoice-line-status` answers `{items, duplicate, existingInvoice, categories}`
(plus `driveFileKnown` when it was asked about a Drive file id). It takes an
optional `drivePart` (0 by default, under 40) beside `driveFileId`:
`driveFileKnown` asks whether _that document_ of the file was imported, so
importing receipt 1 of a bundle does not make receipt 2 look like a repeat.
`existingInvoice` is the row behind `duplicate` —
`{id, publicId, invoiceNumber, invoiceDate, totalCents, lineCount, importedAt}`,
`id` being the UUID `delete-invoice` takes — so a review screen can put the
receipt in hand beside the invoice it would repeat. It is null when nothing
matches the fingerprint and when the probe was sent no `invoice` header.
The optional header includes `documentType`. A numbered supplier invoice uses
supplier + number as its stable identity so correcting a read date or total
does not duplicate it. A receipt uses supplier + printed number + date + total:
grocery receipts routinely expose a reusable cashier/operator number, so the
same number on a different shop is not a duplicate. Numberless documents use
supplier + date + total.

**Supplier items.** `supplier-items/` is the mapping table: `?supplier=`
(a supplier key), `?q=` (matched against the title and the key), `?tab=items`
(default) or `ignored`, `?limit=` (50, at most 200) and `?offset=`. It answers
`{items, total}`, where `total` counts the whole filtered set and `items` is
the page. An items row is `{id, supplier, supplierName, externalId, hasCode,
title, rawSize, packPriceCents, packAmount, packUnit, ingredientId,
ingredientName, isPreferred, timesSeen, lastInvoiceDate}`; `hasCode` is false
when the key was derived from the description (`desc:`), `timesSeen` counts
the invoice lines bought under the pack and `lastInvoiceDate` is the newest of
their invoice dates, or `null`. An ignored row carries `{id, supplier,
supplierName, externalId, hasCode, title, rawSize}`.

`relink-supplier-item` takes `{itemId, ingredientId}` and returns `{ok}`. It
points one remembered pack at a different ingredient and moves the invoice
lines bought under it; no price is written, so it joins no undo batch. An
ingredient in another workspace is refused. The pack keeps its preferred flag
only when the new ingredient has none, and the ingredient it left promotes its
next remaining pack. `ignore-supplier-item` takes `{itemId}` and returns
`{ok}`: the pack is dropped and its invoice lines unlinked, and the key joins
the skip list with the same title and pack size, so the next invoice printing
it is filed as an expense without a prompt. `unignore-supplier-item` takes
`{supplier, externalId}` and returns `{ok}`. `delete-supplier-item` takes
`{itemId}` and returns `{ok}` — the same removal without the skip-list row, so
the next invoice matches the item from scratch. All four are keyed on the
supplier string, so a rename or a merge carries them.

`save-supplier` takes
`{id?, name, email?, phone?, accountNumber?, notes?, defaultCategoryId?}`.
`defaultCategoryId` is an expense category of the caller's own — an unknown id
answers "Expense category was not found" — and null clears it; `merge-suppliers`
inherits it like the other details, filling the target's blank from the source.
The key is derived from the name the same way `supplierKeyFromName` derives it
in the browser, so both ends agree on which rows a supplier owns. Creating
onto a key that exists answers "That supplier already exists". Editing a name
whose key changes moves the workspace's `Invoice`, `SupplierItem` and
`SupplierItemIgnore` rows onto the new key; when that key belongs to another
supplier it answers "That name belongs to another supplier. Merge them
instead." `merge-suppliers` takes `{sourceId, targetId}`, moves those same
rows, keeps the target's contact details and fills its blanks from the
source, deletes the source, and returns `{ok, moved: {invoices, items,
ignores}}`; an item or skip-list row whose SKU both suppliers carry keeps the
target's and drops the source's, so `moved` counts what landed.
`delete-supplier` takes `{id}` and refuses with "That supplier still has
invoices or items." unless all three counts are zero.

**Expense categories.** An expense category is
`{id, name, isIngredient, isSupply, position}` wherever it is returned
(`invoices-overview/`, `invoice-line-status`). `isIngredient` means costable:
its lines may run through the supplier-item and price-history pipeline.
`isSupply` says the category buys what the kitchen does not eat, so an
ingredient one of its lines creates is stored `non_edible` — derived on the
server from the line's stored category, never from a client flag. A supply
category is always costable, so `isSupply` implies `isIngredient`. Packaging
and Cleaning supplies are seeded as costable supply categories.

`save-expense-category` takes `{id?, name, isSupply?}` and returns `{id}`.
Names are unique per workspace on their normalized form. `isSupply` absent
leaves the flag as it is, so a rename never un-supplies a category; setting it
true makes the category costable, and setting it false on a supply takes that
costability back. `delete-expense-category` takes `{id}` and returns `{ok}`;
it refuses the food Ingredients category, which anchors costing, but a supply
category is the workspace's to drop.

`save-payment-method` takes `{id?, name}` and returns `{id}`. Names are unique
per workspace on their normalized form, and one of the four built-in wire
values is refused with "That payment method is built in".
`delete-payment-method` takes `{id}` and returns `{ok}`; invoices keep the
method text they were saved with, so only the choice goes away.

`save-invoice` takes
`{id?, supplierName, invoiceNumber?, invoiceDate, dueDate?, totalCents,
taxCents?, subtotalCents?, notes?, paymentMethod?, expectedEditVersion?,
lines}`, each line the shape `import-invoices` takes plus an optional `id`, and returns `{item}`,
the same document `invoices/<public_id>/` returns. `dueDate` and
`subtotalCents` are null when the document printed neither; neither is ever
derived from the figures it did print. An update may carry `expectedEditVersion`; the
row is locked and checked against it inside the transaction that already holds
the workspace and cost-settings locks, so a save written against an older read
answers 409 `stale_write` rather than overwriting. A create omits it and starts
at 0. A create writes
`source: "manual"` with a blank `fileName`, a `documentType` of `invoice`, and
the workspace currency. An edit takes any invoice the workspace has, imported
included, and carries `source`, `fileName`, `driveFileId`, `drivePart`,
`driveWebViewLink`, `documentKey`, `extractionModel`, `documentType` and
`currencyCode` off the row: correcting a typo never blanks a Drive link, drops
the stored file or restates a EUR document in the workspace currency. A negative total is refused with "Enter a
positive total; credits come from your supplier documents." unless the row's
carried `documentType` is `credit_memo` or `refund`, which print one. A
`costEntry` on a document that carries a credit `documentType`, or one billed
in another currency, is refused the same way `import-invoices` refuses it.
An edit replaces every line and opens a
_new_ price batch for the lines that carry a `costEntry`. A replacement line
identified by an existing `id` keeps that id and its own invoice-price links;
the id must belong to this invoice and occur only once in the payload. Explicit
`id: null` creates a new line without inheriting another occurrence's links.
Legacy lines omitting `id` match remaining occurrences of their `item_key`
once each, in document order. A replacement that carries no `costEntry`
inherits that line's supplier item, ingredient and `priceUpdated`, so editing
an imported invoice does not unmatch what the import matched. Prices are history,
so a corrected line writes the newer price and the batch the earlier save
wrote stays on the ladder, undoable from the ingredients Import history like
any other.

A `costEntry` carries `{name, packUnit, packAmount, packPriceCents, rawSize,
quantity, preferred, ingredientId, remember?}`; `packUnit` is one of the
`PACK_UNIT_SLUGS` purchasing slugs, and the grams behind it are derived, never
sent. `preferred` mirrors probe state for compatibility; invoice input cannot
choose a preferred pack. `remember` defaults to true and is the supplier's
memory: false creates no supplier item, so the next invoice printing that item
asks again. A remembered invoice line may update the price of the exact pack
the merchant already made preferred, and a newly created ingredient starts
with its first pack and price. Attaching any other invoice pack to an existing
ingredient records the supplier item and line relationship without changing
the preferred pack or the ingredient's costing price. A one-time line follows
the same rule: it prices a new ingredient, but never an existing one. It still
joins the batch and is undoable, and counts in `priceUpdated` but in neither
`created` nor `updated` (those count supplier items).

`review-invoice-line` takes `{lineId, categoryId?, costEntry?}` and returns
`{item}`, the same document `invoices/<public_id>/` returns. It resolves one
line of any invoice, imported or hand-typed, without editing the document: the
category is set (absent or null clears it) and a `costEntry` runs the same
supplier-item pipeline an import runs, effective as of the invoice's date. The
pack/link—and a price when the rule above permits one—joins the invoice's own
batch, so the ingredients Import history undoes it like any other; an already
undone batch is replaced rather than reopened. A
`costEntry` is refused on a credit memo or refund, and on a document billed in
another currency. A line that ends with a category or an ingredient stops
needing review, and the invoice's `matchedLineCount` and `unresolvedLineCount`
are recounted.

An entry uploaded from the merchant's own machine carries `documentKey`, the
key of the file Next stored before the import, null when there is none.
`delete-invoice` answers `{ok: true, documentKey}` — the key off the row it
deleted, null when it had none — so Next can delete the stored file.

`import-invoices` carries `reviewedCurrencyCode` — the currency shown during
review. It is compared with the workspace currency under the conversion lock
and the import refused on mismatch, so a mid-review conversion cannot restamp
figures nobody approved. Each entry may also carry `dueDate`, `taxCents` and
`subtotalCents`; all three default to null and null is stored as "the document
did not print it" — only `taxCents` falls back to 0, because a document with
no tax line has no tax. Every imported invoice writes its own `added` activity
line, so the invoice page can read its history back with
`activity/?resourceId=`.

None of this adds an action slug: the tabs, the search, the document fields
and the supplier default all ride on the actions and reads already listed.

**Receipt feedback.** `save-receipt-feedback` takes `{id, rating, note, fileName,
supplierName, model, extraction, original, corrected}` and returns `{ok: true}`.
`id` is a client-generated UUID scoped to the authenticated user; resubmitting
it updates that user's report rather than creating a duplicate. `rating` is
`up` or `down`; `note` is optional prose up to 2,000 characters. The JSON
snapshots and optional raw extraction are each limited to 64 KB. They are
user-submitted evidence, never authoritative pricing or automatic training
labels. Snapshot fields preserve draft text, category/ingredient names and
highlight coordinates so staff can inspect incomplete corrections too.

Feedback is offered in upload and Drive receipt review. It explicitly captures
edits **at submission**, not subsequent edits. Reopening feedback and sending
again updates its rating, note and current corrections; the first original
read remains intact. The staff console's Support requests section filters
thumbs down and unreviewed reports and shows a field-by-field comparison. A
changed resubmission reopens a reviewed report; an identical retry does not.
No receipt image is copied and no new provider request is made.

| Feedback boundary | Invariant |
| --- | --- |
| Syntax | Both ratings; blank notes; partial draft values; nullable legacy extraction; malformed, oversized or missing snapshots refused |
| Identity | User comes from the session; submission ids never select another user's report; staff review uses the existing admin permission gate |
| Precedence | Original extraction and baseline are immutable after creation; explicit resubmission updates only the rating, note and submitted corrections |
| Lifecycle | Reports work before import and survive skip, import/undo, invoice deletion and supplier merge as independent snapshots; deleting the account or kitchen data removes them; staff may delete reports |
| Downstream | Feedback never changes quantities, supplier matches, prices or review blockers; ordinary invoice behavior continues unchanged |
| Display | Highlight padding is 4 CSS pixels horizontally and 2 vertically around the visual band; stored coordinates and hit targets remain unchanged at every zoom |

**What the model read.** An `import-invoices` entry also carries `extraction`,
the model's raw read of the document (opaque on the wire, null when there is
nothing to keep), and `escalated`, whether a second, tier-3 read won. Django
keeps them as one `InvoiceExtraction` row per invoice — its own row, like the
Drive extraction, so an invoice write never carries a document — and only for
an invoice the import created, never a duplicate. A read over 64 KB is refused;
deleting the invoice removes it. Nothing reads it yet: it is the labelled
example, read beside correction, that the extraction eval can score later.

**Supplier connectors (4)**
`connect-connector` takes `{providerKey}` and returns `{authorizationUrl}` for
the connector-hosted login. `complete-connector-authorization` takes the
callback's `{state, code}` and returns `{connection}`. The code and state are
single-use and user-bound. `enqueue-connector-sync` takes `{connectionId}` and
returns `{run}`, reusing an active run for that connection.
`disconnect-connector` takes `{connectionId}` and returns `{ok: true}` only
after the connector service confirms the same client/user/connection-token
binding. The durable worker validates every `supplier_documents:v1` page,
commits documents and its cursor, then acknowledges the page; a lost
acknowledgement is retried before new work is requested.

**Sales (20)**
`undo-sales-import`,
`reinterpret-sales`, `save-sales-product`, `delete-sales-product`,
`record-manual-sales`,
`ignore-sales-skus`, `unignore-sales-skus`, `ignore-sales-category`,
`save-sales-ignore-rule`, `delete-sales-ignore-rule`,
`preview-sales-ignore-rule`, `track-sales-modifiers`,
`associate-sales-modifier-options`, `save-sales-modifier-associations`,
`ignore-sales-modifiers`, `unignore-sales-modifiers`,
`update-sales-variant-multiplier`,
`update-sales-variant-attribution`, `untrack-sales-variant`,
`set-product-matching`.

`save-sales-product` refuses a `baseUnit` outside the product unit list
described with the product row shape above, including a vocabulary unit no
product is sold by. An explicit each is stored blank, so the default has one
spelling. Omitting the key leaves the saved unit alone.

`save-sales-product` takes the product's SKUs as `skus`, at most 20 rows of
`{sku, quantityMultiplier}` replacing the saved list in order, like
`apps/web/components`. `sku` is required text up to 120 characters; `quantityMultiplier`
defaults to 1 and has the variant multiplier's range. Any number of rows may
be at 1. A SKU listed twice, ignoring case and spacing, is refused (`SKU is
listed twice`), and one another product carries is refused with `SKU is
already used by another product`. Omitting `skus` leaves the saved rows alone.
A top-level `sku` is refused with a message so a client that predates the list
fails loudly.

Every variant names one product. `save-sales-product` accepts variant rows with
`quantityMultiplier` and `attributionPercent`; the variant model and its
validation live in `docs/SALES_INTERPRETATION_SPEC.md`. A box
of several products is not a kind of variant: it is an ordinary create carrying
`name`, `components[]` of `{productId, quantity, position}`, an optional
`sellPriceCents`, and one variant. `kind: "assorted"` and `members` are refused
with a message so a client that predates the change fails loudly instead of
saving half a box; neither key is on the wire any more.
`attributionPercent` is a whole percent from 0 to 100, or null for the default,
which every reader treats as 100. Bundle amounts split by relative standalone
value and reconcile exactly to the variant's attributed share, which never
exceeds the source financial line; whatever the percent leaves over is
unattributed and reaches no product. An omitted `attributionPercent` leaves a
saved variant's share alone, so a client that predates the field cannot reset
it; an explicit null clears it back to the default.
`update-sales-variant-attribution` takes `{variantId, attributionPercent}` and
sets that one field, so a variant can be corrected without being relinked; it
reports `variantId`, the stored `attributionPercent`, and the interpretation
receipt. `update-sales-variant-multiplier` sets a variant's units per sale and
refuses nothing but a missing variant and an out-of-range multiplier.
`untrack-sales-variant` takes `{variantId}`, refuses anything but an item
variant, detaches that variant's lines and deletes it, so the identity returns
to Catalog review; it reports `variantId` and the interpretation receipt. A
variant that is already gone counts as already untracked and succeeds with an
empty receipt.

`set-product-matching` takes `{enabled}`, writes the workspace setting, and
acts on it in the same call: on, it applies each tracked SKU and every SKU a
product declares in `skus[]`, with its units per sale, to every unlinked
identity carrying it, on either channel, the tracked variant's own included,
and reports the variants created as `linked`; off, it withdraws the
never-edited links it made and reports `withdrawn`. An identity the merchant
ignored or whose records disagree on the SKU sits out, and a SKU already
carried by a different product is never touched. `save-sales-product` runs the
same application for the variants and SKUs it saves, and a sync applies it to
the identities its catalog and orders bring in, so a pack SKU declared before
its first sale links on arrival.

Product Hub scalar edits send `{id, expectedEditVersion, ...present scalar
fields}`. A composition edit sends the same identity and version guard plus
`apps/web/components`, replacing the full ordered list with rows of
`{recipeId|null, ingredientId|null, productId|null, quantity, unit, position}`.
Exactly one target id is set, recipe and product units are empty, ingredient
units are vocabulary slugs, and omitted variants, recipes, and scalar fields
are preserved. A product component must be an active product of the same
workspace unless it is already linked, may not be the product being saved, and
may not close a loop through other bundles. The action
answers the updated `{id, publicId, editVersion}` so the page-level chrome can
continue its optimistic lock.
Every update requires the version guard, including the catalog dialog's legacy
full replacements of `variants` and `recipeLinks`; a create omits it. That
legacy `recipeLinks` knows only recipes, so it replaces the product's recipe
components and leaves its ingredient components in place.

`record-manual-sales` is a separate manual ledger write and does not edit the
Product aggregate or its `editVersion`. It takes
`{productId, soldOn, quantity, totalNetCents?}`; `soldOn` is a business date in
`YYYY-MM-DD`, `quantity` is non-negative, and omitting `totalNetCents` records a
count-only row. A quantity of zero deletes that product/day row. The receipt
carries `ok`, `deleted`, `productId`, `publicId`, `soldOn`, and `importId`,
plus the row details when a row remains. Manual rows never appear in provider
import history; their daily ledger `netSalesCents` is null when the total was
omitted, and aggregate totals exclude unknown amounts.

`ignore-sales-category` accepts `channel`, `category`, and one or more
`providerAccountIds`, so one display bucket can span historical provider
connections.

An **auto-ignore rule** is a standing instruction rather than a decision about
one identity: `save-sales-ignore-rule` takes `{id?, channel, enabled,
conditions}`, where `conditions` is one to five `{field, operator, value}`
entries ANDed together — `field` is `sku`, `title`, or `variant`, `operator`
is `is`, `starts_with`, or `contains`, and a blank value is refused because it
would cover the whole channel. `channel` is a channel or `null`, which covers
every channel; the key itself is required, so the widest rule has to be asked
for. Matching is case- and whitespace-insensitive, folded exactly as an
identity's own match key is. A merchant may hold at most 25 rules, and two
rules whose channels overlap may not carry the same conditions — a rule
covering every channel overlaps every other rule. Where two rules could claim
one identity, the rule naming a channel claims it before the one that does not.

Saving a rule materializes its matches as ignore rows owned by that rule; the
same sweep runs after every catalog sync, sales sync, and CSV import, each of
which reports `ruleIgnoredIdentities`. Rules cover item identities only, never
modifiers. An identity a menu item already tracks is skipped, never ignored.
Editing a rule rebuilds its rows; disabling or deleting one releases them, and
`delete-sales-ignore-rule` reports how many `restored`. Because a rule owns its
rows, `unignore-sales-skus` refuses a rule-owned identity and names it — the
row would return on the next sweep. `preview-sales-ignore-rule` is a read on
the action route (the conditions cannot travel as query params): it takes
`{channel, conditions, page?, q?}` — `channel` again nullable — and returns the
paginated envelope, each row carrying `status` of `pending`, `ignored`, or
`tracked`, plus `truncated`.

`sku_ignore_json` carries `source` (`manual` or `rule`) and `ruleId`, and the
menu-overview payload gains an opt-in `rules` section.

**Menus (2)**
`save-menu` takes
`{id|null, name, periodStart|null, periodEnd|null, rebaseline?,
expectedEditVersion?, items[]}` and replaces the whole worksheet: rows present
by id are updated, rows without one are created and snapshot their food cost at
that moment, and rows left out are deleted. Positions follow the payload order.
A period is both dates or neither, forward, and at most a year. A row id must
already belong to the menu being saved.

Each row is `{id?, name, recipeId|null, productId|null, sellPriceCents,
qtySold}` with at most one link, owned by the caller: two links are refused
with "A menu item is a recipe or a product, not both", and a row with neither
is a plain named line, refused with "Name every item" when that name is blank.
A link may appear on one row only. A row carrying `apps/web/components` is refused. A
linked row's `name` and `category` columns are written from the link, never
taken from the client; an unlinked row stores the typed name and no category.
An uncostable link does not refuse the save; the row is simply left uncosted.

`rebaseline: true` re-freezes the baseline after the write: every row's
`original` becomes its live price, quantity and freshly computed food cost. It
returns the same payload as `menu/<menu_ref>/`, whose `menu` carries
`editVersion`, the counter the editor sends back as `expectedEditVersion`. An
update may carry it; the row is locked and checked against it inside the
transaction, so a save written against an older read answers 409 `stale_write`
rather than overwriting. A create omits it and starts at 0. `delete-menu` takes
`{id}`, cascades to the rows, and returns `{ok: true}`.

**POS / integrations and sync jobs (7)**
`pos-connections-status`, `enqueue-pos-sync`, `retry-pos-sync`,
`connect-square-token`, `connect-shopify-token`, `connect-shopify-credentials`,
`disconnect-pos`.

`enqueue-pos-sync` returns `{syncRun}` and is idempotent while the current
connection generation has a queued or running run. Its final receipt
distinguishes `imported`, `updated` (a corrected snapshot of an existing
immutable provider record — never a second financial line), and
`deduplicated` replays. A run copies `connectionGeneration`; reconnect and
disconnect cancel active work, and `cancelled` is terminal. `retry-pos-sync`
accepts only the user's own failed run and revalidates its connection,
provider, provider-account identity, and generation.

**Account (2)**
`update-account`, `set-newsletter`.

`newsletter/` answers `{enabled, available}` for the signed-in user, read
straight from Ghost: `available` is false when Ghost is unconfigured, and
`enabled` is null whenever Ghost cannot say (unconfigured, unreachable, or no
member for the address). `set-newsletter` takes `{enabled}` and answers with
the state read back after the write.

**Workspace settings (8)**
`update-business-settings`, `currency-conversion-quote`,
`delete-kitchen-data`, `reset-guest-links`, `invite-kitchen-member`,
`update-kitchen-member`, `remove-kitchen-member`, `remove-kitchen-invite`.

`business-settings/` also reports `payrollAverageRateCents`, read-only: what an
hour of paid time cost across the tenant's time entries of the last 90 days,
or null when there are none. It is _loaded_ and reported over _payable_ time —
wages plus the payroll tax, divided by `paid_seconds` less
`unpaid_break_seconds` — because the field it fills is defined as wage plus
payroll taxes and benefits, and hours an unpaid break took off were never
bought. It reports `overtimeWeeklyMinutes` (default 2400;
accepted 60–10080, kept when the field is omitted) and `productMatching` (default
`true`, written by `set-product-matching` only). A payload missing
`productMatching` must be read as `true` — the frontend fetch is an
unvalidated cast, so an absent key must not be mistaken for off.

It reports `labelRegion`, whose labelling rules the kitchen works to: `us` or
`eu`. The column is blank until the kitchen chooses, and a blank reads as
`eu` when the workspace bills in GBP or EUR and `us` otherwise; a stored
choice is always what is reported, whatever the currency.
`update-business-settings` accepts `labelRegion`, one of the two values and
rejected otherwise, keeps the saved one when the key is omitted, and carries
it across a currency conversion with the other settings.

It reports `payrollTaxPercent` (default 0; accepted 0–200, two decimal places,
stored as basis points), `unpaidBreakMinutes` (default 0, meaning off; accepted
0–480) and `unpaidBreakPerHours` (default 8; accepted 1–24). Each is kept when
its key is omitted and carried across a currency conversion with the other
settings — a rate and two durations are not money, so the exchange rate leaves
all three alone. `update-business-settings` re-costs every shift in the
workspace when, and only when, the break rule actually changes; the payroll
tax needs no such pass. See **Labor** above for what the two do to a shift.

It reports `timezone`, the zone the kitchen reports in, always resolved and
never blank: the stored choice, else the newest sale's zone, else the newest
shift's import zone, else `UTC`. Every timestamp the app renders is formatted
in it, so the server and the browser print the same text. Date-only fields
(`periodStart`, `periodEnd`, `invoiceDate`, `effectiveFrom`,
`currentRateEffectiveFrom`) are not: they carry no zone and are formatted in
UTC. `update-business-settings` accepts `timezone` as an IANA name, rejects
one this build cannot resolve, keeps the saved one when the key is omitted,
and carries it across a currency conversion.

`delete-kitchen-data` takes `{}` and empties the workspace in one transaction,
returning `{ok, deleted: {recipes, ingredients, menus, invoices, employees}}`
counted before the deletes. It clears sales, menus, recipes, ingredients,
invoices and labor, in that order, because sales rows protect the recipes and
products they name. It keeps the user, business settings, billing, the POS and
supplier connections and their sync runs, the stored Anthropic credential,
master price and catalog accesses, the currency conversion history, and the whole
activity log. The reset writes one `workspace` / `deleted` activity line named
"Kitchen data".

`kitchen-members/` answers the owner's own rows and nobody else's:
`{members: [{id, memberId, name, email, role}], invites: [{id, email, role}]}`,
members by name and invites by address. `id` is the membership or invite row;
`memberId` is the member's account.

`invite-kitchen-member` (with `{email, role}`, `role` one of `viewer` and
`editor`) lets an address into the whole kitchen and answers one of two
shapes. A verified account gets a membership row and
`{id, memberId, name, email, role}`, and is mailed a notification carrying a
sign-in link; re-inviting the same account restates the role on the row it
already has. An address with no verified account gets an invite row and
`{invite: {id, email, role}}`, and a mail asking it to create an account with
that address, which the verification claim then turns into the membership.
Both mails are best effort and are sent after the commit: a kitchen invite
carries no token, so a mail that never leaves costs the invitee a nudge, not
their access, and never deletes the row. Inviting is budgeted at 20 addresses
per day per account. The owner's own verified address answers "You already own
this kitchen".

`update-kitchen-member` takes `{memberId, role}` — the member's _account_ id,
the `memberId` of the row, not the membership id — and answers `{ok}`; an
address the caller has no membership for answers "Member not found".
`remove-kitchen-member` takes `{membershipId}` and serves both directions: the
owner removing someone and a member leaving, because the row is scoped to
`owner = caller OR member = caller`. `remove-kitchen-invite` takes
`{inviteId}` and revokes a pending invite. Both answer `{ok}` whether or not a
row matched, and neither writes an activity line. A membership grants the
kitchen's recipes and nothing else: money, invoices, sales, labor, menus,
products, integrations and settings stay owner-only, because every one of
those reads is scoped to the caller's own tenant.

`reset-guest-links` takes `{}` and deletes every RecipeGuestLink under the
tenant's recipes and every RecipeBook it owns, returning `{ok, revoked}` — the
link and book rows removed, not the book entries that go with them. A guest
token is the whole credential, so a deleted row is a dead `/shared/<token>` or
`/shared/book/<token>` URL.
Collaborator shares, which are accounts rather than links, are untouched, and
the reset writes no activity line.

**Billing (3)**
`create-stripe-checkout`, `create-billing-portal`,
`sync-stripe-subscription`.

`create-stripe-checkout` takes `{}` and returns `{url}` for the configured
$7/month price. Before contacting Stripe it requires the locally persisted
account/product/price/endpoint/secret attestation and signed-webhook proof. It
reserves one active local attempt and one customer identity before external
effects; repeated clicks and retries reuse stable provider idempotency keys.
An expired session is retired before one replacement is reserved. A completed
session retains its returned subscription id and is neither replaced nor
allowed through account deletion until that exact subscription appears in the
local mirror. No trial is ever attached: an attempt reserved before trials were
removed is expired and replaced rather than reused. Checkout is refused only
when the account's status already maps to the paid plan, so a Free account can
always upgrade.

`create-billing-portal` takes `{customerId?}`. After a complete account refresh,
one relevant Stripe customer returns `{url}`. Multiple relevant customers and
no id return `{customers: [{id, label}]}`, where `id` is a local UUID. Supplying
one of those UUIDs returns `{url}`; foreign, stale, malformed, and raw Stripe ids
are rejected through the authenticated user's queryset.

`sync-stripe-subscription` takes an optional `checkoutSessionId`. When present,
both its `client_reference_id` and its Stripe customer must resolve to the
authenticated local account. It marks that account's attempt complete only
when Stripe reports the session complete, runs a full account reconciliation,
and returns the session's `billing` shape without `recipeCount`, so
`{status, trialDaysLeft, locked, plan, entitlements}`. The completion UI treats
`plan === "paid"` as success, retrying eight times at 500 ms intervals, then
shows a manual retry instead of navigating on a snapshot that is still free.

The authoritative slug → handler mapping lives in `EXPECTED_ACTIONS` in
`apps/api/forkluck/test_contract.py`.

## Save and authorization invariant matrix

| Boundary | Accepted behavior | Refused or preserved state |
| --- | --- | --- |
| Staff access | Active staff with admin-purpose code proof; ordinary staff when code mode is disabled | App password/verification sessions and preexisting staff sessions do not bypass code mode; logout and account switches cannot transfer proof |
| Recipe line syntax and ownership | Optional unique UUIDs, scoped existing identities, fresh ids for new lines, boolean cost flags | Foreign or repeated ids and nonboolean flags fail atomically; shared editors cannot set or clear owner exclusions through aggregate saves or kitchen creation |
| Recipe line lifecycle | Stable ids preserve exclusions through reorder, repeated saves and draft restoration; new collaborator lines are included | Legacy shared snapshots without ids require reload when exclusions exist; omitted collections remain; removed lines are deleted; owner copies receive fresh identities |
| Invoice line identity | Exact invoice-scoped ids take precedence; legacy occurrences match once in document order | Repeated SKUs or descriptions never collapse references; foreign/duplicate ids roll back the whole edit; explicit new lines inherit no prior links |
| Invoice price lifecycle | Edits retain each surviving occurrence's primary and secondary references, pack measures and import-undo ownership | Reorder/rename does not move references to another occurrence; removed lines lose their references; document currency and pantry price history retain their existing rules |
| Daily sales completeness | Direct and expanded bundle contributions combine units and known money within one product/channel/date/currency | Missing manual net remains null even beside known revenue or nested bundle sales; other money fields still conserve their allocations and as-sold facts remain unchanged |
| Bundle graph writes | Product editor and staff component validation hold the same workspace lock through save | Opposite concurrent edges cannot both pass; product deletion follows the same workspace-before-product lock order |

## Error funnel

`action()` is the only place backend failures become HTTP status codes. All
error bodies are exactly `{"error": "<message>"}`, except where a stable
machine-readable `code` is listed below.

| Condition                                                                      | Status | Body                                                                                                                     |
| ------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| Unknown slug                                                                   | 404    | `{"error": "Not found"}`                                                                                                 |
| Missing / wrong internal secret                                                | 404    | `{"error": "Not found"}`                                                                                                 |
| Valid secret, no session                                                       | 401    | `{"error": "Authentication required"}`                                                                                   |
| Non-POST method                                                                | 405    | Django's default (not JSON)                                                                                              |
| Body is not valid JSON                                                         | 400    | `{"error": "Invalid JSON body"}`                                                                                         |
| Body is JSON but not an object                                                 | 400    | `{"error": "JSON body must be an object"}`                                                                               |
| `ValueError`                                                                   | 400    | `str(exc)`                                                                                                               |
| `ValidationError`                                                              | 400    | `exc.messages[0]`                                                                                                        |
| `IntegrityError`                                                               | 409    | `{"error": "That change conflicts with existing data.", "code": "conflict"}`                                             |
| `StaleWriteError`                                                              | 409    | `{"error": "This <kind> changed in another window. Reload to see the latest.", "code": "stale_write", "editVersion": n}` |
| `TokenCryptoError`                                                             | 400    | `"Stored provider credentials could not be read. Reconnect the channel in Settings."`                                    |
| Billing configuration, provider, or concurrent refresh temporarily unavailable | 503    | `{"error": "Billing is temporarily unavailable. Try again shortly.", "code": "billing_not_ready"}`                       |
| Account being deleted                                                          | 403    | `{"error": "Subscribe to continue using Forkluck.", "code": "subscription_required"}`                                    |
| `EntitlementError`                                                             | 403    | `{"error": str(exc), "code": "upgrade_required"}`, or the code the raiser named                                          |

`TokenCryptoError` and `IntegrityError` details name key ids, tables, and
constraints, so both are logged and replaced with the fixed messages above; a
domain that can explain a specific constraint catches it itself and raises
`ValueError` with its own wording. Everything else propagates as a 500. A
handler's returned dict _is_ the response body (`JsonResponse` verbatim).

The `subscription_required` 403 is raised by the dispatch route before the
handler runs, on every action except the three billing ones, so an account
under deletion can still reach Checkout and the portal. A lapsed subscription
no longer blocks writes at all: it drops to the Free plan.

`EntitlementError` is raised by a handler instead, once the plan's catalog says
the feature is not included. `save-recipe` raises it as
`recipe_limit_reached` — "You've reached the 10-recipe limit on the Free plan.
Upgrade to create unlimited recipes." — on the create branch only, so existing
recipes stay editable at the cap and deleting one frees a slot. The boolean
flags raise the default `upgrade_required` from the handlers that spend money
per use: nutrition and catalog search, POS sync enqueue and retry, and
connector connect, complete-authorization and sync. Reads stay ungated, so a
downgraded account can still see and disconnect what it connected.

Next Server Actions expose expected failures as data — each returns its
payload or `{error: string}` — without changing the Django wire format above.

## Date reviver allowlist

The reviver in `apps/web/lib/backend/client.ts` is the authoritative list of keys turned
from ISO strings into `Date`; a timestamp emitted under any other key reaches
the frontend as a `string`, and the serializer pins fail unless that key is
recorded there or as a deliberate exception in `apps/api/forkluck/testing.py`.

Date-only fields (`periodStart`, `periodEnd`, `invoiceDate`,
`effectiveFrom`, `currentRateEffectiveFrom`) are deliberately absent — they
stay as `YYYY-MM-DD` strings and must not be revived into a timezone-shifted
`Date`.

## Serializers

`apps/api/forkluck/test_contract.py` is the authoritative inventory: it pins
every serializer's shape recursively (nested objects as `parent.child`, list
elements as `parent[].child`), and `test_contract_envelopes.py` pins the
view-level payloads and holds them equal to `apps/web/lib/backend/schemas.ts`.

`recipe_json.method` is always a string — `""` when there are no preparation
steps; readers never derive method prose from `body`. `locked` is a guard the
owner sets while cooking from a recipe, not a permission. Nothing writes or
enforces it: no action sets it, the editor does not read it, and `save-recipe`
does not check it. It is a stored flag waiting for the guard to be written. `ingredient_json.nutrition`
is `null` until the user maps a FoodData Central record; a mapping carries the
FDC source id, description, `updatedAt`, and normalized `per100g` composition.
`totalCarbohydrate` retains the source definition including fibre and `sodiumMg`
retains source milligrams; older snapshots may omit those keys and readers
derive compatible values from the preserved composition. `saturatedFat` is a
share of `fat` rather than mass beside it, so it stays out of the composition's
mass accounting and is clamped to the record's own total fat; it has no derived
fallback, and a snapshot that omits it is null: unknown, which the label
preview reports as incomplete rather than as zero. `nutrition.source` is
`usda_fdc` or `custom`; a custom snapshot comes from an applied
`request-custom-nutrition`. Search results never contain the configured API
key.

`nutrition.packageIngredients` is the package's own ingredient list as the
branded FoodData Central record carries it, stripped and capped at 4000
characters. A common food (Foundation, SR Legacy, Survey) states none, and so
does a typed custom value: clearing a mapping, applying a custom request and
merging an unmapped ingredient carry or clear it with the rest of the
snapshot.

`ingredient_json.allergenHints` is what nobody has decided yet, in three
sorted lists of tag keys. `contains` and `mayContain` are read off
`packageIngredients` by a keyword scan: case-insensitive whole words, a
trailing `CONTAINS ...` sentence folded into the scan, and a
`MAY CONTAIN ...`, `MAY ALSO CONTAIN ...`, shared-equipment or shared-facility
sentence read as may-contain instead. The keyword lists are deliberately
conservative, because a suggestion the scan misses costs less than one it
invents: `coconut milk`, `oat milk`, `cocoa butter` and `peanut butter` never
name milk, and a `gluten free` claim never names a gluten cereal. `checkLabel`
comes from the catalog, whose `verify` column marks a tag that depends on the
brand rather than on the ingredient. A hint is a suggestion, never an
assertion: `checkLabel` reaches no effective status, no browse facet or
filter, and no recipe rollup, and a key the user has already set or cleared
through `replace-ingredient-allergens` drops out of all three lists, as does a
`contains` hint the effective status already asserts.

## Recipe nutrition (label preview)

`GET recipes/<ref>/nutrition/` answers `{item}` for any recipe the user can
open (owner, editor or viewer) and `{item: null}` otherwise. It is the only
engine that sums nutrients for a label preview, in
`domains/recipes/nutrition.py`; the TypeScript side rounds and formats what it
returns and sums nothing. The shape is pinned as `recipeNutritionPayloadSchema`
in `apps/web/lib/backend/schemas.ts`.

- Each ingredient or sub-recipe line carries `grams` (the line as written,
  weighed through the ladder costing climbs, yields left out), `netGrams`
  (`grams` times `efficiencyAfterCooking / 100`), and a `status`: `linked`,
  `unlinked`, `nonEdible` (packaging: contributes nothing, allergens
  included), `discarded` (yield after cooking 0: no nutrients and no
  statement entry, allergens as tagged), `unresolved`, `unweighed`, or
  `subrecipeIncomplete`.
- `efficiencyAfterCooking` means the share of the line that stays in the
  dish, 0 to 100, bounded in the editor schema, `save-recipe`, the model and
  the database. Costing ignores it.
- Nutrients are never rescaled. `batch.grams` is the declared finished weight
  (a mass yield or the equivalency mass) when stated, else the net input sum;
  `per100g` and `perServing` divide by it. A sub-recipe rolls in scaled by the
  line's net grams over its own batch grams, its statement expanded into the
  parent's.
- Every nutrient is `{amount, complete}`. A key a linked record does not
  report leaves `complete` false and the amount as the sum of what is known;
  it is never read as zero. Added sugars come only from an ingredient flagged
  `sugarsAreAdded`, where they equal its sugars.
- `issues.batch` (`unlinkedIngredient`, `unweighedItem`, `unresolvedItem`,
  `subrecipeIncomplete`, `subrecipeUnresolved`, `subrecipeEmpty`,
  `allExcluded`, `noYield`) nulls every total; the serving's own issues
  (`noServingSize`, `servingNeedsEquivalency`, `packageBelowServing`,
  `servingAboveBatch`, `packageAboveBatch`) null only `perServing`. The last
  three are the physical constraints: a package holds at least one serving, and
  neither a serving nor a package is bigger than the batch.
  `packageNeedsEquivalency` rides in `issues.serving` too but touches no
  total: a serving's nutrients do not depend on the package. It nulls the
  counts alone. `batch.servings` counts servings in one container and
  `batch.containers` counts containers in the batch; an unset `package` makes
  the batch the container and leaves `containers` null.
  `readiness.us` and `readiness.eu` say whether each format's mandatory
  nutrients are complete and name the ones that are not.
- The statement lists what went in by weight as incorporated (line grams
  before retention), heaviest first, under the ingredient's `nutritionLabelName`
  or its name, merged case-insensitively. Each entry carries `allergens`, the
  sorted tag keys its ingredient asserts as `contains`, unioned when entries
  merge, so a label can emphasise the entry and name the species.
- `hasAllergenHints` says the line's ingredient carries allergen hints nobody
  has confirmed or dismissed, computed exactly as `allergenHints` is. A
  sub-recipe line is always false: its own lines each answer for themselves.
- A viewer receives names, statuses, weights, allergens, totals, statement and
  readiness. `ingredientPublicId`, `linkedDescription` and `linkedSource` are
  null for a viewer, `hasAllergenHints` is false, and `subrecipePublicId` is
  set only for a recipe they can open.


### Primo attachments and feedback

`POST /api/primo/attachments` accepts raw file bytes with an encoded
`X-File-Name` and UUID `X-Conversation-Id`. It enforces the chat origin,
identity and entitlement boundary before reading bounded bytes. Images
(JPEG/PNG/WebP), PDFs, TXT/CSV, XLSX and DOCX are supported; limits are 8 MB
per file (5.5 MB PDF), five files and 20 MB per message. Office archives use
the existing expanded-size budget. Up to 30 uploads per user/hour are admitted
before inference. The upload returns `{item: {id,name,mediaType,size,coverage}}`
after bounded text/vision extraction succeeds. After byte/storage admission,
the response streams JSON whitespace immediately and every 15 seconds, with
`Cache-Control: no-store` and `X-Accel-Buffering: no`. Existing JSON clients
remain compatible. Processing failures after headers have HTTP 200 and an
`{error}` envelope, which clients must check. The operation has a 240-second
deadline; disconnect/cancellation aborts extraction and records removal before
blob cleanup. The browser has a 270-second fallback and an actionable retry.
Vision uses the existing Qwen
vision integration; no kitchen mutations occur. Spreadsheet formulas are not
executed, and document instructions remain untrusted content.

`GET /api/primo/attachments?id=…&conversationId=…` returns an authenticated
private download. DELETE with `id` removes an unsent attachment. The internal
attachment action supports create, finish, manifest, read, remove, cleanup, ack-delete.
Only the internal Next caller supplies stored content and document keys.
Django checks ownership, conversation binding, preparation, expiry and
single-message attachment binding. Sent attachments live with the conversation;
unsent attachments expire after seven days. Cleanup records survive account
and conversation deletion. Blob deletion happens outside database transactions;
failed cleanup is retried by subsequent upload/delete operations.

User metadata adds `attachmentIds` and server-resolved `attachments` summaries.
The chat route resolves stored content by authenticated attachment IDs;
client file URLs, extracted text and supplied summaries grant no access.
Before history fitting can discard source turns, the chat route collects unique
attachment IDs from all accepted user messages. `manifest` takes
`{conversationId, ids}` (at most 1,000 IDs from 200 messages with five files each)
and returns only authenticated `{items: [{id,name,mediaType,size,coverage}]}`
through one query. Missing, foreign, unprepared, expired-unsent or removed IDs
reject the entire manifest before inference. Client summaries and assistant
metadata are ignored. A manifest exceeding 24,000 serialized characters returns
a request error asking for a new chat; sources are never silently dropped.

Primo's `read_attachment({attachmentId, offset=0, length=8000})` accepts only
server-admitted manifest IDs, rechecks the user/conversation boundary on each
read, and returns `{ok,attachmentId,name,coverage,offset,content,nextOffset,
totalCharacters}` or `{ok:false,message}`. Offsets are zero-based JavaScript
string positions; length is 1–8,000, offset is 0–24,000, and `nextOffset` is null
at the end of stored text. All calls share a 24,000-character turn budget,
reserved before concurrent reads. The tool cannot access raw blobs, external
URLs, or kitchen mutations, and is not exposed through WebMCP. The manifest
names every available source; content enters model context only on a read.
Page labels and spreadsheet sheet/row labels survive extraction. User text retains its
4,000-character limit. Longer assistant explanations use the existing 24,000-character
history fit instead of preventing the next user turn. Timestamps are exposed for
both streamed and restored responses.

Feedback takes `{conversationId,messageId,rating,comment}` with rating
`up`, `down`, or empty to clear, and an optional comment of at most 2,000
characters. Only the owning user's assistant message can receive feedback.
`feedback` and `feedbackComment` round-trip separately from transcript upserts.
Conversation list `q` searches titles with existing page/limit semantics.

| Primo experience invariant | Required behavior |
| --- | --- |
| Syntax | File drops over the full Home chat and visible rail/dialog, picker and clipboard use one admission path; text drags remain native; text, mentions and files compose together; IME Enter never submits |
| Admission | Latest draft state reserves each batch synchronously; each rejected file is named; loading or failed conversations cannot admit files |
| Upload lifecycle | Provider-owned uploads survive surface changes; uploading/reading/ready/error/removing are visible; cancellation and late responses cannot resurrect files or update another conversation; pending and failed files cannot send |
| Response lifecycle | While Primo answers, the next draft can accept text and files; sending waits for the answer and file preparation to finish |
| Terminal steps | Success, invalid tool arguments, retry, token limit, server deadline, user stop and disconnection settle on both client and server; no older or restored partial tool shows live progress |
| Recipe draft shape | Object/null yields remain strict; only JSON-encoded yield objects can be decoded, then the whole draft is validated; unknown units, negative amounts, extra keys and natural-language yields stay invalid |
| Source recipes | Distinct yields produce distinct draft cards with source labels; no automatic merging, record creation or invoice import |
| Source coverage | Actual pages/sheets read, capped rows/columns, character truncation and vision uncertainty are visible; excerpts never imply complete coverage |
| Identity | File reads, writes, binding and feedback are owner/conversation scoped; foreign identifiers fail before inference |
| Precedence | Bound user mentions retain existing precedence; file text and model output never grant identity |
| Draft lifecycle | Per-user/per-conversation text, mention bindings and file summaries survive surface switches; failed sends restore an untouched draft; retries containing already-bound files reuse their original message ID even after prompt edits or adding another file |
| Conversation lifecycle | Loading, missing and failed chats cannot submit; stale loads cannot replace the selected chat |
| History reads | Stable authenticated HTTP reads survive deployment action-ID changes; dates revive without mutating source/tool data; 401/404/backend/network errors stay distinct from empty lists, with retry on desktop and mobile |
| Navigation | New and restored tool results never navigate; only explicit guarded links leave the page |
| Persistence | Ready attachments bind atomically with the user message; incomplete files cannot send; feedback survives transcript retries |
| Deletion | Conversation deletion invalidates file access immediately; persisted cleanup records retry blob deletion outside the transaction |
| Downstream | Uploads never import invoices, sales or recipes; deterministic kitchen calculations and explicit recipe creation remain unchanged |

Primo focuses on recipes, invoices and directly related kitchen material.
Answers identify document facts by filename and available page or sheet/row
labels, distinguish them from authorized saved kitchen facts, and label general
culinary advice. Instructions embedded in documents cannot grant identities or
permissions. P&L and general financial-document analysis remain out of scope;
invoice review/import and explicit recipe creation retain their existing flows.

Primo save-turn also returns `responseMessageId` for the last supplied user message when a saved assistant reply exists. Regeneration reuses that ID so loading history does not resurrect the replaced answer. PDF extraction reuses the bounded, positioned invoice text reader for at most ten pages, with vision on scanned pages. Every file retains at most 24,000 characters and reports actual partial coverage. Spreadsheet extraction reads at most ten sheets, 201 rows and 50 columns per sheet; formulas use cached values. Attachment GET accepts `preview=text` for extracted content or `preview=media` for an inline image; the default downloads the original.
