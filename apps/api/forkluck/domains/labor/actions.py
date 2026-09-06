"""Labor mutations: timesheet import, hourly rates, undo."""

import hashlib
import json
import uuid
from collections.abc import Callable
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.db import transaction
from django.utils import timezone

from ...models import (
    BenchCostSettings,
    Employee,
    EmployeeHourlyRate,
    LaborImport,
    TimeEntry,
    User,
)
from ..shared.activity import record_event
from ..shared.labor_policy import (
    labor_cost_cents,
    policy_of,
    recalculate_employee_time_entries,
    refresh_labor_import_totals,
    unpaid_break_seconds_for,
)
from ..shared.locking import lock_workspace
from ..shared.localtime import resolve_local
from ..shared.values import (
    import_date_value,
    int_value,
    text_value,
    uuid_value,
)
from .serializers import employee_rate_on, normalize_employee_name

JsonObject = dict[str, Any]


def validate_expected_currency(user: User, body: JsonObject) -> BenchCostSettings:
    """Guard the currency, and hand back the row the guard had to read.

    Every write here follows this check with a need for the same workspace
    settings — the break rule a shift is costed under. Returning the row keeps
    that free: re-reading it would put a second query inside a costing loop
    whose budget is pinned.
    """
    expected = text_value(
        body.get("expectedCurrencyCode"), "Expected currency", max_length=3
    ).upper()
    settings, _ = BenchCostSettings.objects.get_or_create(user=user)
    if settings.currency_code != expected:
        raise ValueError(
            "Currency settings changed in another window. Refresh and try again."
        )
    return settings


def labor_timezone(value: Any) -> ZoneInfo:
    name = text_value(value, "Timezone", max_length=64).strip()
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("Timezone is not recognized") from exc


def labor_local_datetime(value: Any, label: str, zone: ZoneInfo) -> datetime:
    raw = text_value(value, label, max_length=32).strip()
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"{label} is not a valid date and time") from exc
    if parsed.tzinfo is not None:
        # An offset-carrying value within a day of year 1 or 9999 can convert
        # past datetime's range; keep that a user-fixable ValueError rather
        # than an OverflowError the action funnel would surface as a 500.
        try:
            return parsed.astimezone(zone)
        except OverflowError as exc:
            raise ValueError(
                f"{label} is outside the supported date range"
            ) from exc
    return resolve_local(parsed, zone, label)


def time_entry_fingerprint(
    normalized_name: str,
    clock_in: datetime,
    clock_out: datetime,
    paid_seconds: int,
    break_seconds: int,
    time_adjustment_seconds: int,
    earnings_adjustment_cents: int,
) -> str:
    utc = ZoneInfo("UTC")
    canonical = json.dumps(
        [
            normalized_name,
            clock_in.astimezone(utc).isoformat(),
            clock_out.astimezone(utc).isoformat(),
            paid_seconds,
            break_seconds,
            time_adjustment_seconds,
            earnings_adjustment_cents,
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def safe_source_payload(value: Any) -> JsonObject:
    if not isinstance(value, dict) or len(value) > 100:
        raise ValueError("Source row looks malformed")
    result: JsonObject = {}
    for key, cell_value in value.items():
        if not isinstance(key, str) or not isinstance(cell_value, str):
            raise ValueError("Source row looks malformed")
        if len(key) > 200 or len(cell_value) > 2000:
            raise ValueError("Source row is too large")
        result[key] = cell_value
    return result


def action_labor_import_status(user: User, body: JsonObject) -> JsonObject:
    people = body.get("people")
    if not isinstance(people, list) or len(people) > 500:
        raise ValueError("Employee list looks malformed")
    requested: list[tuple[str, date]] = []
    for person in people:
        if not isinstance(person, dict):
            raise ValueError("Employee list looks malformed")
        name = text_value(person.get("name"), "Employee", max_length=150).strip()
        effective_on = import_date_value(person.get("effectiveOn"), "Shift date")
        if effective_on is None:
            raise ValueError("Shift date is required")
        requested.append((normalize_employee_name(name), effective_on))
    employees = {
        row.normalized_name: row
        for row in Employee.objects.filter(
            user=user, normalized_name__in=[name for name, _ in requested]
        ).prefetch_related("hourly_rates")
    }
    items = []
    for normalized_name, effective_on in requested:
        employee = employees.get(normalized_name)
        rate = employee_rate_on(employee, effective_on) if employee else None
        items.append(
            {
                "normalizedName": normalized_name,
                "employeeId": str(employee.id) if employee else None,
                "hourlyRateCents": rate.hourly_rate_cents if rate else None,
                "rateEffectiveFrom": (
                    rate.effective_from.isoformat() if rate else None
                ),
            }
        )
    return {"items": items}


def _apply_import_rates(
    labor_import: LaborImport,
    employees: dict[str, Employee],
    rate_values: dict[str, tuple[int, date]],
) -> None:
    """Upsert the rates a labor file declares, in two queries rather than one
    update_or_create per rate.

    A rate the file restates keeps its original source_import: only the rate
    that a file first created is attributed to it, which is what the per-row
    version did by setting source_import solely on the created branch.
    """
    wanted = {
        (employees[name].id, effective_from): cents
        for name, (cents, effective_from) in rate_values.items()
        if name in employees
    }
    if not wanted:
        return

    existing = {
        (rate.employee_id, rate.effective_from): rate
        for rate in EmployeeHourlyRate.objects.filter(
            employee__in=[employees[name] for name in rate_values if name in employees],
            effective_from__in={key[1] for key in wanted},
        )
    }

    updated = []
    changed_at = timezone.now()
    for key, cents in wanted.items():
        rate = existing.get(key)
        if rate is not None and rate.hourly_rate_cents != cents:
            rate.hourly_rate_cents = cents
            rate.updated_at = changed_at
            updated.append(rate)
    if updated:
        EmployeeHourlyRate.objects.bulk_update(
            updated, ["hourly_rate_cents", "updated_at"], batch_size=500
        )

    created = [
        EmployeeHourlyRate(
            employee_id=employee_id,
            effective_from=effective_from,
            hourly_rate_cents=cents,
            source_import=labor_import,
        )
        for (employee_id, effective_from), cents in wanted.items()
        if (employee_id, effective_from) not in existing
    ]
    if created:
        EmployeeHourlyRate.objects.bulk_create(created, batch_size=500)


def action_import_labor(user: User, body: JsonObject) -> JsonObject:
    entries = body.get("entries")
    rates = body.get("rates", [])
    if (
        not isinstance(entries, list)
        or not entries
        or len(entries) > 5000
        or not isinstance(rates, list)
        or len(rates) > 500
    ):
        raise ValueError("Labor import data looks malformed")
    file_name = text_value(
        body.get("fileName"), "File name", max_length=255
    ).strip()
    source = text_value(
        body.get("source", "csv"), "Source", max_length=32
    ).strip().lower()
    zone = labor_timezone(body.get("timezone"))
    mapping = body.get("mapping")
    if not isinstance(mapping, dict) or len(mapping) > 20:
        raise ValueError("Column mapping looks malformed")
    total_rows = int_value(
        body.get("totalRows"), "Total rows", minimum=1, maximum=1000000
    )
    skipped_count = int_value(
        body.get("skippedCount", 0),
        "Skipped rows",
        minimum=0,
        maximum=1000000,
    )
    excluded_count = int_value(
        body.get("excludedCount", 0),
        "Excluded rows",
        minimum=0,
        maximum=1000000,
    )

    parsed_entries: list[JsonObject] = []
    positions: set[int] = set()
    for raw_entry in entries:
        if not isinstance(raw_entry, dict):
            raise ValueError("Labor import row looks malformed")
        position = int_value(
            raw_entry.get("position"), "Row number", minimum=1, maximum=1000000
        )
        if position in positions:
            raise ValueError("Labor import has duplicate row numbers")
        positions.add(position)
        employee_name = text_value(
            raw_entry.get("employeeName"), "Employee", max_length=150
        ).strip()
        normalized_name = normalize_employee_name(employee_name)
        clock_in = labor_local_datetime(
            raw_entry.get("clockInLocal"), "Clock in", zone
        )
        clock_out = labor_local_datetime(
            raw_entry.get("clockOutLocal"), "Clock out", zone
        )
        if clock_out <= clock_in:
            raise ValueError("Clock out must be after clock in")
        paid_seconds = int_value(
            raw_entry.get("paidSeconds"),
            "Paid duration",
            minimum=1,
            maximum=604800,
        )
        break_seconds = int_value(
            raw_entry.get("breakSeconds", 0),
            "Break duration",
            minimum=0,
            maximum=604800,
        )
        time_adjustment_seconds = int_value(
            raw_entry.get("timeAdjustmentSeconds", 0),
            "Time adjustment",
            minimum=-604800,
            maximum=604800,
        )
        earnings_adjustment_cents = int_value(
            raw_entry.get("earningsAdjustmentCents", 0),
            "Earnings adjustment",
            minimum=-100000000,
            maximum=100000000,
        )
        comment = text_value(
            raw_entry.get("comment", ""),
            "Comment",
            max_length=500,
            allow_blank=True,
        ).strip()
        fingerprint = time_entry_fingerprint(
            normalized_name,
            clock_in,
            clock_out,
            paid_seconds,
            break_seconds,
            time_adjustment_seconds,
            earnings_adjustment_cents,
        )
        parsed_entries.append(
            {
                "position": position,
                "employee_name": employee_name,
                "normalized_name": normalized_name,
                "clock_in": clock_in,
                "clock_out": clock_out,
                "paid_seconds": paid_seconds,
                "break_seconds": break_seconds,
                "time_adjustment_seconds": time_adjustment_seconds,
                "earnings_adjustment_cents": earnings_adjustment_cents,
                "comment": comment,
                "fingerprint": fingerprint,
                "source_payload": safe_source_payload(raw_entry.get("raw")),
            }
        )

    rate_values: dict[str, tuple[int, date]] = {}
    for raw_rate in rates:
        if not isinstance(raw_rate, dict):
            raise ValueError("Hourly rate looks malformed")
        name = text_value(
            raw_rate.get("employeeName"), "Employee", max_length=150
        ).strip()
        cents = int_value(
            raw_rate.get("hourlyRateCents"),
            "Hourly rate",
            minimum=0,
            maximum=100000000,
        )
        effective_from = import_date_value(
            raw_rate.get("effectiveFrom"), "Effective date"
        )
        if effective_from is None:
            raise ValueError("Effective date is required")
        rate_values[normalize_employee_name(name)] = (cents, effective_from)

    period_dates = [entry["clock_in"].astimezone(zone).date() for entry in parsed_entries]
    fingerprints = [entry["fingerprint"] for entry in parsed_entries]
    existing_fingerprints = set(
        TimeEntry.objects.filter(
            user=user, source_fingerprint__in=fingerprints
        ).values_list("source_fingerprint", flat=True)
    )

    with transaction.atomic():
        # Same workspace lock the undo takes, so a second import cannot land
        # between an undo's newest-active check and its deletes.
        lock_workspace(user)
        # Read under the workspace lock, so shifts land costed against the
        # same break rule a concurrent settings save would recost them to.
        policy = policy_of(validate_expected_currency(user, body))
        labor_import = LaborImport.objects.create(
            user=user,
            file_name=file_name,
            source=source,
            timezone=zone.key,
            mapping=mapping,
            period_start=min(period_dates),
            period_end=max(period_dates),
            total_rows=total_rows,
            skipped_count=skipped_count,
            excluded_count=excluded_count,
        )
        # Staged rather than row-by-row. This endpoint accepts up to 5,000
        # entries, and the previous shape ran get_or_create per employee,
        # update_or_create per rate, a rate lookup per entry (employee_rate_on
        # falls back to a query whenever rates are not prefetched, and nothing
        # here prefetched them), and one INSERT per entry — so query count grew
        # linearly with the file.
        normalized_names = {entry["normalized_name"] for entry in parsed_entries}

        existing_employees = {
            employee.normalized_name: employee
            for employee in Employee.objects.select_for_update().filter(
                user=user, normalized_name__in=normalized_names
            )
        }
        first_seen = {}
        for entry in parsed_entries:
            first_seen.setdefault(entry["normalized_name"], entry["employee_name"])

        new_employees = [
            Employee(
                user=user,
                normalized_name=name,
                name=first_seen[name],
                created_by_import=labor_import,
            )
            for name in normalized_names
            if name not in existing_employees
        ]
        if new_employees:
            Employee.objects.bulk_create(new_employees, batch_size=500)
        employees: dict[str, Employee] = {
            **existing_employees,
            **{employee.normalized_name: employee for employee in new_employees},
        }
        created_employee_count = len(new_employees)

        # An archived employee back on the schedule would otherwise accrue
        # hours nobody can see.
        reactivated = [
            employee
            for employee in existing_employees.values()
            if not employee.is_active
        ]
        for employee in reactivated:
            employee.is_active = True
            employee.reactivated_by_import = labor_import
            employee.updated_at = timezone.now()
        if reactivated:
            Employee.objects.bulk_update(
                reactivated,
                ["is_active", "reactivated_by_import", "updated_at"],
                batch_size=500,
            )

        _apply_import_rates(labor_import, employees, rate_values)

        # Every rate history for the employees in this file, in the order
        # employee_rate_on expects, so resolution below is pure memory.
        rates_by_employee: dict[uuid.UUID, list[EmployeeHourlyRate]] = {}
        for rate in EmployeeHourlyRate.objects.filter(
            employee__in=employees.values()
        ).order_by("-effective_from", "-created_at"):
            rates_by_employee.setdefault(rate.employee_id, []).append(rate)

        duplicate_count = 0
        seen_fingerprints = set(existing_fingerprints)
        pending: list[TimeEntry] = []
        total_seconds = 0
        total_labor_cost_cents = 0
        uncosted_count = 0
        for entry in parsed_entries:
            fingerprint = entry["fingerprint"]
            if fingerprint in seen_fingerprints:
                duplicate_count += 1
                continue
            seen_fingerprints.add(fingerprint)
            employee = employees[entry["normalized_name"]]
            effective_on = entry["clock_in"].astimezone(zone).date()
            rate = next(
                (
                    candidate
                    for candidate in rates_by_employee.get(employee.id, ())
                    if candidate.effective_from <= effective_on
                ),
                None,
            )
            rate_cents = rate.hourly_rate_cents if rate else None
            unpaid_break = unpaid_break_seconds_for(entry["paid_seconds"], policy)
            cost_cents = (
                labor_cost_cents(
                    entry["paid_seconds"] - unpaid_break,
                    rate_cents,
                    entry["earnings_adjustment_cents"],
                )
                if rate_cents is not None
                else None
            )
            # Clocked time, not payable: the import's hours stay what the
            # timesheet said, and the deduction shows beside them.
            total_seconds += entry["paid_seconds"]
            if cost_cents is None:
                uncosted_count += 1
            else:
                total_labor_cost_cents += cost_cents
            pending.append(
                TimeEntry(
                    user=user,
                    employee=employee,
                    labor_import=labor_import,
                    source_position=entry["position"],
                    source_fingerprint=fingerprint,
                    clock_in=entry["clock_in"],
                    clock_out=entry["clock_out"],
                    paid_seconds=entry["paid_seconds"],
                    unpaid_break_seconds=unpaid_break,
                    break_seconds=entry["break_seconds"],
                    time_adjustment_seconds=entry["time_adjustment_seconds"],
                    earnings_adjustment_cents=entry["earnings_adjustment_cents"],
                    hourly_rate_cents=rate_cents,
                    labor_cost_cents=cost_cents,
                    comment=entry["comment"],
                    source_payload=entry["source_payload"],
                )
            )
        if pending:
            TimeEntry.objects.bulk_create(pending, batch_size=500)

        # Totals come from the entries just accepted, so the import does not
        # re-read what it has in hand. refresh_labor_import_totals stays for
        # the paths that change entries after the fact (rate edits, undo).
        labor_import.created_employee_count = created_employee_count
        labor_import.duplicate_count = duplicate_count
        labor_import.imported_count = len(pending)
        labor_import.total_seconds = total_seconds
        labor_import.total_labor_cost_cents = total_labor_cost_cents
        labor_import.uncosted_count = uncosted_count
        labor_import.save(
            update_fields=[
                "created_employee_count",
                "duplicate_count",
                "imported_count",
                "total_seconds",
                "total_labor_cost_cents",
                "uncosted_count",
                "updated_at",
            ]
        )
    record_event(
        user,
        user,
        "import",
        "imported",
        resource_id=labor_import.id,
        name=labor_import.file_name,
        kind="labor",
        imported=labor_import.imported_count,
        createdEmployees=labor_import.created_employee_count,
        duplicates=labor_import.duplicate_count,
    )
    return {
        "batchId": str(labor_import.id),
        "imported": labor_import.imported_count,
        "createdEmployees": labor_import.created_employee_count,
        "duplicates": labor_import.duplicate_count,
        "skipped": labor_import.skipped_count,
        "excluded": labor_import.excluded_count,
        "totalSeconds": labor_import.total_seconds,
        "totalLaborCostCents": labor_import.total_labor_cost_cents,
        "uncosted": labor_import.uncosted_count,
    }


def action_set_employee_rate(user: User, body: JsonObject) -> JsonObject:
    employee_id = uuid_value(body.get("employeeId"), "employee id")
    cents = int_value(
        body.get("hourlyRateCents"),
        "Hourly rate",
        minimum=0,
        maximum=100000000,
    )
    effective_from = import_date_value(
        body.get("effectiveFrom"), "Effective date"
    )
    if effective_from is None:
        raise ValueError("Effective date is required")
    with transaction.atomic():
        lock_workspace(user)
        validate_expected_currency(user, body)
        # Imports lock the same Employee rows before their staged rate upsert.
        # Sharing that lock prevents a manual rate edit from landing between
        # the import's existing-rate read and its bulk update/create.
        employee = (
            Employee.objects.select_for_update()
            .filter(user=user, id=employee_id)
            .first()
        )
        if employee is None:
            raise ValueError("Employee not found")
        EmployeeHourlyRate.objects.update_or_create(
            employee=employee,
            effective_from=effective_from,
            defaults={"hourly_rate_cents": cents, "source_import": None},
        )
        recalculate_employee_time_entries(employee)
    return {"ok": True}


def action_set_time_entry_rate(user: User, body: JsonObject) -> JsonObject:
    entry_id = uuid_value(body.get("entryId"), "time entry id")
    cents = int_value(
        body.get("hourlyRateCents"),
        "Hourly rate",
        minimum=0,
        maximum=100000000,
    )
    with transaction.atomic():
        lock_workspace(user)
        policy = policy_of(validate_expected_currency(user, body))
        # `of` restricts the lock to the shift row itself. An unqualified
        # FOR UPDATE over this join would also lock the joined LaborImport row,
        # in an order the query planner picks, which could invert the
        # TimeEntry-then-LaborImport order the recalculation path uses and
        # deadlock against it. The import row is locked explicitly below, by
        # refresh_labor_import_totals, after the shift row is held.
        entry = (
            TimeEntry.objects.select_for_update(of=("self",))
            .select_related("labor_import")
            .filter(
                user=user,
                employee__user=user,
                labor_import__user=user,
                id=entry_id,
            )
            .first()
        )
        if entry is None:
            raise ValueError("Time entry not found")
        entry.hourly_rate_override_cents = cents
        entry.hourly_rate_cents = cents
        # An override sets the rate, never the hours: the unpaid break the
        # policy already took off this shift is re-derived rather than
        # trusted, so a shift edited after a policy change is not the one
        # row left costing on the old rule.
        entry.unpaid_break_seconds = unpaid_break_seconds_for(
            entry.paid_seconds, policy
        )
        entry.labor_cost_cents = labor_cost_cents(
            entry.paid_seconds - entry.unpaid_break_seconds,
            cents,
            entry.earnings_adjustment_cents,
        )
        entry.save(
            update_fields=[
                "hourly_rate_override_cents",
                "hourly_rate_cents",
                "unpaid_break_seconds",
                "labor_cost_cents",
                "updated_at",
            ]
        )
        refresh_labor_import_totals(entry.labor_import)
    return {"ok": True, "employeeId": str(entry.employee_id)}


def action_set_employee_active(user: User, body: JsonObject) -> JsonObject:
    employee = Employee.objects.filter(
        user=user, id=uuid_value(body.get("employeeId"), "employee id")
    ).first()
    if employee is None:
        raise ValueError("Employee not found")
    is_active = body.get("isActive")
    if not isinstance(is_active, bool):
        raise ValueError("Active state must be true or false")
    employee.is_active = is_active
    # A chosen active state outlives the import that happened to set it, so an
    # undo must not overwrite it with the state from before that import.
    employee.reactivated_by_import = None
    employee.save(
        update_fields=["is_active", "reactivated_by_import", "updated_at"]
    )
    return {"ok": True, "isActive": employee.is_active}


def action_set_employee_excluded_from_cost(
    user: User, body: JsonObject
) -> JsonObject:
    employee = Employee.objects.filter(
        user=user, id=uuid_value(body.get("employeeId"), "employee id")
    ).first()
    if employee is None:
        raise ValueError("Employee not found")
    excluded = body.get("excludedFromCost")
    if not isinstance(excluded, bool):
        raise ValueError("Excluded state must be true or false")
    employee.excluded_from_cost = excluded
    employee.save(update_fields=["excluded_from_cost", "updated_at"])
    return {"ok": True, "excludedFromCost": employee.excluded_from_cost}


def action_undo_labor_import(user: User, body: JsonObject) -> JsonObject:
    import_id = uuid_value(body.get("id"), "labor import id")
    # The newest-active check has to hold until the undo commits. Read outside
    # the transaction it could pass, a second import could land, and this undo
    # would then delete entries with a newer import still sitting on top.
    with transaction.atomic():
        lock_workspace(user)

        labor_import = LaborImport.objects.filter(user=user, id=import_id).first()
        if labor_import is None:
            raise ValueError("Labor import not found")
        if labor_import.undone_at is not None:
            raise ValueError("This labor import was already undone")
        latest_active = LaborImport.objects.filter(
            user=user, undone_at__isnull=True
        ).first()
        if latest_active is None or latest_active.id != labor_import.id:
            raise ValueError("Only the newest active labor import can be undone")

        # Rate edits and recalculations lock TimeEntry before LaborImport. Take
        # the same locks in the same order here so an undo cannot deadlock with
        # either path. The workspace lock above already serializes import and
        # undo lifecycle checks; the import row is re-read once both row types
        # are locked so deletion uses current state.
        locked_entries = list(
            labor_import.time_entries.select_for_update(of=("self",))
            .order_by("clock_in", "id")
        )
        labor_import = (
            LaborImport.objects.select_for_update()
            .filter(user=user, id=import_id)
            .first()
        )
        if labor_import is None:
            raise ValueError("Labor import not found")

        deleted_entries = len(locked_entries)
        labor_import.time_entries.all().delete()
        deleted_employees = 0
        retained_employees = 0
        for employee in labor_import.created_employees.all():
            if employee.time_entries.exists() or employee.hourly_rates.exists():
                retained_employees += 1
            else:
                employee.delete()
                deleted_employees += 1
        # Nothing that survives the undo justifies these employees being on the
        # schedule: the import that took them off the archive is gone.
        for employee in labor_import.reactivated_employees.all():
            employee.is_active = False
            employee.reactivated_by_import = None
            employee.save(
                update_fields=["is_active", "reactivated_by_import", "updated_at"]
            )
        labor_import.undone_at = timezone.now()
        labor_import.save(update_fields=["undone_at", "updated_at"])
    return {
        "ok": True,
        "deletedEntries": deleted_entries,
        "deletedEmployees": deleted_employees,
        "retainedEmployees": retained_employees,
    }


# Slugs this module answers for, composed into the one action route by
# forkluck/http/dispatch.py.
ACTIONS: dict[str, Callable[[User, JsonObject], JsonObject]] = {
    "labor-import-status": action_labor_import_status,
    "import-labor": action_import_labor,
    "set-employee-active": action_set_employee_active,
    "set-employee-excluded-from-cost": action_set_employee_excluded_from_cost,
    "set-employee-rate": action_set_employee_rate,
    "set-time-entry-rate": action_set_time_entry_rate,
    "undo-labor-import": action_undo_labor_import,
}
