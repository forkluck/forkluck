from dataclasses import replace
from datetime import timedelta
from zoneinfo import ZoneInfo
from decimal import Decimal
from io import StringIO
from unittest.mock import patch
import uuid

from django.core.management import call_command, CommandError
from django.db import connection

from .domains.sales.forecast import (
    ForecastInputs, _weighted_moments, load_forecast_inputs,
    menu_forecast_payload, project_product,
)
from .domains.sales.forecast_backtest import (
    CANDIDATES, STRETCH_CANDIDATES, Replay, Score,
    empirical_margin, qualifies, rolling_origins,
)
from .models import Menu, SalesLine, SalesProduct, User
from . import test_menu_forecast as forecast_tests


class ForecastBacktestTests(forecast_tests.MenuForecastTests):
    def inputs(self, *, weeks=20, value=None):
        daily = {
            self.today - timedelta(days=back): (
                value(back) if value else Decimal((self.today - timedelta(days=back)).weekday() + 1)
            )
            for back in range(1, weeks * 7 + 1)
        }
        return ForecastInputs(
            products={"p": None}, scoped_product_ids={"p"}, menu_prices={},
            unresolved=[], menu_item_count=1, linked_menu_item_count=1,
            daily={"p": daily}, last_year={},
            exists_from={"p": self.today - timedelta(days=800)},
            ledger_start=self.today - timedelta(days=34 * 7),
            history_end=self.today - timedelta(days=1), zone=ZoneInfo("UTC"),
        )

    def project_kwargs(self):
        return dict(
            exists_from=self.today - timedelta(days=800),
            history_end=self.today - timedelta(days=1),
            horizon_start=self.today, horizon_days=7, last_year=None,
        )

    def test_decay_defaults_and_unweighted_mean(self):
        self.assertEqual(_weighted_moments([Decimal(10), Decimal(0)], Decimal(1)), (Decimal(5), Decimal(25)))
        kwargs = self.project_kwargs()
        daily = self.inputs().daily["p"]
        self.assertEqual(project_product(daily, **kwargs), project_product(daily, **kwargs, decay=Decimal("0.8")))
        self.assertIs(CANDIDATES["current"], project_product)

    def test_current_replay_equals_live_with_same_cutoff(self):
        product = self.product("Bread")
        variant = self.variant(product)
        menu = self.menu(product)
        for back in range(1, 141):
            self.line(variant, self.today - timedelta(days=back), quantity=str(back % 7 + 1))
        inputs = load_forecast_inputs(self.user, menu, today=self.today, horizon_days=7, ledger_weeks=34)
        scores = rolling_origins(inputs, today=self.today, weeks=1, horizon=7, candidates=CANDIDATES)
        row = scores["current"].replays[0]
        payload = menu_forecast_payload(self.user, menu, today=row.start)
        self.assertEqual(row.typical, sum(Decimal(str(p["typicalQuantity"])) for p in payload["products"]))
        self.assertEqual(row.busy, sum(Decimal(str(p["busyQuantity"])) for p in payload["products"]))

    def test_fixed_weekday_pattern_is_exact_for_all_baselines(self):
        scores = rolling_origins(self.inputs(), today=self.today, weeks=26, horizon=7, candidates=CANDIDATES)
        for name in ("current", "mean-4w", "mean-6w", "last-week"):
            with self.subTest(name=name):
                self.assertEqual(scores[name].wape, 0)
                self.assertEqual(scores[name].median_product_wape, 0)
                self.assertEqual(scores[name].origins, 12)
        self.assertEqual(len({tuple(r.start for r in score.replays) for score in scores.values()}), 1)

    def test_short_history_trims_and_30_day_origins_must_be_complete(self):
        inputs = self.inputs(weeks=10)
        score = rolling_origins(inputs, today=self.today, weeks=26, horizon=7, candidates=CANDIDATES)["current"]
        self.assertEqual(score.origins, 2)
        score = rolling_origins(inputs, today=self.today, weeks=26, horizon=30, candidates=CANDIDATES)["current"]
        self.assertEqual(score.origins, 0)
        scores = rolling_origins(self.inputs(), today=self.today, weeks=26, horizon=30, candidates=CANDIDATES)
        self.assertEqual(scores["current"].origins, 8)
        self.assertTrue(all(row.end < self.today for row in scores["current"].replays))

    def test_empty_history_and_zero_actual_products_are_not_scored(self):
        inputs = replace(self.inputs(), daily={})
        score = rolling_origins(inputs, today=self.today, weeks=26, horizon=7, candidates=CANDIDATES)["current"]
        self.assertIsNone(score.wape)
        self.assertIsNone(score.median_product_wape)
        self.assertIsNone(score.busy_coverage)
        self.assertFalse(qualifies(score, score))
        score = Score((Replay(self.today, self.today, Decimal(12), Decimal(15), Decimal(10)),), {"p": Decimal(2), "zero": Decimal(9)}, {"p": Decimal(10), "zero": Decimal(0)})
        self.assertEqual(score.wape, 20)
        self.assertEqual(score.product_wapes, {"p": Decimal(20)})
        self.assertEqual(score.busy_over, 50)
        self.assertEqual(score.busy_coverage, 100)

    def test_last_year_scaled_fallback_and_exact_ratio(self):
        inputs = self.inputs(value=lambda back: Decimal(4))
        kwargs = self.project_kwargs()
        daily = inputs.daily["p"]
        base = project_product(daily, **kwargs)
        candidate = CANDIDATES["last-year-scaled"]
        self.assertEqual(candidate(daily, **kwargs), base)
        prior = {day - timedelta(days=364): Decimal(2) for day in daily}
        prior.update({self.today + timedelta(days=d - 364): Decimal(3) for d in range(7)})
        kwargs["last_year"] = prior
        self.assertEqual(candidate(daily, **kwargs).typical_total, 42)
        kwargs["exists_from"] = self.today - timedelta(days=100)
        self.assertEqual(candidate(daily, **kwargs), project_product(daily, **kwargs))
        self.assertEqual(candidate({}, **kwargs), project_product({}, **kwargs))

    def test_trend_halves_and_clamps(self):
        kwargs = self.project_kwargs()
        for recent, previous, factor in ((20, 10, "1.5"), (100, 10, "2"), (0, 10, "0.5"), (10, 0, "1")):
            with self.subTest(recent=recent, previous=previous):
                daily = self.inputs(value=lambda back, recent=recent, previous=previous: Decimal(recent if back <= 28 else previous)).daily["p"]
                base = project_product(daily, **kwargs)
                projected = CANDIDATES["current+trend"](daily, **kwargs)
                self.assertAlmostEqual(projected.typical_total, base.typical_total * Decimal(factor), delta=Decimal("0.007"))

    def test_conformal_uses_only_completed_earlier_origins(self):
        inputs = self.inputs(weeks=34, value=lambda back: Decimal(300 - back))
        for horizon in (7, 30):
            with self.subTest(horizon=horizon):
                scores = rolling_origins(inputs, today=self.today, weeks=26, horizon=horizon, candidates={**CANDIDATES, **STRETCH_CANDIDATES})
                current = scores["current"].replays
                conformal = scores["current+conformal"].replays
                for index, row in enumerate(conformal):
                    residuals = [prior.actual - prior.typical for prior in conformal[:index] if prior.end < row.start]
                    expected = row.typical + empirical_margin(residuals) if len(residuals) >= 4 else current[index].busy
                    self.assertEqual(row.busy, expected)
                self.assertTrue(any(row.busy != base.busy for row, base in zip(conformal, current)))
        self.assertEqual(empirical_margin([Decimal(n) for n in range(1, 11)]), 9)
        self.assertEqual(empirical_margin([Decimal(-3)] * 4), 0)

    def test_occasional_only_changes_thin_history_products(self):
        kwargs = self.project_kwargs()
        dense = self.inputs().daily["p"]
        candidate = STRETCH_CANDIDATES["current+occasional"]
        self.assertEqual(candidate(dense, **kwargs), project_product(dense, **kwargs))
        thin = {self.today - timedelta(days=7): Decimal(10)}
        projected = candidate(thin, **kwargs)
        self.assertNotEqual(projected.typical_total, project_product(thin, **kwargs).typical_total)
        self.assertEqual(projected.typical_total, 2)
        self.assertEqual(projected.weeks_observed, 1)
        self.assertEqual(candidate({}, **kwargs), project_product({}, **kwargs))

    def test_decision_rule_and_product_cancellation_guard(self):
        def score(typical, product_error, busy=110):
            return Score((Replay(self.today, self.today, Decimal(typical), Decimal(busy), Decimal(100)),), {"p": Decimal(product_error)}, {"p": Decimal(100)})
        current = score(110, 10)
        self.assertTrue(qualifies(score(108, "10.5"), current))
        self.assertFalse(qualifies(score(109, 10), current))
        self.assertFalse(qualifies(score(108, "10.6"), current))
        self.assertFalse(qualifies(score(108, 10, 99), current, busy=True))
        self.assertFalse(qualifies(score(108, 10, 113), current, busy=True))
        self.assertTrue(qualifies(score(108, 10, 112), current, busy=True))
        self.assertFalse(qualifies(current, current))

    def test_loader_rejects_foreign_owner_before_reading(self):
        menu = self.menu(self.product("Bread"))
        foreign = User.objects.create_user(email="foreign-backtest@example.com", password="test-password")
        with self.assertNumQueries(0), self.assertRaisesMessage(ValueError, "does not belong"):
            load_forecast_inputs(foreign, menu, today=self.today, horizon_days=7)

    def test_command_refs_and_read_only_table(self):
        product = self.product("Bread")
        variant = self.variant(product)
        menu = self.menu(product)
        for back in range(1, 141):
            self.line(variant, self.today - timedelta(days=back), quantity="4")
        counts = [model.objects.count() for model in (Menu, SalesProduct, SalesLine)]
        def read_only(execute, sql, params, many, context):
            self.assertTrue(sql.lstrip().upper().startswith("SELECT"), sql)
            return execute(sql, params, many, context)
        for ref in (menu.public_id, str(menu.id)):
            output = StringIO()
            with connection.execute_wrapper(read_only):
                call_command("backtest_menu_forecast", ref, weeks=26, horizon=7, as_of=self.today.isoformat(), stretch=True, per_product=True, stdout=output)
            table = output.getvalue().split("Product WAPE")[0]
            for name in {**CANDIDATES, **STRETCH_CANDIDATES}:
                self.assertEqual(sum(line.split("|")[0].strip().rstrip(" *") == name for line in table.splitlines()), 1)
            self.assertIn("Verdict: keep current", output.getvalue())
            self.assertIn("12/26", output.getvalue())
            self.assertIn("Bread", output.getvalue())
        self.assertEqual(counts, [model.objects.count() for model in (Menu, SalesProduct, SalesLine)])
        for ref in ("mnu_missing", str(uuid.uuid4()), "not-a-uuid"):
            with self.assertRaisesMessage(CommandError, "Menu not found"):
                call_command("backtest_menu_forecast", ref, stdout=StringIO())
        with self.assertRaisesMessage(CommandError, "Menu not found"):
            call_command("backtest_menu_forecast", menu.public_id, email="another@example.com", stdout=StringIO())
        for options in ({"weeks": 0}, {"as_of": "bad"}, {"as_of": "9999-01-01"}):
            with self.assertRaises(CommandError):
                call_command("backtest_menu_forecast", menu.public_id, stdout=StringIO(), **options)

    def test_command_defaults_to_workspace_local_date(self):
        menu = self.menu()
        output = StringIO()
        with patch("forkluck.management.commands.backtest_menu_forecast.timezone.now") as now:
            from datetime import datetime, timezone
            now.return_value = datetime(2026, 4, 27, 1, tzinfo=timezone.utc)
            self.user.benchcost_settings.timezone = "America/New_York"
            self.user.benchcost_settings.save()
            call_command("backtest_menu_forecast", menu.public_id, stdout=output)
        self.assertIn("As of 2026-04-26", output.getvalue())
