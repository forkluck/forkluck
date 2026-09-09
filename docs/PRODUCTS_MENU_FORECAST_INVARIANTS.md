# Products and Menu forecast invariant matrix

This is the maintained cross-layer matrix for Products Hub and menu-scoped
demand forecast changes. A change that alters one row must update the owning
boundary and its parity tests before the change is considered complete.

| Area | Invariant | Owning boundary / required check |
| --- | --- | --- |
| Identity | A public product reference is stable, tenant-scoped, and distinct from the internal product UUID. | Products read model and contract schemas; detail/row fixtures must reject cross-tenant lookup. |
| Provider vs ledger | `square` and `shopify` are provider channels; manual entry is a ledger source with no provider account/object identity. Provider identity survives import. | Sales import/manual-entry boundary; contract and sync tests. |
| Repeated identity | Repeated SKU/name text remains repeated source rows. Matching must not deduplicate by identity text or collapse source position. | Sales matcher and manual ledger boundary; repeated-SKU interpretation tests. |
| Matching precedence | Provider object identity precedes approved variant, exact SKU, Shopify product+variant, and then name. Suggestions never silently attach a sale; disabled suggestion mode remains deterministic. | `interpret_line`/matcher; interpretation parity tests. |
| Source lifecycle | Ledger facts retain source channel, import, timezone, currency, and source identity. Variant/product removal unlinks or deactivates mapping without deleting historical facts. | Sales persistence and sync ownership; import/undo/deactivation tests. |
| Import and undo | Undo targets only the latest active provider import under lock/ownership rules. Manual monthly imports are hidden from history/latest and generic undo refuses them; projections are never undo targets. | Import history/latest/undo seams; locking and stale-recovery tests. |
| Interpretation | Variant multipliers, bundle composition, and mapped modifiers affect physical units according to canonical interpretation. A sale of a bundle is one bundle unit and each member's count, recursively; sales-accounting units remain per product. Compatibility production totals are never a sales total; the page leads with per-product demand and per-recipe output. | Sales interpretation; bundle/modifier/refund tests. |
| Attribution | Net money is allocated as a view of the source sale. Attribution never creates extra revenue; an unallocated remainder stays unattributed. An expanded view moves a bundle's money to its members by relative standalone value (price → cost → count, chosen per bundle level), splitting all five money fields with the same integer, sign-aware, conserving allocation, recursively; the bundle's own row then carries zero money. Any one table shows one view. | Sales attribution and overview; view-parity oracles asserting expanded total = as-sold total = attributed ledger total. |
| Returns | Refund/return quantity and net amount reverse the corresponding physical and financial signs without inventing a new positive sale. | Line interpretation and daily rollup; return parity tests. |
| Daily consumption | `daily_product_consumption_rows` uses workspace-local calendar dates and canonical interpreted physical quantities, not revenue or inventory writes. | Daily rollup read model; timezone, currency, and modifier tests. |
| Menu membership | Forecast candidates are products belonging to the selected menu through menu membership; tenant-wide catalog products are excluded. | Menu overview/query boundary; membership scope tests. |
| Product composition | Forecast expansion uses the product's current linked recipe/material composition at read time; historical sales facts are unchanged. A recipe component with a blank unit is whole batches per sold product. A recipe component with a unit is that much of the recipe batch, resolved by the nested-line rule (`share_of_batch`) against the recipe's yield and equivalency; `portion` and `serving` fall back to the recipe's saved portion when no equivalency counts them. Cost and forecast share one resolver (`_component_batches`), so a family the yield does not state is an `unresolved-yield` issue in both, never a zero or a whole batch. | Recipe/material expansion boundary; composition-change, measured-component and unresolved-family tests in `test_product_identity_slice.py` and `test_menu_forecast.py`. |
| Bundle composition | A component may be another product, counted in whole members and never carrying a unit. A bundle is expanded exactly once, by the line interpreter; `_product_material_demand` skips product components, so a member's materials are counted once per member unit and the bundle's own materials once per bundle unit. A composition may not reach itself. | `domains/sales/bundles.py` and product cost; nested-bundle forecast, no-double-count and cycle tests. |
| Menu components (non-goal) | `MenuItemComponent` has no product target and gets none. A menu row reaches a bundle through `MenuItem.product`, which already expands; a second product graph on a per-row costing snapshot would need its own cycle, tenant and uniqueness guards with no consumer. | Menu worksheet boundary; revisit only with a surface that needs it. |
| Physical expansion | One shared model-agnostic expansion path applies line quantity, variant/member multipliers, nested recipes/materials, UOM conversion, yield, and efficiency. | Shared expansion owner; Python/TypeScript parity tests, no adapter-specific math. |
| Health and cost | UOM/yield/unresolved/cycle health is explicit. Cost efficiency and after-cooking/nutrition efficiency remain distinct semantics. | Recipe health/cost boundary; unresolved/cycle/yield tests. |
| Forecast basis | A forecast uses the selected menu and the eight prior matching weekdays in workspace timezone, each week back weighted at 80% of the one after it, with samples from before the product existed dropped; it is not an all-product or undifferentiated aggregate. Both typical and busy totals are published, busy pooling variance across the horizon. Dated planned quantities allocate the chosen total by weekday profile and conserve thousandths; they are not daily busy levels. A product that sold in both of last year's 364-day-shifted windows is scaled by the damped, clamped ratio between them, live and in every replayed backtest week alike. | Forecast query/read model; weekday scope, weighting, existence-anchor and timezone tests. |
| Projection lifecycle | Projected demand is read-time and non-persisted: it creates no sale, import, sync run, variant, or undo record. Projected revenue, the chart series and the backtest are read-time too, computed from the one ledger read that serves the projection. | Forecast endpoint/service; read-only contract and single-read query-count tests. |
| Contract shape | Product rows/detail expose public identity (`publicId`, `editVersion`, `sku`, `description`, `sellPriceCents`, `category`); detail alone adds nullable cost/margin fields, `currencyCode`, and `incompleteManualRevenue`. The forecast publishes `basis` with dated comparison weeks and an unscaled weekly level, `coverage`, `production`, dated `days`, `revenue`, `materialCost`, menu-member unit `series` and `backtest`, per-product and per-recipe days, requirements and `unresolved`; forecast money prices menu members only, at current menu prices, and is projected demand rather than net sales. Material rows publish fractional `packs` and `costCents` from the same pack size and pack price product cost charges, plus the preferred supplier's own pack wording in `supplierPack` (one read for the whole list, pinned); rounding up to whole packs is a display rule, never the contract's. No alternate variant-by-channel/cost-summary/warning envelope is allowed. | `docs/CONTRACT.md`, backend contract tests, frontend schemas/types. |
| Query behavior | Tenant-wide snapshots pin query counts and bulk writes do not grow with input; expansion must avoid N+1 reads. | Snapshot/read-model tests and query-count assertions. |
| Layering | Provider adapters own provider translation/sync; Sales owns interpretation and ledger lifecycle; Recipes/Materials own health/UOM/yield; shared expansion owns model-agnostic physical math. | `lint-imports` plus import-linter boundary review. |
| Security and locale | Every read/write is tenant-scoped; local business dates use the workspace timezone; currency remains attached to the source ledger fact. | API authorization, timezone, and currency contract tests. |

## Existing test anchors

The matrix is grounded by the current seams in:

- `apps/api/forkluck/test_sales_interpretation.py`
- `apps/api/forkluck/test_daily_sales_rollup.py`
- `apps/api/forkluck/test_menu_overview_queries.py`
- `apps/api/forkluck/test_pos_sync.py`
- `apps/api/forkluck/test_pos_sync_jobs.py`
- `apps/api/forkluck/test_undo_locking.py`
- `apps/api/forkluck/test_product_catalog_rewrite.py`
- `apps/api/forkluck/test_recipe_normalized.py`
- `apps/api/forkluck/test_recipe_nutrition.py`
- `apps/api/forkluck/test_ingredient_measures.py`
- `apps/api/forkluck/test_preparation_yields.py`

Future Products/forecast changes must add parity cases for public identity,
manual/repeated-SKU rows, menu membership, weekday scope, timezone,
Product-composition expansion, unresolved health, and non-persistence rather
than only adding a happy-path endpoint test.


## Production-plan boundaries

| Boundary | Invariant | Required verification |
| --- | --- | --- |
| Syntax | 7/30-day horizons and typical/busy plans use one payload. Web `view=day` is presentation only; all view links preserve the other parameters and track pending navigation. | Strict schemas, page types, control tests, seeded menu acceptance. |
| Identity and scope | Production totals sum displayed product rows, including bundle/modifier demand. Menu-level basis, series and accuracy compare menu members only, including unpriced members. Each product explanation follows its own included-demand scope, excluding out-of-menu modifiers. Neither restates as-sold accounting. | Bundle/unpriced cross-product tests; chart and basis labels explicitly name their scope. |
| Precedence | Product-specific seasonal factors remain authoritative; `level.seasonalFactor` describes their weighted impact and is never applied again. Last-year blocks shift 364 days; partial horizon blocks stay partial. | Weekly-level and horizon-alignment tests at 7 and 30 days. |
| Allocation | Product days sum to their chosen total, recipe days sum to batches, and top-level days sum product days. Thousandths are conserved even for small quantities; positive totals with zero typical profiles spread evenly. | Both plans and horizons, shared recipes, tiny/zero-profile tests, daily CSV column sums. |
| Lifecycle | Create, update, merge, import/undo and deletion continue through existing membership, ledger and composition reads. No new persisted relation or unresolved state exists. Day requirements use the existing batch/UOM resolver; material requirements and unresolved paths are unchanged. | Existing ownership, bundle/modifier, UOM/yield, refund, undo, and query-count tests. |
| Downstream | Price changes affect the money caption and existing money fields only. Unpriced products still receive production rows, charts and accuracy. Cost gaps remain visible; shopping requirements stay whole-horizon. | Unpriced member tests, component UI tests, strict Python/TypeScript envelope parity. |
| Presentation | The title is Production forecast; expected product demand and physical prep output lead, with recipe equivalents secondary and an explicit batch fallback for missing yields; one caption summarizes revenue and ingredient cost. Product tables have no price/sales columns. Week/day views use the same plan; 30-day schedules group the same daily rows into basis blocks. | Component tests for title, caption, per-product explanations, physical prep units/fallback, URLs, schedule grouping and export. |
| Explanation | Recent horizon estimate + signed seasonal adjustment = expected demand; expected demand + separate Busy allowance = Busy. All use the exact live projection and serialized thousandths. History remains recorded consumption with explicit dates/years; a missing record does not prove zero demand. Short-history products never gain invented seasonal support. | Both horizons/plans; rise/fall/flat/clamped/missing comparisons, returns, new/unsold products, bundle/modifier scope, strict contract parity and unchanged query pins. |

## Offline forecast comparison

| Boundary | Invariant | Check |
| --- | --- | --- |
| Syntax and ownership | The operator command accepts a menu public id or UUID, optionally restricted by owner email. Unknown, malformed, and owner-mismatched references fail. The shared loader refuses a foreign menu before reading. | `test_forecast_backtest` command and loader tests. |
| Live parity | The `current` candidate is `project_product` itself. Loader extraction preserves live query order/count and defaults; candidate parameters never change the live basis. | Existing forecast query pins; live/replay parity and default decay tests. |
| Comparable origins | Every candidate scores identical completed, nonzero menu origins with eight weeks of supported history. Future observations cannot enter training, and overlapping horizons cannot leak not-yet-completed residuals. | Short history, 30-day completion, and conformal replay tests. |
| Decision and states | Aggregate unit WAPE is diagnostic, with median product WAPE guarding cancellation; zero-net-actual products have no WAPE. Busy coverage and signed over-production use the same origins. A one-horizon result cannot authorize promotion. | Score, empty-history, and threshold tests. |
| Lifecycle | Evaluation is pure after the one shared input load. Create, edit, merge, import/undo, and delete continue to affect the canonical read model; no new persisted relation or review state exists. | Command rejects all SQL writes in tests; existing ledger and forecast suites. |
