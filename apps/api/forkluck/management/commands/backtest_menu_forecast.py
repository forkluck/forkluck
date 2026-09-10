"""Read-only comparisons of menu production forecasts."""

from datetime import date
import uuid

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from ...domains.sales.forecast import HISTORY_WEEKS, load_forecast_inputs
from ...domains.sales.forecast_backtest import CANDIDATES, STRETCH_CANDIDATES, qualifies, rolling_origins
from ...domains.shared.workspace_timezone import workspace_zone
from ...models import Menu


class Command(BaseCommand):
    help = (
        "Compare menu forecasting bases in production units across a longer replay than the page. "
        "Reads only. The modifier walk uses a fixed set of queries but a potentially "
        "large in-memory pass over the requested ledger window."
    )

    def add_arguments(self, parser):
        parser.add_argument("menu_ref")
        parser.add_argument("--weeks", type=int, default=26)
        parser.add_argument("--horizon", type=int, choices=(7, 30), default=7)
        parser.add_argument("--as-of", help="Workspace-local date, YYYY-MM-DD.")
        parser.add_argument("--per-product", action="store_true")
        parser.add_argument("--stretch", action="store_true")
        parser.add_argument("--email", help="Optionally require this menu owner.")

    def handle(self, *args, **options):
        if options["weeks"] < 1:
            raise CommandError("Weeks must be positive")
        queryset = Menu.objects.select_related("user")
        if options["email"]:
            queryset = queryset.filter(user__email=options["email"])
        ref = options["menu_ref"]
        if ref.startswith("mnu_"):
            menu = queryset.filter(public_id=ref).first()
        else:
            try:
                menu = queryset.filter(id=uuid.UUID(ref)).first()
            except ValueError:
                menu = None
        if menu is None:
            raise CommandError("Menu not found")
        user = menu.user
        local_today = timezone.now().astimezone(workspace_zone(user)).date()
        try:
            today = date.fromisoformat(options["as_of"]) if options["as_of"] else local_today
        except ValueError as exc:
            raise CommandError("As-of must be a date in YYYY-MM-DD form") from exc
        if today > local_today:
            raise CommandError("As-of must not be in the future")
        inputs = load_forecast_inputs(
            user, menu, today=today, horizon_days=options["horizon"],
            ledger_weeks=options["weeks"] + HISTORY_WEEKS,
        )
        candidates = {**CANDIDATES, **(STRETCH_CANDIDATES if options["stretch"] else {})}
        scores = rolling_origins(
            inputs, today=today, weeks=options["weeks"],
            horizon=options["horizon"], candidates=candidates,
        )
        available = [score.wape for score in scores.values() if score.wape is not None]
        best = min(available) if available else None
        self.stdout.write(
            f"As of {today.isoformat()} | horizon {options['horizon']} days | "
            f"{scores['current'].origins}/{options['weeks']} completed, supported, nonzero origins"
        )
        self.stdout.write(
            f"{'method':<22} | {'menu WAPE %':>11} | {'median product WAPE %':>21} | "
            f"{'busy coverage %':>15} | {'busy over %':>11} | {'origins':>7}"
        )
        for name, score in scores.items():
            mark = " *" if best is not None and score.wape == best else ""
            self.stdout.write(
                f"{name + mark:<22} | {self.number(score.wape):>11} | "
                f"{self.number(score.median_product_wape):>21} | "
                f"{self.number(score.busy_coverage):>15} | {self.number(score.busy_over):>11} | "
                f"{score.origins:>7}"
            )
        self.stdout.write("* Lowest menu WAPE; signed busy over-production is relative to actual units.")
        if options["per_product"]:
            self.stdout.write("\nProduct WAPE % (products with no net actual units excluded):")
            for pid, product in inputs.products.items():
                values = [
                    f"{name}: {self.number(score.product_wapes.get(pid))}"
                    for name, score in scores.items()
                ]
                self.stdout.write(f"{product.public_id} {product.name} | " + " | ".join(values))
        winners = [
            name for name, score in scores.items() if name != "current"
            and qualifies(score, scores["current"])
        ]
        if not available:
            verdict = "keep current; not enough completed, supported, nonzero origins."
        elif winners:
            verdict = (
                "keep current pending both horizons; this run's qualifying candidates: "
                + ", ".join(winners) + "."
            )
        else:
            verdict = "keep current; no candidate meets the replacement rule in this run."
        self.stdout.write("Verdict: " + verdict)
        self.stdout.write(
            "Rule: same origins; 7-day menu WAPE improves by >=2.0 points, median product "
            "WAPE rises by <=0.5, busy coverage holds and over-production grows by <=2 "
            "points. A busy-only candidate instead holds coverage and cuts over-production "
            "by >=2 points. Confirm the same candidate does not lose at 30 days. "
            "Ties keep current. This command never changes the live basis."
        )

    @staticmethod
    def number(value):
        return "—" if value is None else f"{value:.2f}"
