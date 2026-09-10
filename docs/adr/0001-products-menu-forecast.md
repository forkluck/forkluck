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


## Amended 2026-09 (production plan)

The menu forecast now leads with quantities to make and recipe batches. Money
is one caption; the chart and the replayed accuracy are menu-member units and
remain useful without product prices. Recent weeks, their matching weeks last
year, and last year's coming weeks are visible beside the plan, with the
unscaled weekly level and descriptive seasonal factor.

Day rows allocate the selected whole-horizon plan by weekday rhythm, conserving
the total after rounding. This reverses the earlier decision to hide dates:
they now serve as a kitchen schedule and are explicitly not independent daily
busy levels. Zero typical patterns with positive busy demand are distributed
evenly. Recipe day batches use the same physical resolver as the horizon;
materials stay on one shopping list. The 30-day schedule groups dates into
weekly blocks, including its final partial block. CSV exports keep daily batches.

The headline's aggregate is a production count across the product rows,
including included products; the chart, basis, and accuracy are explicitly
menu-member comparisons. Neither is a new sales-accounting view. The overall
basis factor is not applied a second time. No persisted state, additional
queries, forecast dependencies, or live basis changes are introduced.

Any future basis change remains subject to the separate read-only backtest:
a 7-day menu WAPE improvement of at least 2 points, median product WAPE no more
than 0.5 points worse, and no loss at 30 days. A busy candidate must also retain
coverage and add no more than 2 points of over-production. No production
results have been accepted by this amendment.


## Amended 2026-09-09 (chef explanations)

The page title is Production forecast and navigation remains Forecast. The
combined items/batches headline and menu-wide comparison grid are removed.
Expected demand stays per product; prep quantities use physical recipe outputs
with recipe equivalents secondary. Missing yields explicitly fall back to
batches. Existing API totals and dated CSV batch columns remain compatible.

Why this quantity? opens the exact product decomposition: the same projection
without seasonal scaling, its signed seasonal difference, and the separate
Busy allowance. Dated recorded history is a second disclosure, with limited
history and absent last-year comparisons stated plainly. The full horizon is
explicit in day view as well. This is a forecast before stock/prepared-food
deductions, not a net instruction to cook. The chart and method follow the tables.

No forecast engine, persisted relation, ledger scope or query is added. The
reference-code analysis in [Forecast reference review](../FORECAST_REFERENCE_REVIEW.md)
records what ETS, Theta, AutoARIMA and MLForecast can contribute, and why fitting
an engine is separate from proving a replacement on held-out kitchen history.


## Amended 2026-09-10 (busy margin sized from past misses)

The read-only backtest was run on the te-company September menu over 26
weekly origins. No demand candidate met the rule: switching the seasonal
factor off cost 3.2 points of 7-day menu WAPE and 6.6 at 30 days; unweighted
four and six week windows lost by 3 or more; a damped trend term lost; scaling
last year's weeks won 1.6 points on the menu total but was 7 points worse per
product, the wrong trade for a kitchen. The eight-week weighted basis and the
damped seasonal factor stay.

The busy level changes. The spread rule (1.28 pooled standard deviations)
covered 96% of 7-day weeks while over-producing by 35%; the same coverage
came from a margin sized at the ninth decile of the projection's own past
misses with 25% over-production, and at 30 days that margin raised coverage
from 82% to 86% while over-producing slightly less. The page now replays its
projection at twelve weekly origins of its own horizon, takes the ninth
decile of completed, nonzero residuals, and scales every product's spread
allowance by one ratio so the members' allowances sum to it: history sizes
the allowance, the spread still decides which products carry it. With fewer
than four such origins the spread rule stands, and `basis.busyBasis` says
which applied. Revenue busy and the accuracy panel's busy are that same plan,
so the caption and the coverage sentence describe what the tables show. The
ledger read widens to twenty weeks; it is still one read and no query is
added. The backtest command's `current` sizes its busy the same way, and a
busy-only candidate is judged on coverage held and over-production cut rather
than on an error it cannot move.
