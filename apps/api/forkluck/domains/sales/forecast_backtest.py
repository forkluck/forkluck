"""Pure rolling-origin comparisons; no reads, writes, or fitted live state.

The menu aggregate is a diagnostic count of planned product units, including
expanded products, not a sales-accounting total. Product WAPE guards against
opposite product errors cancelling in that aggregate. All methods share the
same completed origins and the same eight-week minimum history.

``current`` is the live rule end to end: ``project_product`` for typical, and
a busy margin sized from the origins before each one, exactly as the page
sizes its own.  ``spread-busy`` is the same typical with the spread rule the
page falls back to, so the two busy rules can be read side by side.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import date, timedelta
from decimal import Decimal
from statistics import median

from .forecast import (
    BUSY_Z,
    CALIBRATION_MIN_ORIGINS,
    HISTORY_WEEKS,
    SEASONAL_LAG_DAYS,
    DayProjection,
    ForecastInputs,
    ProductProjection,
    _clamped,
    _history_dates,
    _window_total,
    empirical_margin,
    project_product,
)


def _from_days(base, days, *, seasonal_factor=None):
    typical = sum((day.typical for day in days.values()), Decimal())
    variance = sum((day.variance for day in days.values()), Decimal())
    return replace(
        base,
        days=days,
        typical_total=typical,
        busy_total=_clamped(typical + BUSY_Z * variance.sqrt()),
        seasonal_factor=(
            base.seasonal_factor if seasonal_factor is None else seasonal_factor
        ),
    )


def _no_seasonal(daily, **kwargs):
    return project_product(daily, **{**kwargs, "last_year": None})


def _mean_4w(daily, **kwargs):
    return project_product(
        daily, **{**kwargs, "weeks": 4, "decay": Decimal(1), "last_year": None}
    )


def _mean_6w(daily, **kwargs):
    return project_product(
        daily, **{**kwargs, "weeks": 6, "decay": Decimal(1), "last_year": None}
    )


def _last_week(daily, **kwargs):
    return project_product(daily, **{**kwargs, "weeks": 1, "last_year": None})


def _last_year_scaled(daily, **kwargs):
    base = project_product(daily, **kwargs)
    end = kwargs["history_end"]
    start = end - timedelta(days=41)
    lag = timedelta(days=SEASONAL_LAG_DAYS)
    last_year = kwargs.get("last_year") or {}
    exists = kwargs["exists_from"]
    recent = _window_total(daily, start, end)
    prior = _window_total(last_year, start - lag, end - lag)
    if recent <= 0 or prior <= 0 or (exists is not None and exists > start - lag):
        return base
    factor = recent / prior
    return _from_days(
        base,
        {
            day: DayProjection(
                typical=_clamped(last_year.get(day - lag, Decimal()) * factor),
                variance=entry.variance,
            )
            for day, entry in base.days.items()
        },
        seasonal_factor=Decimal(1),
    )


def _current_trend(daily, **kwargs):
    base = project_product(daily, **kwargs)
    end = kwargs["history_end"]
    last4 = _window_total(daily, end - timedelta(days=27), end)
    prior4 = _window_total(daily, end - timedelta(days=55), end - timedelta(days=28))
    factor = (
        min(Decimal(2), max(Decimal("0.5"), 1 + (last4 - prior4) / (2 * prior4)))
        if prior4 > 0 else Decimal(1)
    )
    return _from_days(base, {
        day: DayProjection(
            typical=_clamped(entry.typical * factor),
            variance=entry.variance * factor * factor,
        )
        for day, entry in base.days.items()
    })


def _current_occasional(daily, **kwargs):
    base = project_product(daily, **kwargs)
    if not 1 <= base.weeks_observed <= 3:
        return base
    days = {}
    for day in base.days:
        samples = [
            daily.get(sample_day, Decimal())
            for sample_day in reversed(_history_dates(
                day, kwargs["history_end"], kwargs.get("weeks", HISTORY_WEEKS)
            ))
            if kwargs["exists_from"] is None or sample_day >= kwargs["exists_from"]
        ]
        probability, size = Decimal(), Decimal()
        for index, sample in enumerate(samples):
            occurs = Decimal(sample > 0)
            probability = occurs if index == 0 else probability * Decimal("0.8") + occurs * Decimal("0.2")
            if sample > 0:
                size = sample if size == 0 else size * Decimal("0.8") + sample * Decimal("0.2")
        mean = probability * size * base.seasonal_factor
        variance = probability * (1 - probability) * (size * base.seasonal_factor) ** 2
        days[day] = DayProjection(typical=_clamped(mean), variance=variance)
    return _from_days(base, days)


CANDIDATES: dict[str, Callable[..., ProductProjection]] = {
    "current": project_product,
    "no-seasonal": _no_seasonal,
    "mean-4w": _mean_4w,
    "mean-6w": _mean_6w,
    "last-week": _last_week,
    "last-year-scaled": _last_year_scaled,
    "current+trend": _current_trend,
}
STRETCH_CANDIDATES = {
    # The page's fallback busy rule on its own, for reading beside current.
    "spread-busy": project_product,
    "current+occasional": _current_occasional,
}
# Candidates whose busy is the summed spread rule rather than the live margin.
SPREAD_BUSY = {"spread-busy"}


@dataclass(frozen=True)
class Replay:
    start: date
    end: date
    typical: Decimal
    busy: Decimal
    actual: Decimal


@dataclass(frozen=True)
class Score:
    replays: tuple[Replay, ...]
    product_errors: Mapping[str, Decimal]
    product_actuals: Mapping[str, Decimal]

    @property
    def origins(self):
        return len(self.replays)

    @property
    def wape(self):
        volume = sum((row.actual for row in self.replays), Decimal())
        return 100 * sum((abs(row.typical - row.actual) for row in self.replays), Decimal()) / volume if volume else None

    @property
    def product_wapes(self):
        return {
            product_id: 100 * self.product_errors[product_id] / actual
            for product_id, actual in self.product_actuals.items() if actual > 0
        }

    @property
    def median_product_wape(self):
        values = list(self.product_wapes.values())
        return median(values) if values else None

    @property
    def busy_coverage(self):
        return Decimal(100 * sum(row.busy >= row.actual for row in self.replays)) / self.origins if self.origins else None

    @property
    def busy_over(self):
        volume = sum((row.actual for row in self.replays), Decimal())
        return 100 * sum((row.busy - row.actual for row in self.replays), Decimal()) / volume if volume else None


def rolling_origins(
    inputs: ForecastInputs,
    *,
    today: date,
    weeks: int,
    horizon: int,
    candidates: Mapping[str, Callable[..., ProductProjection]],
) -> dict[str, Score]:
    """Replay oldest first; only complete horizons with eight weeks of support.

    A first observed sale is the earliest evidence of ledger coverage, not
    proof that earlier missing history is zero. Late products still use the
    live existence anchor within otherwise supported menu origins.
    """
    first = min(
        (day for pid in inputs.products for day in inputs.daily.get(pid, {})),
        default=today,
    )
    first = max(first, inputs.ledger_start)
    replays: dict[str, list[Replay]] = {name: [] for name in candidates}
    errors = {name: {pid: Decimal() for pid in inputs.products} for name in candidates}
    actuals = {pid: Decimal() for pid in inputs.products}
    for back in range(weeks, 0, -1):
        as_of = today - timedelta(days=7 * back)
        end = as_of + timedelta(days=horizon - 1)
        if as_of - timedelta(days=7 * HISTORY_WEEKS) < first or end > inputs.history_end:
            continue
        actual = {
            pid: _window_total(inputs.daily.get(pid, {}), as_of, end)
            for pid in inputs.products
        }
        total_actual = sum(actual.values(), Decimal())
        if total_actual <= 0:
            continue
        for pid, units in actual.items():
            actuals[pid] += units
        for name, candidate in candidates.items():
            projections = {
                pid: candidate(
                    inputs.daily.get(pid, {}),
                    exists_from=inputs.exists_from.get(pid),
                    history_end=as_of - timedelta(days=1),
                    horizon_start=as_of,
                    horizon_days=horizon,
                    last_year=inputs.last_year.get(pid),
                )
                for pid in inputs.products
            }
            typical = sum((p.typical_total for p in projections.values()), Decimal())
            busy = sum((p.busy_total for p in projections.values()), Decimal())
            if name not in SPREAD_BUSY:
                # The live rule: a margin sized from the origins before this
                # one.  A prior 30-day origin may still be in flight, and its
                # outcome must not calibrate a forecast made before it ended.
                residuals = [
                    row.actual - row.typical for row in replays[name] if row.end < as_of
                ]
                if len(residuals) >= CALIBRATION_MIN_ORIGINS:
                    busy = typical + empirical_margin(residuals)
            replays[name].append(Replay(as_of, end, typical, busy, total_actual))
            for pid, projection in projections.items():
                errors[name][pid] += abs(projection.typical_total - actual[pid])
    return {
        name: Score(tuple(rows), errors[name], actuals)
        for name, rows in replays.items()
    }


def busy_only(candidate: Score, current: Score) -> bool:
    """A candidate that changes nothing but the busy level."""
    return all(
        row.typical == base.typical
        for row, base in zip(candidate.replays, current.replays, strict=True)
    )


def qualifies(candidate: Score, current: Score) -> bool:
    """The single-horizon gate; promotion also requires the other horizon.

    A demand candidate has to cut the menu error by two points without
    losing the mix.  A busy-only candidate cannot move the error at all, so
    it is judged on what busy is for: keep the coverage and bake less for it.
    """
    if not current.origins or tuple(r.start for r in candidate.replays) != tuple(r.start for r in current.replays):
        return False
    if busy_only(candidate, current):
        return (
            candidate.busy_coverage >= current.busy_coverage
            and candidate.busy_over <= current.busy_over - 2
        )
    return (
        current.wape - candidate.wape >= 2
        and candidate.median_product_wape <= current.median_product_wape + Decimal("0.5")
        and candidate.busy_coverage >= current.busy_coverage
        and candidate.busy_over <= current.busy_over + 2
    )
