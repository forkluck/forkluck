# Sales interpretation: the variant model

How provider sales become product, recipe, and reporting numbers. The domain
vocabulary is in `apps/api/forkluck/domains/sales/CONTEXT.md`.

## Hard rules

- Sales imports, lines, modifier occurrences, provider fingerprints,
  watermarks, and financial amounts are the audited ledger. Deleting a product
  or variant only unlinks stored source facts; it never deletes them.
- Catalog refresh never creates an ignore or a recipe, and never creates a
  product or a variant except through product matching, below. A merchant must
  explicitly save every other variant.
- Product matching is the single exception, and it is deliberately narrow. When
  `productMatching` is on, a catalog refresh links a pair whose normalized SKU
  names exactly one item on each of two channels, across every provider account
  on those channels, and is claimed by no existing variant or attached line.
  Anything less certain — a duplicate, a single-sided SKU, an identity whose
  own lines disagree on SKU, an ignored or unconnected identity — is left for
  the merchant. A SKU a product declares on its own page (`SalesProductSku`)
  is the other source: a sync, a product save, or the setting turning on links
  any pending identity carrying it, and the variant's `quantityMultiplier` is
  the SKU row's, so a pack SKU declared as 6 counts each sale as six without
  the merchant confirming it again. Such links carry `link_source = auto_sku`,
  are withdrawn if the setting is turned off, and are promoted to `manual` by
  any merchant edit,
  after which they are never withdrawn automatically. A wrong link merges two
  products' revenue, so the predicate refuses whenever it is unsure.
- Provider identity is `user + channel + providerAccountId + matchKey`.
  `matchKey` alone is never an authorization boundary.
- A provider connection is an account namespace. A reconnect to a different
  Square merchant or Shopify shop cannot reuse the former account's catalog,
  variant, ignore, or sales decisions.
- Revenue belongs to the original financial line exactly once. Attributed
  revenue never exceeds the source line; a variant that claims less than the
  whole leaves the remainder unattributed, reaching no product. Modifier
  occurrences contribute consumption but never additional revenue.
- There is one interpretation routine for all downstream product, recipe, and
  sales views. No caller may implement a second kind switch; recipes consume
  the same interpreted product contributions used by reporting.

## Provider identities

| Provider | Item catalog and sales mapping key | Financial deduplication key |
| --- | --- | --- |
| Square | `square:item:<CatalogItemVariation.id>` | order id + line uid |
| Shopify | `shopify:item:<ProductVariant GID>` | Sale GID |
| No provider object id | stable `sku:` or exact `name:` form | source fingerprint |

Square item catalog acquisition pages `ITEM` and `CATEGORY` records; variations
are the rows the merchant links. Shopify acquisition pages the top-level
`productVariants` connection, including variants of draft and archived
products. Adapters retain the complete provider snapshot before marking a
previous catalog row inactive; a failed or timed-out page keeps the previous
active snapshot.

Provider sales and catalog records share the item-object match-key helper, so a
catalog-only variation and a subsequently sold variation become one review
identity.

## Persisted model

**Product.** `SalesProduct` is the merchant's own product: a name, active
state, and recipe links. Deleting it cascades its direct variants; its
`SalesLine.product` and `SalesLine.variant` references are `SET_NULL`, so the
financial ledger stays intact. A product used as a component of another product
is protected and cannot be deleted until it is removed from every bundle that
contains it.

**Bundle.** A bundle is a product whose components include other products. It
is a product like any other: its own name, price, SKU, variants and sales, and
its components say how many of each product one of it contains. Bundles nest.

**Variant.** `SalesProductVariant` is the merchant-approved interpretation of
one external identity. Provider identity fields are immutable after save;
interpretation fields are editable, and historical lines reinterpret from
their stored identity.

Every variant names one product and a `quantityMultiplier` — positive, at most
1,000,000 — so a line of quantity `Q` sells `Q × M` of that product. A box is
not a kind of variant: it is a product whose components are products, reached
through the same single product reference.

A variant also carries `attribution_percent`: the share of the line's money
that belongs to the variant's products. Null is the default and reads as 100,
so a catalog nobody has visited still reports every figure correctly. A variant
sells what the merchant tracks alongside what they do not — a "tea and
biscuits" variant names the biscuits and says nothing about the tea — and the
remainder is unattributed rather than inflating the named products. It scales
money only: units and recipe consumption are physical facts of the sale and
never change with it.

Database constraints cover the row-local shape: a positive multiplier and an
attribution percent within 0–100. A product component names exactly one recipe,
ingredient or product. An ingredient component requires a unit; a product
component carries none, is unique per `(product, component_product)`, is never
the product itself, and the save action refuses a cycle at any depth; a recipe
component's unit is optional, blank meaning whole batches per sold product and
a unit meaning that much of the recipe batch. `SalesCatalogItem` keeps provider catalog metadata (`sku`, names, category,
active state, last-seen timestamp) at the same user/channel/account/match-key
scope.

**Modifiers.** A modifier occurrence is a selected option attached to a
financial line: source identity and quantity, no financial fields. Modifier
mappings are provider-account-global identities and can be direct only. Mapped occurrences add their calculated consumption to the
parent line's contribution; unmapped occurrences remain pending on the
Modifiers page without blocking mapped parent or modifier contributions. Their
revenue is always zero.

## Interpretation and accounting

For each tracked financial line, interpretation returns product contributions:

1. Every kind first takes its attributed share of each financial amount, which
   is the whole amount unless the merchant set a percent below 100.
2. Its direct variant contributes the listed quantity, putting every
   attributed financial field on its one product.
3. If that product is a bundle, an expanded view moves its money to the
   products inside it and keeps its units. The share is each member's relative
   standalone value: `quantity × sell price` when every member of that level is
   priced, otherwise `quantity × unit cost` when every one is costed, otherwise
   `quantity`. The rung is chosen for the whole level, never per member — a
   price weight and a count weight are different magnitudes. All five
   attributed amounts — gross, discount, net, tax, and refund magnitude —
   divide with `allocate_cents_by_weight` over those weights, walking members
   in `component_product_id` order, and the member cents sum exactly to the
   attributed cents. A member that is itself a bundle keeps its units, hands
   its share on, and splits again by its own level's ladder. Setting a
   member's price changes how past bundle revenue is attributed; as-sold
   figures never move.
4. Each mapped modifier occurrence evaluates the same direct rule
   using `line.quantity × occurrence.quantity`, with zero for every financial
   amount.

A refund uses negative parent quantity and signed gross, discount, net, and
tax. Its `refund_cents` is the non-negative magnitude of reversed net sales
excluding tax, and never changes net revenue. It remains in the same
tracked/pending/ignored state as a sale. `SalesLine.variant_id` is the
authority for tracked state. A pending identity's money counts only in the
pending scope, an ignored identity's only in the ignored scope.

**As sold and including bundles.** A product's *as-sold* figures come from the
variant attached to the line; they are immutable and reconcile to the channel.
*Including bundles* adds what reached the product inside a box and is
recomputed from the current catalog. Any one table shows one view; a bundle's
row in an expanded view carries its units, zero money, `sharedToMembers`, and
`asSoldNetSalesCents`, so the money column still sums to net revenue.

## Catalog and review

Catalog ingestion runs as optional work in the existing POS sync pass, under
its own deadline budget. The sync receipt reports `catalogItemCount`.

The Catalog page's review payload is the union of pending stored item
identities with their sales metrics, and active catalog identities for
currently connected provider accounts that are neither listed nor ignored
(`lineCount = 0`, `netSalesCents = 0`, `lastSoldAt = null`). The union is
deduplicated at the full provider identity scope. Search operates before
display capping; the 200-row cap applies per channel/account/category group,
and category rollups represent all matching rows. The default "Needs linking"
view filters to rows with sales; "All" additionally exposes catalog-only rows.

Ignores are explicit merchant choices. An ignore from the needs-linking view
covers sold pending identities; one from All may also cover catalog-only
identities in the selected account/category scope.

## Lifecycle

- Saving a variant attaches matching pending source lines, removes a matching
  ignore, and reinterprets affected history.
- Editing multiplier, attribution, product, or a product's components is
  atomic.
- Removing a variant unlinks its source lines. Deleting a product that another
  product contains is refused, naming the bundles it sits in.
- Undoing an import removes only that import's source lines and modifier
  occurrences. Catalog rows and manually approved variants survive.
- Reinterpretation is repeatable and affects only derived attribution, never
  source quantities or financial facts.
- Disconnect hides the account's catalog. Reconnect to the same account may
  reuse its scoped rows; another account may not.

## Test matrix

The backend matrix covers each kind for sales and refunds, direct and mapped
modifier contributions, create/edit/reinterpret/delete/undo lifecycles,
bundle member protection, tenant/account scoping, catalog upsert and
complete-fetch deactivation, catalog/sale identity collapse, provider
reconnect, partial catalog failure, and positive and negative penny
reconciliation, including totals whose cents do not divide evenly. Because
every read path now has two views, the oracles compare them: for one fixture
the expanded total, the as-sold total, and the attributed ledger total must
agree, at each level of a nested bundle. Frontend validation covers the box
shape: 2–50 unique products with whole-number counts.
