# Save system

One system for every write a person makes by hand. It replaces five hand-rolled
protocols (recipe autosave, menu/invoice manual save, ingredient form, nutrition
immediate commits, ~40 dialogs). Async tasks — imports, POS and supplier
connector sync, AI parse — are outside it and must never render as a Save pill
or button.

## Invariants

1. **"Saved" means visible state == persisted state and every constituent write
   succeeded.** Composite user actions (recipe+tags, ingredient+tags, allergens)
   are one server transaction.
2. **Every attempt records the snapshot it covers.** A response never overwrites
   edits made while it was in flight; it only advances the baseline to what was
   sent.
3. **Concurrency is model-specific.** No model ever runs two writes to the same
   conflict domain concurrently.
4. **`{error}`, thrown, timeout, deploy-skew and conflict responses all become
   one typed failure** with three kinds: `validation`, `conflict`, `request`.
5. **A failed request reads "Not saved" until a later success.** Failed
   autosaves included.
6. **Validation failures stay "Draft", block the request, show inline
   `role="alert"`, focus the field.** Validation never disables Save.
7. **A dialog closes only after its awaited save succeeds.** A dirty dialog
   confirms before every dismissal path (Escape, backdrop, X, Cancel).
8. **A stale write is refused server-side by `edit_version`**, reported as
   `conflict`, and the local edits are preserved as a draft.
9. **No route change, back/forward, tab switch, reload or window close silently
   loses dirty work.** Document editors save-on-leave; forms confirm; unload
   prompts natively whenever dirty.
10. **Cmd/Ctrl+S saves wherever a Save button exists**, flushes the focused
    field first, and never submits a different form.
11. **Document editors have bounded local recovery** with an explicit
    allowlisted payload.
12. **Status is announced via `role="status"` without stealing focus**; failure
    is text, not colour alone.

## Four models

| Model            | Surfaces                                                                                                                                                                                                           | Controller                                    | Concurrency                                                          | Save button                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Document editor  | recipe (autosave + manual), menu, invoice                                                                                                                                                                          | `useDocumentSave`                             | one in flight; newer snapshot **queued**, drained with latest values | always rendered; clean = no-op; `pending` only for the user's own press; reads Saved (or Retry) for 2.5 s after a press, then Save again, as Ghost's task button does, and every press reads Saving… for at least 500 ms |
| Explicit form    | ingredient form; every dialog with fields (preparation, purchase-unit, supplier, category, payment method, account, business defaults, menu-item, ignore-rule, share, labor rates, connector/AI-key/channel setup) | `useFormSave` (+ `useDirtyDialog` in dialogs) | **duplicate submit rejected** while pending                          | `pending` while in flight; never disabled for invalid input                                                                                                                                                              |
| Immediate commit | nutrition source/label/allergens, product-matching, sell price, serving, yield-after-cooking, left-out-of-cost, conversion, modifier associations, employee active, supplier pack choice                           | `useCommit`                                   | **serialized per conflict domain**, coalescing to the latest value   | none (chrome Save is a no-op / other tab's handle)                                                                                                                                                                       |
| Async task       | imports, POS and supplier connector sync, AI parse                                                                                                                                                                 | unchanged                                     | own                                                                  | none                                                                                                                                                                                                                     |

Forkluck has no Edit/Cancel settings pattern, so "clean form disables Save" has
no consumer and is not built.

Deviation from the plan: the supplier-packs dialog was listed as an explicit
form, but picking a pack is a single click with no Save button, so it is an
immediate commit on `ingredient:<id>:preferred-pack`.

The settings list dialogs — categories and payment methods — hold no fields of
their own: `InlineNameField` is the form, and it reports `onDirtyChange`
upward so the dialog's own dismissal paths (scrim, X, Escape, Done, and a tab
change) go through `useDirtyDialog` as well.

### State union

One union across all three controllers and the pill (`SaveStatusState`):

`"saved" | "saving" | "error" | "conflict"`

| State      | Pill                                  | Enters                      | Leaves                                    |
| ---------- | ------------------------------------- | --------------------------- | ----------------------------------------- |
| `saving`   | `Saving…`                             | request in flight           | response                                  |
| `error`    | `Not saved`                           | `request` failure           | next success                              |
| `conflict` | `Changed elsewhere`                   | `conflict` failure          | Reload / Discard (Reload alone on a form) |
| `saved`    | `Saved` (`New` for an unsaved recipe) | success with no newer edits | next edit                                 |

`Draft` is not a state: the pill reads it whenever the surface is dirty and the
last request neither failed nor conflicted, so a validation failure — which
sends nothing — stays `Draft` without a state of its own.

Updates are immediate — no minimum-visible hold.

### Document editor

Baseline is `sent`, captured before the first await. On success the baseline
advances to `sent` (only when `wholeForm`); the server echo is adopted **only
if `latest === sent`**. `editVersion` is tracked from every echo and sent back
as `expectedEditVersion`. On `conflict` the state is `"conflict"`, autosave
stops, the queued snapshot is retained but **not drained** (it would resend the
same stale version) — only Reload/Discard resumes it; the local draft is kept.
A `request` failure still drains a genuinely newer queued snapshot. The editor
registers `beforeLeaveRef` (save-on-leave) and resets dirty on unmount. `save`
is told when the call came from that guard: a save on the way out must not
navigate, because the exit the cook picked owns the route and a post-create
`router.replace`/`push` issued here lands after it and swallows it. The created
record's URL is written with `history.replaceState`, which is not a navigation,
so it rewrites the entry being left behind.

### Explicit form

`submit()`: `validate()` → inline errors + focus, no request; else if pending →
ignored; else if clean → success with **no request** (no `edit_version` bump);
else run. A form with nothing saved yet is clean until the cook types — the pill
is quiet and no exit is guarded — but its first press still sends, since there
is no baseline for it to match. A `request` failure keeps the form open and
dirty with an inline message. `conflict` is its own state so the chrome reads
"Changed elsewhere" and offers Reload. A form keeps no draft store, so there is
nothing to discard: Reload is the whole resolution, and the typed values stay on
screen until the cook takes it.

### Immediate commit

`commit({domain, apply, revert, write})`. Per domain `useCommit` holds
`confirmed` (last server-acknowledged value) and `desired` (latest optimistic).
A newer value replaces a queued one. On any final failure the domain reverts to
`confirmed`, never to a previous optimistic value, so A-fails-then-B-fails
cannot leave A's value on screen. `revert` therefore puts back the **whole
domain** — every field of it, not the one this write touched — and takes its
snapshot from local state at the moment the write is issued, never from a server
prop the screen's own refresh has not re-delivered yet. A whole screen of
commits keeps the header's Save: on the ingredient's Nutrition tab it sends the
one typed field, the label name, which registers `saveRef` and reports dirty, so
the pill reads Draft and leaving the screen is guarded until the field commits.
The modifier-association dialog is the one commit with a button of its own: a
whole list of pickers is drafted together and sent as one write, and nothing
goes on screen ahead of the server, so the dialog closes only once that write
lands. Its pending state is the controller's `onSaveState`, not a flag of its
own.

## Concurrency rule

`edit_version` (`PositiveIntegerField(default=0)`) on `Recipe`, `Menu`,
`Invoice`, `Ingredient`. `domains/shared/versioning.py:check_and_bump(row,
expected)` runs inside the transaction after `select_for_update()`, raises
`StaleWriteError(current, kind)` on mismatch and increments on success. Dispatch maps
it to **409** `{"error": "This <kind> changed in another window. Reload to see
the latest.", "code": "stale_write", "editVersion": n}`.

Aggregate saves (`save-recipe`, `save-menu`, `save-invoice`, `save-ingredient`)
check and bump on update, and echo `editVersion`. Creates omit
`expectedEditVersion`.

Writes not reachable from an open editor of the record — importers, POS and
supplier connector sync, master/catalog price adoption, and undo receipts — do not participate in
versioning. Ingredient merge is the exception: it locks both rows and bumps the
surviving ingredient so a form open elsewhere cannot overwrite merged state.

## Conflict domains

`<kind>:<id>:<collection>`. Every write to a domain goes through that domain's
queue; a newer value replaces a queued one.

| Domain                               | Writes                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `recipe:<id>:costing`                | `update-recipe-costing` (portion and menu price together)                                             |
| `recipe:<id>:serving`                | `set-recipe-nutrition-serving`                                                                        |
| `recipe:<id>:item:<itemId>:yield`    | `set-recipe-item-yield-after-cooking`                                                                 |
| `recipe:<id>:item:<itemId>:left-out` | `set-recipe-item-excluded-from-cost`                                                                  |
| `ingredient:<id>:purchase-unit`      | `save-ingredient` pack fields / `link-invoice-line` / `disconnect-invoice-line` / `use-invoice-price` |
| `ingredient:<id>:allergens`          | `replace-ingredient-allergens`                                                                        |
| `ingredient:<id>:nutrition-settings` | `update-ingredient-nutrition-settings`                                                                |
| `ingredient:<id>:nutrition-source`   | `set-ingredient-nutrition`, `clear-ingredient-nutrition`                                              |
| `ingredient:<id>:conversion`         | `save-ingredient-conversion`, `reset-ingredient-conversion`                                           |
| `ingredient:<id>:preferred-pack`     | `set-preferred-supplier-item`                                                                         |
| `workspace:product-matching`         | `set-product-matching`                                                                                |
| `workspace:modifier-associations`    | `save-sales-modifier-associations`                                                                    |
| `employee:<id>:active`               | `set-employee-active`                                                                                 |

Writes no editor of the record is open beside — recipe `status` from the
recipes table, `review-invoice-line`, `archive-ingredient` — stayed plain
actions with no domain and no version scope.

**Bump rule.** A commit whose domain also holds data an aggregate save writes
**bumps `edit_version` and echoes the new version**, so a controller on the same
screen (`ingredient:<id>:purchase-unit` → the ingredient form) can adopt it. A
domain that owns its data exclusively does not bump.

| Bumps                                | Reason                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `recipe:<id>:item:<itemId>:yield`    | `save-recipe` writes `efficiency_after_cooking` for every item                 |
| `recipe:<id>:item:<itemId>:left-out` | `save-recipe` writes `excluded_from_cost` for every item                       |
| `ingredient:<id>:purchase-unit`      | it writes through `save-ingredient`, which the ingredient form also saves with |
| `ingredient:<id>:preferred-pack`     | `set-preferred-supplier-item` re-prices the ingredient off the chosen pack     |

Every other domain in the table owns its fields exclusively and does not bump.

The recipe tabs are separate routes, so no editor is mounted beside the yield
commit to adopt the version it bumps; the read it invalidates is in another
window, which is refused with a 409 on its next save.

## Write-ownership matrix

Exactly one version scope per field and relation: **aggregate** (the record's
save action) or one named conflict domain. "No writer" means no save surface
writes it today.

### Recipe

| Field / relation                                                                    | Scope                                                                                                       |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `title`, `description`, `body`, `method`, `code`                                    | aggregate (`save-recipe`)                                                                                   |
| `yield_amount`, `yield_unit`, `auto_sum_yield_enabled`                              | aggregate                                                                                                   |
| `serving_amount`, `serving_unit` (cost portion)                                     | `recipe:<id>:costing`; aggregate only for create/copy/import                                                |
| `shelf_life_*`, `prep_time_*`, `auto_prep_time_enabled`                             | aggregate                                                                                                   |
| `percentage_mode`, `percent_ingredient_enabled`, `percent_ingredient_type`          | aggregate                                                                                                   |
| `RecipeItem` rows, incl. `efficiency_after_cooking`                                 | aggregate; a linked canonical `display_name` also follows a sub-recipe title rename, which bumps the parent |
| `RecipeStep` + `RecipeTiming` rows                                                  | aggregate                                                                                                   |
| `RecipeBatchSize` rows, `RecipeEquivalency`                                         | aggregate                                                                                                   |
| `RecipeTagMembership` (owner only; `tags: string[]`)                                | aggregate                                                                                                   |
| `kind`, `category`                                                                  | aggregate                                                                                                   |
| `status`                                                                            | aggregate; `update-recipe-status` co-writes it, unversioned                                                 |
| `locked`                                                                            | no writer                                                                                                   |
| `menu_price_cents`                                                                  | `recipe:<id>:costing`; aggregate only for create/copy/import                                                |
| `nutrition_serving_amount`, `nutrition_serving_unit`                                | `recipe:<id>:serving`                                                                                       |
| one item's `efficiency_after_cooking`                                               | `recipe:<id>:item:<itemId>:yield` (bumps)                                                                   |
| `public_id`, `sellable_yield`                                                       | no writer                                                                                                   |
| `RecipeShare`, `RecipeGuestLink`, `RecipeComment`, `RecipeMedia`, `RecipeLineMatch` | own actions; not version-scoped                                                                             |

Editor authorization: an owner payload includes `tags`; a shared editor omits
the key. An omitted `tags` preserves existing memberships; an editor payload
containing `tags` is a 400. An editor may change only `title`, `description`,
`items`, `steps` — and, through its own domain, one item's yield.

### Menu

| Field / relation                                                                        | Scope                                                                                |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `name`, `period_start`, `period_end`                                                    | aggregate (`save-menu`)                                                              |
| `MenuItem` `position`, `name`, `category`, `sell_price_cents`, `qty_sold`, `product`    | aggregate                                                                            |
| `MenuItem` `original_sell_price_cents`, `original_qty_sold`, `original_food_cost_cents` | aggregate, written on create and only restated when the payload carries `rebaseline` |
| `MenuItemComponent` rows                                                                | aggregate                                                                            |
| `public_id`                                                                             | no writer                                                                            |

### Invoice

| Field / relation                                                                                                                                            | Scope                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `supplier`, `supplier_name`, `invoice_number`, `invoice_date`, `due_date`, `total_cents`, `tax_cents`, `subtotal_cents`, `notes`, `payment_method`          | aggregate (`save-invoice`, any invoice the workspace has)                                            |
| `source_fingerprint`, `line_count`                                                                                                                          | aggregate, derived                                                                                   |
| `InvoiceLine` `position`, `sku`, `description`, `quantity`, `unit`, `pack_size`, `unit_price_cents`, `line_amount_cents`, `currency_code`, `source_payload` | aggregate (lines are replaced)                                                                       |
| `InvoiceLine` `category`, `supplier_item`, `ingredient`, `price_updated`, `needs_review`, and the invoice's `matched_line_count` / `unresolved_line_count`  | aggregate; `review-invoice-line` co-writes them unversioned — see below                              |
| `document_type`, `currency_code`, `source`, `file_name`, `ingredient_import`                                                                                | aggregate, derived; on an edit they are carried off the row, never restated from the manual defaults |
| `drive_file_id`, `drive_web_view_link`, `extraction_model`                                                                                                  | import-owned; a save carries them off the row, and a new hand-entered invoice starts them `""`       |
| `public_id`                                                                                                                                                 | no writer                                                                                            |

### Ingredient

| Field / relation                                                                                                                                                        | Scope                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `normalized_name`                                                                                                                                               | aggregate (`save-ingredient`); an invoice only sets a new ingredient's name or restates it when updating that ingredient's already-preferred pack — see below                                                                                   |
| `category`                                                                                                                                                              | aggregate                                                                                                                                                                                                                                       |
| `IngredientTagMembership` (`tags: string[]`)                                                                                                                            | aggregate                                                                                                                                                                                                                                       |
| `purchase_cost_cents`, `purchase_size`, `purchase_unit`, `yield_percent`, `price_source`, the `IngredientPrice` row that travels with them, and the `SupplierItem` link | `ingredient:<id>:purchase-unit` (bumps); `set-preferred-supplier-item` restates them from its own domain, bumping the same counter; an invoice may initialize a new ingredient or update its already-preferred pack without bumping — see below |
| `status`                                                                                                                                                                | `archive-ingredient`; not version-scoped                                                                                                                                                                                                        |
| `non_edible`, `sugars_are_added`, `nutrition_label_name`                                                                                                                | `ingredient:<id>:nutrition-settings`                                                                                                                                                                                                            |
| `nutrition_source`, `nutrition_source_id`, `nutrition_description`, `nutrition_package_ingredients`, `nutrition_per_100g`, `nutrition_updated_at`                       | `ingredient:<id>:nutrition-source`                                                                                                                                                                                                              |
| `IngredientAllergenOverride` rows                                                                                                                                       | `ingredient:<id>:allergens` (one transaction)                                                                                                                                                                                                   |
| `IngredientConversion` row                                                                                                                                              | `ingredient:<id>:conversion`                                                                                                                                                                                                                    |
| `IngredientMeasure` rows                                                                                                                                                | no save scope; created by recipe paste, copied to the target by merges                                                                                                                                                                          |
| `Preparation` rows                                                                                                                                                      | preparation dialog, per row (`useFormSave`); merge moves source-only rows and bumps the surviving Ingredient                                                                                                                                    |
| `SupplierItem.is_preferred`                                                                                                                                             | `ingredient:<id>:preferred-pack`                                                                                                                                                                                                                |
| `IngredientInvoicePrice` rows                                                                                                                                           | `ingredient:<id>:purchase-unit`; many-to-many invoice references, never the active cost until `use-invoice-price`                                                                                                                               |
| `catalog_ingredient`, `catalog_product`                                                                                                                                 | catalog adoption; merge fills a blank target link and bumps the surviving Ingredient                                                                                                                                                            |
| `public_id`                                                                                                                                                             | no writer                                                                                                                                                                                                                                       |

### Resolved overlaps

**Purchase-unit fields.** The `ingredient:<id>:purchase-unit` domain owns them
and `savePurchaseUnit` (`apps/web/lib/ingredients/save-purchase-unit.ts`, the
purchase-unit and price-line dialogs) is the only _form_ surface that writes
them, through `save-ingredient` or the explicit `use-invoice-price` choice.
The same domain owns adding and removing independent invoice-price references
through `link-invoice-line` and `disconnect-invoice-line`. All four lock the
ingredient, bump `edit_version` and echo it; the chrome hands
that version to the form, which saves against it rather than conflicting, and
the commit's `router.refresh()` reloads the pack.

`save-ingredient` therefore takes two half-payloads on an update: the pack
write carries the price and no `name`, the form carries `name`, `category` and
`tags` and no pack. An absent key leaves what is saved alone, so neither can put
the other's stale value back. A create carries both.

Two writes outside that domain reach the same columns.
`set-preferred-supplier-item` re-prices the ingredient off the pack it makes
preferred.
It queues on `ingredient:<id>:preferred-pack` — its dialog opens from the
ingredients table, where no form is mounted to queue against — and bumps
`edit_version` too, so a form open elsewhere is refused rather than overwriting
the new price.

`review-invoice-line` with a `costEntry` runs the supplier-import pipeline
(`apply_invoice_cost_line` -> `apply_supplier_import_entry`). It always records
the invoice line's ingredient and, when remembered, its supplier pack. It may
initialize a new ingredient or update the price of the exact pack already
preferred for that ingredient. A different pack attached to an existing
ingredient is alternate purchase history: invoice input cannot make it
preferred, rename the ingredient, or restate its costing price. Permitted price
writes deliberately do not bump: like the InvoiceLine fields above, they come
from the open invoice screen refreshing itself. Choosing a different active
cost remains an Ingredient-screen action through `use-invoice-price` or
`set-preferred-supplier-item`, both of which bump the purchase-unit version.

| Invoice cost entry                  | Ingredient / supplier identity                                                 | Supplier memory                                         | Ingredient costing result                                                       | Undo result                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| remembered                          | new ingredient, new key                                                        | creates the first preferred pack                        | initializes the ingredient from that pack                                       | removes the pack, price, and otherwise-unused ingredient              |
| remembered                          | existing ingredient, new key                                                   | creates an alternate pack                               | leaves the chosen default and materialized price unchanged                      | removes the alternate pack and clears its supplier-item links         |
| remembered                          | existing ingredient, exact preferred key                                       | updates that pack                                       | records an effective-dated price and rematerializes only when it is newest      | restores the prior pack and price history state                       |
| remembered                          | existing ingredient, exact non-preferred key                                   | updates that alternate pack                             | leaves the chosen default and materialized price unchanged                      | restores the prior alternate-pack state                               |
| one-time (`remember: false`)        | new ingredient                                                                 | creates no supplier pack                                | initializes the new ingredient from the reviewed line                           | removes the price and otherwise-unused ingredient                     |
| one-time (`remember: false`)        | existing ingredient                                                            | creates no supplier pack                                | leaves the chosen default and materialized price unchanged                      | restores the unchanged ingredient snapshot and marks the batch undone |
| Ingredient-screen invoice link      | any selected invoice line, including one another ingredient already references | leaves supplier memory and invoice classification alone | adds an alternate invoice price; active costing is unchanged                    | disconnect removes only this ingredient-to-line relation              |
| Ingredient-screen “Use for costing” | one connected invoice price with a complete measure                            | leaves supplier memory alone                            | explicitly copies that invoice's per-pack price and measure into active costing | later cost changes are normal ingredient price history                |

Automatic invoice-price references carry the `IngredientImport` that created
them and are removed when that import is undone. A reference explicitly added
from the ingredient screen clears that import ownership; it survives undo and
makes an otherwise-new ingredient durable. Replacing an invoice reattaches all
of its primary and secondary price references to replacement lines by scoped
line id; legacy snapshots without ids consume matching item-key occurrences
once each in document order. Newly saved invoice-line ids are included in the
local recovery payload, so restoring a later draft retains those references.
Ingredient merge moves and deduplicates them, and deleting either the invoice
line or ingredient removes only the relations that depend on it.

**Invoice line review state.** `review-invoice-line` writes one line's
`category`, `supplier_item`, `ingredient`, `price_updated` and `needs_review`;
`save-invoice` replaces every line, restating all five from the payload and
recomputing `matched_line_count` / `unresolved_line_count`. Both are reachable
on the same manual invoice, but the review is the open editor's own screen
refreshing itself between saves, so it stayed a plain action: no domain, no
bump, and the fields are aggregate-scoped. Ingredient-screen invoice-price
links never write those columns: one line may be referenced by several
ingredients while its primary invoice classification and supplier mapping stay
unchanged.

**Recipe serving.** Two different servings:
`serving_amount`/`serving_unit` is the portion cost-per-serving divides by and
is **aggregate-owned** — the recipe editor sends it, nothing else writes it.
`nutrition_serving_amount`/`nutrition_serving_unit` is what a label preview
describes and is owned by **`recipe:<id>:serving`** (`set-recipe-nutrition-serving`,
Nutrition tab). `save-recipe` accepts the nutrition pair only in a create
payload (`duplicateRecipe`); an update never carries it, so the domain owns it
exclusively and does not bump.

**Linked sub-recipe titles.** A sub-recipe line stores the recipe id as its
identity and copies the title into `display_name`. When `save-recipe` renames
the child, it updates only parent lines that still equal the old canonical
title and bumps each affected parent's `edit_version`. This makes an editor
already open on a parent conflict instead of writing the stale copied title
back. A deliberately different line name is left alone and remains an
attention state.

## Failure kinds

`apps/web/lib/save-failure.ts`: `SaveFailure = { kind: "validation" | "conflict" |
"request"; message; version? }`, built by `toSaveFailure(x)`.

| Kind         | Source                                   | Effect                                                             |
| ------------ | ---------------------------------------- | ------------------------------------------------------------------ |
| `validation` | client-side, before any request          | stays `draft`, inline `role="alert"`, field focused, no request    |
| `conflict`   | 409 `{code: "stale_write", editVersion}` | state `conflict`, queue paused, draft kept, Reload/Discard offered |
| `request`    | `{error}`, thrown, timeout, deploy skew  | state `error` ("Not saved"), stays dirty, retry allowed            |

Deploy skew is a message rewrite inside `request`, not a fourth kind.

## Local recovery

`apps/web/lib/draft-store.ts`, localStorage only, document editors only.

Key: `fl.draft.v<schema>.<workspaceId>.<userId>.<kind>.<id|new:<draftUuid>>`

A new record generates a UUID and puts it in the URL as `?draft=<uuid>` via
`history.replaceState` on first edit, so two new-recipe tabs never share a slot
and a reload restores the right one. The first successful save drops the param
and moves the slot to the persisted id.

Value: `{ payload, savedAt }`; the schema version is in the key prefix. The
payload is an explicit allowlist per kind — the builders **are** the allowlist,
and nothing outside them reaches storage:

| Kind    | Payload                                                         |
| ------- | --------------------------------------------------------------- |
| recipe  | title, description, items, steps, batchSizes, equivalency, tags |
| menu    | name, period, items                                             |
| invoice | header, lines                                                   |

Throttled 5 s while dirty; cleared on `saved && !dirty`; TTL 7 days; max 20 keys
(oldest evicted). On mount, a draft that differs from the server snapshot raises
a Restore / Discard banner.

Confirmed sign-out calls `clearDraftsForUser(user.id)` in every workspace.
A failed sign-out keeps the drafts and current page and reports the error.

## Navigation

`apps/web/components/navigation-blocker.tsx` holds `isBlocked` for the whole app. Every
exit a person can take from a dirty screen goes through it:

- In-app links use `GuardedLink`, including the ones drawn far from an editor:
  the breadcrumb parent (`ui/page.tsx`), the Primo rail's card and lines, the
  ingredient delete dialog's recipe list, the recipe/menu name cells in the
  tables, and the recipes and ingredients tables' Add buttons.
- A programmatic `router.push` — the ingredients table's row click, row menu and
  mobile card — awaits `confirmNavigation()` and then `allowNavigation()`.
- `beforeunload` prompts whenever the app is dirty, save-on-leave screens
  included: unload cannot wait for a save to finish.
- Back/forward goes through the Navigation API's `navigate` event where the
  browser has one; push and replace are not interceptable there, which is why
  links are guarded individually.

### `router.refresh()` on a dirty editor

A refresh re-renders the same client tree from a fresh server payload, so React
state survives it. Every site calls it through `apps/web/hooks/use-refresh.ts`, which
runs it inside a transition so the control that asked stays pending until the
payload commits (AGENTS.md "Feedback"). The browser acceptance case in
`apps/web/tests/acceptance/refresh-feedback.acceptance.spec.ts` holds an actual refresh
request and checks that the account Save button and dialog wait for it.

| Refresh boundary | Invariant |
| --- | --- |
| Plain async handler or save controller | Await refresh before closing a dialog or announcing completion |
| Async React transition | Launch refresh without awaiting or returning its promise; React joins the pending work without a circular wait |
| Identity and state | Refresh uses the current session; mounted editor drafts survive the new server payload |
| Completion and unmount | Settle callers after the payload commits, or when their component unmounts |
| Failure | Failed writes keep their error and retry path; refresh does not retry a write |

| Site                                                | Outcome                                  |
| --------------------------------------------------- | ---------------------------------------- |
| recipe comments (`recipe-editor.tsx`)               | edits and `Draft` survive — refresh kept |
| ingredient chrome actions (`ingredient-chrome.tsx`) | edits survive — refresh kept             |
| invoice line review (`invoice-editor.tsx`)          | edits survive — refresh kept             |
| invoice post-save (`invoice-editor.tsx`)            | edits survive — refresh kept             |

Nothing was replaced with a local state update. The one case still to avoid is
a refresh on the recipe create screen after the `history.replaceState` URL swap;
no site does that today.

Primo transcript writes are asynchronous side effects of a conversation turn:
the user message is written before inference and the assistant response when
the stream finishes. They never participate in a Save pill. Composer drafts use a shared per-user,
per-conversation store across Home and the rail; text, mention bindings and
attachment summaries are persisted together. The same provider owns file
requests, so changing surfaces does not cancel them and completions update the
original conversation only. Uploading/reading/removing files cannot send;
interrupted uploads restore as errors requiring reattachment. File admission
reserves against the latest draft synchronously and cancellation removes the
entry before a late response can settle. A new draft can accept files while
Primo answers. Sign-out aborts requests and removes these local drafts. Response feedback is a separate write domain and transcript upserts
do not overwrite it.

## How to add a save surface

1. **Pick the model.** A document with autosave or a manual Save that must
   survive navigation → `useDocumentSave`. A form or dialog with fields and a
   Save button → `useFormSave` (plus `useDirtyDialog` in a dialog); a form that
   writes a command rather than a record — an invite, a key, a link — passes
   `saved: false`, so no submit is ever skipped as clean. A control that
   commits on change → `useCommit`.
2. **Name the version scope.** Add the field to the write-ownership matrix
   above, as either the aggregate or one conflict domain. If a commit touches
   data an aggregate save also writes, it bumps `edit_version` and returns it;
   otherwise it does not bump. A field with two writers and no entry here is a
   bug.
3. **Register with the chrome** through `useEditChrome`: `dirty` →
   `setIsBlocked`, `saveState`, `saveRef`, `savePending`. The chrome renders
   `<SaveStatus>` and `<SaveButton>`; a surface never draws its own pill,
   disables Save for invalid input, or calls `requestSubmit()`.
4. **Cmd/Ctrl+S**: `useEditChrome` mounts the page's one `useSaveShortcut`; a
   dialog puts `dialogSaveShortcut(submit)` on its content, which stops the
   event before the screen behind it sees it.
5. **Backend**, if a new action: `expectedEditVersion` on an aggregate save,
   `check_and_bump` inside the transaction after `select_for_update()`, and
   `editVersion` in the echo. Contract changes move together — handler,
   `EXPECTED_ACTIONS`, `docs/CONTRACT.md`, `test_contract_envelopes.py`,
   `apps/web/lib/backend/types.ts`, `apps/web/tests/action-auth-pins.test.ts` — in one commit.
6. **Mandatory tests**: registers with the chrome; pill and button reflect
   controller state; one success path; one failure path. A document editor adds
   its route's navigation test (every exit reachable from the dirty editor is
   guarded) and its draft write/clear/restore test. A dialog adds "stays open on
   failure" and the dirty-dismissal confirm. A commit adds its domain's
   serialisation and revert-to-`confirmed` case. The six end-to-end paths —
   failed request, conflict, save-on-leave, dirty confirm, restore banner,
   dialog held open — are pinned once in
   `apps/web/tests/acceptance/save-system.acceptance.spec.ts`.
