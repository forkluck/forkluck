# Sales: ubiquitous language

The words this domain uses, and the words it refuses. Code, payload keys, UI
copy, and commit messages should all use the term on the left; the "Avoid"
line names synonyms that have been tried and rejected because they blur a
distinction this domain depends on.

The reasoning behind these terms is in `docs/SALES_INTERPRETATION_SPEC.md`. This file is the vocabulary only.

## The sale

**Channel** — the source classification of a stored sales fact. A channel is
either a provider channel (`square` or `shopify`) or the `manual` ledger
channel. It is stored on every import, line, variant, and ignore row.
*Avoid:* "platform", "store".

**Provider channel** — an external sales system (`square` or `shopify`) that
owns provider accounts, catalog identities, variants, and sync jobs. Provider
identity is preserved on imported rows and is never replaced by a generic
ledger label.
*Avoid:* "ledger channel", "source type".

**Ledger channel** — the channel classification of a stored financial fact.
Provider channels are ledger channels; `manual` is the ledger channel for
user-entered facts and has no provider account or provider object identity.
*Avoid:* "provider", "integration".

**Import** — one audited batch of sales, written by a provider sync or a
manual-ledger entry operation. It carries its own timezone and currency, and
can be undone while it is the latest active provider batch; a manual monthly
import is hidden from import history/latest and the generic undo action refuses
it. A manual import never invents provider IDs.
*Avoid:* "upload" (nothing is uploaded any more), "batch job".

**Manual entry** — a user-authored ledger fact with a local business date and
tenant currency/timezone. Repeated SKU/name text represents repeated source
rows, not one deduplicated sale; source position or entry identity keeps those
rows distinct.
*Avoid:* "provider sale", "correction-by-reimport".

**Financial line** — the sale or refund line that owns signed gross, discount,
net sales, and tax plus a non-negative refund magnitude. A refund is a
negative parent quantity and negative money, not a separate kind of record;
its refund magnitude describes reversed net sales and never changes revenue.
*Avoid:* "order" (an order has many lines), "transaction", "sales row".

**Modifier occurrence** — a modifier chosen on a financial line. It has an
identity and a quantity and is a source fact; it never owns revenue.
*Avoid:* "modifier line", "child line", "add-on sale" — all three imply the
occurrence carries money of its own.

## Identity and mapping

**External identity** — a thing the provider names: an item variation, a
modifier, a SKU, or an approved name/variant pair.
*Avoid:* "SKU" as a stand-in for all of them; a SKU is one identity format.

**Match key** — the stable string an external identity resolves to, preferring
provider object IDs (`square:item:<id>`, `square:modifier:<parent>:<id>`) and
falling back to `sku:` and `name:` forms.
*Avoid:* "hash", "slug", "fingerprint" (a fingerprint is the per-line dedupe
key, a different thing).

**Provider account** — the Square merchant or Shopify shop that owns an
external identity. Channel alone is not a namespace: reconnecting another
merchant on the same channel must not inherit approvals, ignores, catalogs,
watermarks, or deduplication history.
*Avoid:* "connection" (tokens and connection rows can be replaced while the
provider account remains the same).

**Provider record** — the provider's immutable identity for one financial
line: Shopify Sale GID or Square order id plus line uid. Used for API
deduplication; never used as a product mapping.
The id names the provider's latest snapshot: changed money, status, catalog,
or modifier facts replace the stored snapshot while a distinct id remains a
distinct financial line.
*Avoid:* "line id" (Shopify line-item ids are not Sale ids, and Square line
uids are only unique inside an order).

**Variant** (`SalesProductVariant`) — the merchant's approved interpretation of
one external identity: one sellable SKU on one channel. It names one product,
which may be a Bundle. Saved provider identity is immutable; interpretation
settings may be edited.
*Avoid:* "alias", "mapping rule", "SKU row", "link", and "listing" (the retired
name).

**External field** — every `external_*` field holds the provider's own string,
never ours. `external_variant_title` (on `SalesProductVariant`, `SalesLine`,
`SalesCatalogItem`, and `SalesSkuIgnore`) is the POS variation title (Square
`item_variation_data.name`, Shopify `ProductVariant.title`) — it is not a
Variant.
*Avoid:* reading `external_variant_title` as a variant reference; the variant
FK is `variant_id`.

## The menu side

**Product** (`SalesProduct`) — the merchant's own menu item, the thing recipes
and costs hang from. A product has no sales-pack type; different external
variants may interpret the same product differently.
*Avoid:* "item" unqualified — the provider's item is an external identity, and
confusing the two is the mistake this vocabulary exists to prevent.

**Menu membership** — the relationship between a product and a selected menu,
represented by a menu item. Membership defines which products are eligible for
menu-scoped planning; it does not alter historical sales facts.
*Avoid:* "variant", "product ownership".

**Menu item**: one row of a menu-engineering worksheet, a link to one recipe
or one product, or a plain named row awaiting a link; never a composition of
its own. A linked row reads its name, category and food cost through the link;
an unlinked row keeps its typed name and is neither categorized nor costed.
Only the sell price and, for a recipe row, the units sold belong to the row.
*Avoid:* "menu components", "menu composition".

**Product composition** — the current recipes and materials linked to a
product, with decimal quantities. It is the product-level physical composition
used for planning; UOM conversion, yield, and efficiency semantics apply when
the composition is expanded. It is not a historical snapshot and does not
rewrite a ledger fact.
*Avoid:* "base composition", "BOM", "ingredients list", "formula",
"historical recipe".

**Multiplier** — units of the mapped product consumed per one external
identity. A six-pack variant has multiplier 6; a slice of a whole cake has
0.125. Never inferred from a name; the merchant confirms it.
*Avoid:* "pack size" (that is a purchasing concept), "quantity", "ratio".

**Pack SKU** (`SalesProductSku` with a multiplier above 1) — a further SKU the
product declares on its own page: the same product sold in a count, `102201`
being six of what `102200` is one of, at the product's own cost times the
count. It is not a bundle (nothing else is inside) and not a variant (it is a
declaration, which matching turns into variants as identities arrive). The
product's own SKU is the x1 row of the same table.
*Avoid:* "alias" (a pack SKU counts differently, an alias would not), "case",
"multipack product".

**Recipe component** — a product component that names a recipe. With no unit
its quantity is whole batches per sold product. With a unit it is that much of
the recipe batch: a 500 g tub of a 20 kg batch is one fortieth, for cost and
for the kitchen's batch count alike, resolved by the same rule a recipe line
nested in another recipe uses. A family the recipe's yield does not state is
unresolved, never a guess.
*Avoid:* "portion of a recipe" for the blank-unit case (that one is batches).

**Bundle** — a product whose components include other products. It is a product
like any other: its own name, price, SKU, variants, sales and cost, which is
its members' costs plus whatever it adds itself. Bundles nest; a composition
may not reach itself.
*Avoid:* "assorted", "variety pack", "kit", "fixed pack" — those names smuggle
provider presentation into what is simply a product.

**As sold** — a product's own units and money, from the variant attached to
the line. Immutable and reconcilable to the channel.
*Avoid:* "gross", "raw" — neither says whose sale it was.

**Including bundles** — a product's units and money including what reached it
inside a bundle. Recomputed from the current catalog, so it moves when
composition or member prices move.
*Avoid:* "total", "combined" — a bundle's row is not added to its members'.

**Attribution percent** — the share of a financial line's money that belongs
to the variant's product, because a variant also sells what the merchant does
not track. Null is the default and reads as the whole line. It scales money
only; consumption is a physical fact of the sale.
*Avoid:* "yield" (a recipe's yield is the batch it makes, an unrelated
number), "discount" (nothing is taken off the sale), "split" (that is the
bundle division, which happens after this).

**Unattributed** — the part of a line's money no product receives, because the
variant claims less than the whole. It is a reported remainder, never a
product figure and never a second sale.
*Avoid:* "missing revenue", "unallocated" (allocation is the bundle split).

## Planning language

**Daily consumption** — physical quantity for a workspace-local calendar day
after line interpretation, variant multipliers, bundle expansion, mapped
modifiers, and product-composition expansion. Revenue attribution is separate;
refunds reverse physical consumption.
*Avoid:* "daily revenue", "inventory decrement".

**Forecast basis** — the selected menu's product membership and the eight prior
matching weekdays in the workspace timezone, each week back counted at 80% of
the one after it, starting when the product existed. It excludes non-members
and is not an undifferentiated aggregate.
*Avoid:* "forecast window", "tenant catalog", "moving average".

**Seasonal adjustment** — the single damped factor a product's projection
is multiplied by, taken from last year's own numbers: the horizon-aligned days
over the eight history-aligned weeks, both shifted back 364 days so weekdays
match. Half the deviation carries over, clamped to 0.5–2, and a window that
sold nothing leaves the factor at one. It is one ratio between two windows of
the same ledger, not a fitted curve or a trend line.
*Avoid:* "seasonality model", "year-over-year growth".

**Plan** — which of the two published levels a forecast read expands: typical
(the weighted weekday mean) or busy (typical plus 1.28 pooled standard
deviations over the whole horizon). It is a request parameter, not a stored
setting or a model choice.
*Avoid:* "scenario", "confidence interval", "P90 per day".

**Projected revenue** — the one caption line of projected menu-member units at current menu prices. It
is planning money, not net sales: it is never allocated, banked, or compared
with the ledger's revenue.
*Avoid:* "forecast sales", "expected revenue" (attribution language).

**Projected demand** — a read-time, non-persisted planning estimate derived
from daily consumption in the forecast basis and current composition. It is
not a sale, import, sync result, or undo target.
*Avoid:* "forecast fact", "committed demand".

**Production forecast** — expected demand by product and the recipe output it
requires, before subtracting stock or food already prepared. Navigation stays
Forecast. Prep quantities lead with litres, kilograms or pieces; recipe
multiples are secondary, with batches as an explicit fallback for missing yield.
Whole-horizon materials remain a shopping requirement.
*Avoid:* "units sold", "revenue forecast".

**Day view** — the selected horizon plan distributed by each product's weekday
pattern, with recipe batches on the same dates. A 30-day view groups those
dates into the basis's week blocks; the export retains every day.
*Avoid:* "daily busy level", "daily confidence".

**Why this quantity?** — one product's recent demand estimate, signed seasonal
change, resulting expected demand, and separate Busy allowance when selected.
View sales history expands that product's eight recent weeks, the eight weeks
preceding last year's matching period, and that period itself, all explicitly
dated. These are recorded consumption quantities, never predictions. Missing
records are not proof of zero demand. Included products retain the same scope
as their forecast rows. Menu-level basis weeks remain API compatibility fields;
the chart and accuracy use menu members only, without requiring prices.
*Avoid:* "forecast sales", "year-over-year growth".

**Level** — about how many menu items the recent weekday pattern makes in a
week before the seasonal adjustment, recent weeks counting more. The overall
seasonal factor describes the weighted change across members; each product
still follows its own factor.
*Avoid:* "moving average", "trend line".

## Interpretation

**Interpretation** — reading stored facts (financial line, modifier
occurrences, variant multiplier, product composition) into product
contributions. It is derived, repeatable, and never stored as source truth.
*Avoid:* "calculation", "explosion".

**Consumption quantity** — target product units consumed by a sale after line
quantity, modifier quantity, and multiplier are applied.
*Avoid:* "usage", "units sold" — a bundle's contents are consumed, not sold.

**Reinterpretation** — replaying interpretation over stored history after a
mapping changes. Idempotent; a receipt reports what moved.
*Avoid:* "backfill", "recalculation", "migration".

**Attribution** — the product view of a financial line. A variant gives its
attributed share to its product; a bundle hands that share on to the products
inside it, by relative standalone value, in exact deterministic amounts.
Modifier contributions receive zero revenue, so attributed product revenue
never exceeds the source ledger, and equals it wherever every variant claims
the whole sale.
*Avoid:* "modifier revenue", "additional sales".

## Review states

**Tracked** — the identity has a variant, so its sales reach reporting.
*Avoid:* "matched" for the end state; matching is the act, tracked is the
state.

**Pending** — stored, valid, and undecided. Waits in review; its money is
counted in the pending scope, not in tracked totals.
*Avoid:* "unmatched" (that describes one line, not the identity's state),
"failed", "error".

**Ignored** — an explicit merchant decision to keep the identity out of
reporting. The sales stay stored so unignoring recovers the history.
*Avoid:* "deleted", "excluded", "hidden".

**Skipped** — reserved for malformed or unsupported provider records. An
unmapped record is never skipped; it is pending.
*Avoid:* using "skipped" for anything a merchant could fix by mapping it.

**Undo** — reversing the latest active import, including the ignore rows that
import created, restoring the prior state.
*Avoid:* "rollback", "delete import".
