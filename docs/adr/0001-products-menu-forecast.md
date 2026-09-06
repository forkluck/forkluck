# Menu-scoped forecast uses read-time Product composition

_Status: accepted_

Products Hub and the menu-scoped demand forecast cross Sales, Menus, Recipes,
and Materials. We derive `daily consumption` from canonical sales
interpretation and expand each selected menu product through its Product
composition at read time; forecast output is non-persisted. The forecast basis
is only selected menu membership and the prior matching weekdays in the
workspace timezone. Manual ledger rows share sales interpretation but are not
provider records, and duplicate identity text stays as repeated source facts.

The expansion boundary is a shared, model-agnostic physical-expansion
contract: Sales supplies interpreted product quantities; Recipes/Materials
supply UOM, yield, and efficiency semantics; adapters do not reimplement the
math. Revenue attribution remains allocation of the source sale and never
creates additional consumption or revenue.

## Consequences

- Product-composition changes can change a new forecast read without restating
  the historical ledger.
- Unresolved UOMs, yields, efficiencies, and cycles remain explicit health
  states; they must not silently become zero demand.
- Sync, import history, and undo operate on ledger facts only. A projection is
  not an import and cannot be undone.
- Provider identity, ledger channel, tenant scope, local date, and source-row
  identity remain available for matching, attribution, and audit.
- Manual monthly imports stay out of history/latest and the generic undo path;
  a dedicated manual correction path must name its source rows explicitly.

## Considered options

- Persisting forecast rows was rejected because projections would become a
  second ledger and require composition-change invalidation and undo semantics.
- A tenant-wide or rolling 28-day product query was rejected because it would
  ignore menu membership and the weekday seasonality rule.
- Separate sales, recipe, and UI expansion implementations were rejected
  because precedence, UOM, yield, and unresolved-state drift would create
  different physical demand answers.

## Amended 2026-09

The basis is now the eight prior matching weekdays, each week back weighted at
80% of the one after it, with samples from before the product existed dropped.
A `?plan=` chooses whether the horizon totals, the headline money and the
requirements expand the typical level or the busy one. The response also
carries projected revenue at current menu prices, a history-plus-horizon
`series` for one chart, and a `backtest` that replays the same projection at
four past weeks. All of it is still read-time and computed from the one ledger
read: persistence stays rejected for the same reasons, and the status stays
accepted.
