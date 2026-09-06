"""The workspace's labor policy: unpaid break deduction and payroll burden.

Two domains need this arithmetic and domains may not import each other, so it
lives here. Labor costs shifts as they are imported and as rates move;
workspace edits the policy and has to recost every shift the moment the break
rule changes, because a stored `labor_cost_cents` computed under the old rule
is simply wrong under the new one.

The two settings sit at different depths on purpose:

- The **unpaid break** changes what a shift is paid for, so it is baked into
  every `TimeEntry.labor_cost_cents` and has to be recomputed when it moves.
- The **payroll tax** is a rate applied to money that is already correct, so
  nothing stores it. Reads derive the increment from the settings row they
  already load, and changing the rate is instant with no backfill and no
  chance of a stored total drifting from the rate that produced it. Deriving
  it once from a period total also beats summing a per-shift rounding error.
"""

from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from uuid import UUID
from zoneinfo import ZoneInfo

from django.db.models import Sum
from django.utils import timezone

from ...models import (
    BenchCostSettings,
    Employee,
    LaborImport,
    TimeEntry,
    User,
)

SECONDS_PER_HOUR = 3600


@dataclass(frozen=True)
class LaborPolicy:
    """What the workspace loads onto an hour, and what it takes off a shift."""

    unpaid_break_minutes: int
    unpaid_break_per_hours: int
    payroll_tax_bps: int


def read_labor_policy(user: User) -> LaborPolicy:
    row, _ = BenchCostSettings.objects.get_or_create(user=user)
    return policy_of(row)


def policy_of(row: BenchCostSettings) -> LaborPolicy:
    """The policy carried by an already-loaded settings row.

    Read paths have that row in hand for the currency and the overtime
    threshold; making them re-fetch it would add a query to a counted budget.
    """
    return LaborPolicy(
        unpaid_break_minutes=row.unpaid_break_minutes,
        unpaid_break_per_hours=row.unpaid_break_per_hours,
        payroll_tax_bps=row.payroll_tax_bps,
    )


def unpaid_break_seconds_for(paid_seconds: int, policy: LaborPolicy) -> int:
    """What the auto-deduct rule takes off a shift of `paid_seconds`.

    "30 minutes per 8 hours worked" deducts on *whole completed blocks*: a
    7-hour shift loses nothing, an 8- through 15-hour shift loses 30 minutes,
    a 16-hour shift loses an hour. Prorating instead would dock a four-hour
    lunch shift for a meal break nobody took, which is the false reading this
    setting exists to avoid.

    The result never exceeds the shift, so payable time cannot go negative
    even if a kitchen sets a deduction longer than the block it applies to.
    """
    if policy.unpaid_break_minutes <= 0 or policy.unpaid_break_per_hours <= 0:
        return 0
    block_seconds = policy.unpaid_break_per_hours * SECONDS_PER_HOUR
    blocks = paid_seconds // block_seconds
    return min(blocks * policy.unpaid_break_minutes * 60, paid_seconds)


def payable_seconds_for(paid_seconds: int, policy: LaborPolicy) -> int:
    """The time a shift is actually paid for, after the unpaid break."""
    return paid_seconds - unpaid_break_seconds_for(paid_seconds, policy)


def labor_cost_cents(
    payable_seconds: int, hourly_rate_cents: int, earnings_adjustment_cents: int
) -> int:
    base = (
        Decimal(payable_seconds)
        * Decimal(hourly_rate_cents)
        / Decimal(SECONDS_PER_HOUR)
    ).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return int(base) + earnings_adjustment_cents


def payroll_tax_cents(cost_cents: int, payroll_tax_bps: int) -> int:
    """The employer's burden on top of `cost_cents` — the incremental.

    Taken on the total rather than per shift: a workspace's rate is one rate,
    and rounding once is both cheaper and closer than summing 3,000 rounded
    per-shift slices. Negative totals (an earnings adjustment can outweigh a
    shift) carry their sign, so the burden reverses with the money it is on.
    """
    if not payroll_tax_bps:
        return 0
    return int(
        (Decimal(cost_cents) * Decimal(payroll_tax_bps) / Decimal(10000)).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP
        )
    )


def refresh_labor_import_totals(row: LaborImport) -> None:
    """Recompute an import's cached totals while holding that import's row lock.

    One import holds shifts for many employees, so a per-shift override save and
    a different employee's rate recalculation touch disjoint TimeEntry rows yet
    both rewrite this one import row. Without a shared lock the second refresh
    could aggregate while the first was still uncommitted, block on the import
    row only at save time, and then write that stale total once the first
    committed, leaving import history disagreeing with its own shifts. Taking
    the import's row lock before reading the shifts forces the later refresh to
    aggregate after the earlier one committed.

    Lock order: every path takes the TimeEntry rows it mutates before any
    LaborImport row, and takes LaborImport rows in ascending id order, so these
    two locks can never be requested in a cycle.
    """
    locked = list(
        LaborImport.objects.select_for_update()
        .filter(pk=row.pk)
        .values_list("pk", flat=True)
    )
    if not locked:
        # A concurrent transaction deleted the import; it has no totals left.
        return
    totals = row.time_entries.aggregate(
        total_seconds=Sum("paid_seconds"),
        total_labor_cost_cents=Sum("labor_cost_cents"),
    )
    row.imported_count = row.time_entries.count()
    row.total_seconds = totals["total_seconds"] or 0
    row.total_labor_cost_cents = totals["total_labor_cost_cents"] or 0
    row.uncosted_count = row.time_entries.filter(
        labor_cost_cents__isnull=True
    ).count()
    row.save(
        update_fields=[
            "imported_count",
            "total_seconds",
            "total_labor_cost_cents",
            "uncosted_count",
            "updated_at",
        ]
    )


def recalculate_employee_time_entries(
    employee: Employee, policy: LaborPolicy | None = None
) -> None:
    """Re-cost every shift of one employee against the current rates and policy.

    Callers already holding the settings row pass `policy`; the rest let it be
    read here.
    """
    if policy is None:
        policy = read_labor_policy(employee.user)
    rates = list(employee.hourly_rates.order_by("effective_from", "created_at"))
    # Lock the employee's time-entry rows before reading their current rate so a
    # concurrent per-shift override save (action_set_time_entry_rate, which locks
    # the same row via select_for_update) cannot commit between this read and the
    # bulk_update below. Without the shared lock the recalculation could read a
    # row before its override commits and then clobber the committed override's
    # cached rate and cost, violating the shift-rate override precedence. `of`
    # keeps the lock on the time-entry rows only; the imports these shifts belong
    # to are locked afterwards by refresh_labor_import_totals, which keeps this
    # path on the shared TimeEntry-then-LaborImport lock order. Locking the
    # entries first is also what makes the set of affected imports exact: it is
    # read from rows no one else can change.
    entries = list(
        employee.time_entries.select_for_update(of=("self",))
        .select_related("labor_import")
        .order_by("clock_in", "id")
    )
    changed: list[TimeEntry] = []
    import_ids: set[UUID] = set()
    recalculated_at = timezone.now()
    for entry in entries:
        zone = ZoneInfo(entry.labor_import.timezone)
        effective_on = entry.clock_in.astimezone(zone).date()
        applicable = [rate for rate in rates if rate.effective_from <= effective_on]
        rate = applicable[-1] if applicable else None
        if entry.hourly_rate_override_cents is not None:
            next_rate = entry.hourly_rate_override_cents
        else:
            next_rate = rate.hourly_rate_cents if rate else None
        next_break = unpaid_break_seconds_for(entry.paid_seconds, policy)
        next_cost = (
            labor_cost_cents(
                entry.paid_seconds - next_break,
                next_rate,
                entry.earnings_adjustment_cents,
            )
            if next_rate is not None
            else None
        )
        if (
            entry.hourly_rate_cents != next_rate
            or entry.unpaid_break_seconds != next_break
            or entry.labor_cost_cents != next_cost
        ):
            entry.hourly_rate_cents = next_rate
            entry.unpaid_break_seconds = next_break
            entry.labor_cost_cents = next_cost
            entry.updated_at = recalculated_at
            changed.append(entry)
            import_ids.add(entry.labor_import_id)
    if changed:
        TimeEntry.objects.bulk_update(
            changed,
            [
                "hourly_rate_cents",
                "unpaid_break_seconds",
                "labor_cost_cents",
                "updated_at",
            ],
        )
    # Ascending id, so two recalculations that span the same pair of imports
    # queue for those row locks in the same sequence instead of deadlocking.
    for row in LaborImport.objects.filter(id__in=import_ids).order_by("id"):
        refresh_labor_import_totals(row)


def recost_workspace_shifts(user: User, policy: LaborPolicy) -> None:
    """Re-cost the whole workspace after its unpaid-break rule moved.

    Per employee rather than in one pass: the per-employee routine already owns
    the rate-history walk, the override precedence and the lock order, and
    duplicating that here to save a query per employee is how the two would
    drift apart. Employees are taken in id order so two concurrent saves queue
    for the same row locks in the same sequence.
    """
    for employee in Employee.objects.filter(user=user).order_by("id"):
        recalculate_employee_time_entries(employee, policy)
