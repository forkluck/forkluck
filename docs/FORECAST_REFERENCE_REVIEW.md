# Forecast reference code review

Reviewed the checked-out source on 2026-09-09. StatsForecast is pinned to
`1734b188ad10f06c8d7d62b55b53dd13a9ffe68a`; MLForecast is pinned to
`c69f6b5b4cefe9a2191018334b12eee7d1d1ac78`. Both are useful references. Neither
engine is installed, vendored, or running in Forkluck. This review does not
claim equivalent algorithms or benchmark performance.

## What the code actually does

| Source | Mechanism observed | Use in Forkluck |
| --- | --- | --- |
| [AutoARIMA search](https://github.com/Nixtla/statsforecast/blob/1734b188ad10f06c8d7d62b55b53dd13a9ffe68a/python/statsforecast/arima.py#L2043) | Tests differencing, bounds model orders, searches stepwise (default 94 models), compares AICc by default, and refits approximate candidates. Constant/short series have separate paths. | Useful as a bounded challenger for sufficiently long, regular series. Reproducing this requires fitting, diagnostics, and numerical machinery; a weighted weekday average is not AutoARIMA. It is not the first engine to port into a request handler. |
| [AutoETS wrapper](https://github.com/Nixtla/statsforecast/blob/1734b188ad10f06c8d7d62b55b53dd13a9ffe68a/python/statsforecast/models.py#L740) and [state updates](https://github.com/Nixtla/statsforecast/blob/1734b188ad10f06c8d7d62b55b53dd13a9ffe68a/src/ets.cpp#L28) | Separates level, trend and seasonal states. Level moves toward the deseasonalized observation; trend and season update separately. Damped forecasts limit trend extrapolation. Auto selection uses an information criterion, with models fitted by likelihood. | Best next small challenger: an additive smoothed level plus damped trend and a weekday pattern, evaluated offline. It could respond to genuine demand shifts faster than fixed weights. Test whether last-year scaling adds value on top; do not blindly stack seasonal adjustments. A limited implementation must be labelled an ETS-inspired candidate, not AutoETS. |
| [Theta selection/decomposition](https://github.com/Nixtla/statsforecast/blob/1734b188ad10f06c8d7d62b55b53dd13a9ffe68a/python/statsforecast/theta.py#L452) | Tests whether seasonality is supported, switches away from multiplicative decomposition for nonpositive data, and tries STM/OTM/DSTM/DOTM variants. The default normal-distribution path selects fitted MSE; other distributions use AIC. | A second challenger combining smoothing with a trend estimate. Especially useful lessons are requiring seasonal evidence and handling zeros/returns explicitly. The internal fitted-MSE choice is not held-out proof that Theta will improve this menu. |
| [StatsForecast rolling evaluation](https://github.com/Nixtla/statsforecast/blob/1734b188ad10f06c8d7d62b55b53dd13a9ffe68a/python/statsforecast/core.py#L280) | Slices training observations strictly before each cutoff, forecasts the following horizon, and controls refitting/fallback. | Directly supports the existing read-only comparison approach: identical origins and training cutoffs for all challengers, plus a reliable baseline when fitting fails. |
| [MLForecast evaluation](https://github.com/Nixtla/mlforecast/blob/c69f6b5b4cefe9a2191018334b12eee7d1d1ac78/mlforecast/forecast.py#L1928) | Builds chronological train/validation splits, refits on training data, forecasts, and joins actuals and predictions by series identity, date and cutoff. | Useful evaluation discipline if lag/weekday or shared-product models are later tested. Features for future dates must be known at forecast time; future sales cannot enter a lag or rolling statistic. Sharing information across products needs separate evidence and stable product identities. |

## What this release takes from the review

The useful immediate principle is keeping the demand estimate, seasonal effect,
and uncertainty allowance distinct and testable. Forkluck's explanation reuses
its actual pure projection rather than inventing a story from a menu average:

- Recent demand is the same selected horizon projected without seasonal scaling.
- Seasonal change is the exact difference to expected demand, including damping,
  clamping and engine rounding.
- Busy allowance is the difference from expected to Busy, over the whole period.
- Historical tables contain dated recorded consumption. They do not mix a
  prediction into a column called actual sales or infer zero demand from absence.

This makes the existing engine reviewable to a chef. It is not an accuracy gain
or an implementation of StatsForecast's state-space equations. Product demand
still uses eight matching weekdays, recency decay, the guarded last-year factor,
and pooled variation. Physical recipe expansion remains the kitchen-specific
part these general forecasting libraries do not supply.

## Evidence required before changing the engine

Start with the bounded additive/damped-trend challenger, then Theta if useful.
Use the existing offline comparison command and canonical tenant-scoped
consumption loader. Fit parameters only on each origin's past. If selecting
parameters by replay, keep later outer periods separate for evaluation. Do not
select the winner on the same periods used to claim its improvement.

Score the same completed 7-day and 30-day origins. The existing release rule
requires at least 2 percentage points lower 7-day menu WAPE, median product WAPE
no more than 0.5 points worse, and no loss at 30 days. Busy must retain coverage
without more than 2 points additional over-production. Aggregate error alone
can hide opposing errors across recipes. Calibrate the Busy allowance on past,
completed horizon residuals, independently of choosing the expected-demand
engine; overlapping future horizons must not leak residuals.

Include new/sparse products, zeros and returns, weekday closures, seasonal
changes, bundles and mapped modifiers. Observed sales cannot reveal unmet
stockout demand without availability records. Preserve short-history fallbacks,
exact product/day/recipe allocation, read-only behavior and request latency.
No challenger should be called world-class based solely on its engine name;
that claim needs sustained accuracy and operational evidence.
