"""Labor JSON shapes and the rate lookup they share with the actions."""

from datetime import date
from typing import Any

from django.utils import timezone

from ...models import Employee, EmployeeHourlyRate, LaborImport, TimeEntry
from ..shared.labor_policy import payroll_tax_cents
from ..shared.values import group_key_part, iso

JsonObject = dict[str, Any]

# The one comparison key for a written employee name. `parseLaborFile` joins
# the browser-computed `normalizedName` against what this returns, so it must
# be the shared browser-mirroring key, not an independent normalizer:
# the earlier casefold-based copy silently missed names like "Groß" that
# JS `toLowerCase` leaves unfolded. `Employee.normalized_name` stores this
# key; migration 0070 recomputed rows the casefold rule had written.
normalize_employee_name = group_key_part


def employee_rate_on(employee: Employee, effective_on: date) -> EmployeeHourlyRate | None:
    prefetched = getattr(employee, "_prefetched_objects_cache", {}).get("hourly_rates")
    if prefetched is not None:
        return next(
            (rate for rate in prefetched if rate.effective_from <= effective_on),
            None,
        )
    return employee.hourly_rates.filter(
        effective_from__lte=effective_on
    ).order_by("-effective_from", "-created_at").first()


def labor_import_json(row: LaborImport, *, can_undo: bool = False) -> JsonObject:
    return {
        "id": str(row.id),
        "fileName": row.file_name,
        "source": row.source,
        "timezone": row.timezone,
        "periodStart": row.period_start.isoformat() if row.period_start else None,
        "periodEnd": row.period_end.isoformat() if row.period_end else None,
        "totalRows": row.total_rows,
        "importedCount": row.imported_count,
        "createdEmployeeCount": row.created_employee_count,
        "duplicateCount": row.duplicate_count,
        "skippedCount": row.skipped_count,
        "excludedCount": row.excluded_count,
        "totalSeconds": row.total_seconds,
        "totalLaborCostCents": row.total_labor_cost_cents,
        "uncostedCount": row.uncosted_count,
        "createdAt": iso(row.created_at),
        "undoneAt": iso(row.undone_at) if row.undone_at else None,
        "canUndo": can_undo,
    }


def employee_json(
    row: Employee, *, today: date | None = None, payroll_tax_bps: int = 0
) -> JsonObject:
    """Serialize an employee, including the rate in force on `today`.

    `today` is the business-local date. It used to default to
    timezone.localdate(), which is the *server's* UTC date: near local midnight
    a workspace west of UTC would see a rate that only starts tomorrow, and one
    east of UTC would still see yesterday's. Callers that know the business
    timezone pass its date; the UTC fallback remains for callers that do not.
    """
    if today is None:
        today = timezone.localdate()
    current_rate = employee_rate_on(row, today)
    entries = list(
        getattr(row, "_prefetched_objects_cache", {}).get("time_entries", [])
    )
    costed = [
        entry.labor_cost_cents
        for entry in entries
        if entry.labor_cost_cents is not None
    ]
    rates = list(
        getattr(row, "_prefetched_objects_cache", {}).get("hourly_rates", [])
    )
    return {
        "id": str(row.id),
        "name": row.name,
        "normalizedName": row.normalized_name,
        "isActive": row.is_active,
        "excludedFromCost": row.excluded_from_cost,
        "currentHourlyRateCents": (
            current_rate.hourly_rate_cents if current_rate else None
        ),
        "currentRateEffectiveFrom": (
            current_rate.effective_from.isoformat() if current_rate else None
        ),
        "shiftCount": len(entries),
        # Clocked hours, with the deduction beside them rather than folded in.
        "totalSeconds": sum(entry.paid_seconds for entry in entries),
        "unpaidBreakSeconds": sum(entry.unpaid_break_seconds for entry in entries),
        "laborCostCents": sum(costed),
        "payrollTaxCents": payroll_tax_cents(sum(costed), payroll_tax_bps),
        "uncostedCount": sum(
            entry.labor_cost_cents is None for entry in entries
        ),
        "firstShiftAt": (
            iso(min(entry.clock_in for entry in entries)) if entries else None
        ),
        "lastShiftAt": (
            iso(max(entry.clock_out for entry in entries)) if entries else None
        ),
        "rateHistory": [
            {
                "id": str(rate.id),
                "hourlyRateCents": rate.hourly_rate_cents,
                "effectiveFrom": rate.effective_from.isoformat(),
            }
            for rate in rates
        ],
    }


def time_entry_json(row: TimeEntry) -> JsonObject:
    return {
        "id": str(row.id),
        "employeeId": str(row.employee_id),
        "employeeName": row.employee.name,
        "clockIn": iso(row.clock_in),
        "clockOut": iso(row.clock_out),
        "paidSeconds": row.paid_seconds,
        "unpaidBreakSeconds": row.unpaid_break_seconds,
        "breakSeconds": row.break_seconds,
        "timeAdjustmentSeconds": row.time_adjustment_seconds,
        "earningsAdjustmentCents": row.earnings_adjustment_cents,
        "hourlyRateCents": row.hourly_rate_cents,
        "laborCostCents": row.labor_cost_cents,
        "comment": row.comment,
        "importId": str(row.labor_import_id),
        "importTimezone": row.labor_import.timezone,
    }
