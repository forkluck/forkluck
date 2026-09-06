"""Workspace read endpoints.

Plain view functions: the internal-secret guard is applied by
internal_urls.py, so this module never reaches into the dispatch layer.
"""

import uuid
from datetime import datetime, timedelta

from django.db.models import F, Sum
from django.db.models.functions import Lower
from django.http import HttpRequest, JsonResponse
from django.utils import timezone

from ...http.request import error
from ...models import (
    ActivityEvent,
    BenchCostSettings,
    KitchenInvite,
    KitchenMembership,
    TimeEntry,
)
from ..shared.labor_policy import payroll_tax_cents
from ..shared.workspace_timezone import workspace_timezone_name

PAYROLL_AVERAGE_DAYS = 90
ACTIVITY_DEFAULT_LIMIT = 100
ACTIVITY_MAX_LIMIT = 200


def _payroll_average_rate_cents(user, payroll_tax_bps: int) -> int | None:
    """What an hour of paid time actually cost lately, from imported shifts.

    Loaded, not bare: this figure fills the "average labor rate" default,
    which the dialog defines as wage plus payroll taxes and benefits, so the
    employer burden belongs in it. It is divided by *payable* time — hours an
    unpaid meal break took off were never bought, and counting them would
    quote an hour cheaper than any hour the kitchen actually pays for.
    """
    totals = TimeEntry.objects.filter(
        user=user,
        clock_in__gte=timezone.now() - timedelta(days=PAYROLL_AVERAGE_DAYS),
        labor_cost_cents__isnull=False,
    ).aggregate(
        cost=Sum("labor_cost_cents"),
        seconds=Sum(F("paid_seconds") - F("unpaid_break_seconds")),
    )
    if not totals["seconds"]:
        return None
    loaded = totals["cost"] + payroll_tax_cents(totals["cost"], payroll_tax_bps)
    return round(loaded / totals["seconds"] * 3600)


def _label_region(row: BenchCostSettings) -> str:
    """A stored choice is the answer. A workspace that never chose reads its
    currency: a kitchen billing in pounds or euros labels to UK and EU rules."""
    if row.label_region:
        return row.label_region
    return "eu" if row.currency_code in {"GBP", "EUR"} else "us"


def business_settings(request: HttpRequest) -> JsonResponse:
    row, _ = BenchCostSettings.objects.get_or_create(user=request.user)
    return JsonResponse(
        {
            "wagePerHourCents": row.wage_per_hour_cents,
            "measurementSystem": row.measurement_system,
            "currencyCode": row.currency_code,
            "labelRegion": _label_region(row),
            "foodCostTarget": row.food_cost_target_bps / 10000,
            "overtimeWeeklyMinutes": row.overtime_weekly_minutes,
            # A percent on the wire, basis points in the row: what an employer
            # reads off a rate notice is "9.39%", not 939.
            "payrollTaxPercent": row.payroll_tax_bps / 100,
            "unpaidBreakMinutes": row.unpaid_break_minutes,
            "unpaidBreakPerHours": row.unpaid_break_per_hours,
            "productMatching": row.product_auto_match_enabled,
            "timezone": workspace_timezone_name(request.user),
            "payrollAverageRateCents": _payroll_average_rate_cents(
                request.user, row.payroll_tax_bps
            ),
        }
    )


def kitchen_members(request: HttpRequest) -> JsonResponse:
    """Who has been let into this kitchen, and who has yet to arrive.

    Owner-only by construction: both querysets are scoped to the caller, so a
    member reading this route sees their own kitchen, which is empty until
    they invite someone of their own.
    """
    members = [
        {
            "id": str(row.id),
            "memberId": str(row.member_id),
            "name": row.member.name,
            "email": row.member.email,
            "role": row.role,
        }
        for row in KitchenMembership.objects.filter(owner=request.user)
        .select_related("member")
        .order_by(Lower("member__name"), "id")
    ]
    invites = [
        {"id": str(row.id), "email": row.email, "role": row.role}
        for row in KitchenInvite.objects.filter(owner=request.user).order_by(
            Lower("email"), "id"
        )
    ]
    return JsonResponse({"members": members, "invites": invites})


def _csv_filter(raw: str | None, allowed: tuple[str, ...], label: str) -> list[str]:
    if raw is None:
        return []
    values = [part.strip() for part in raw.split(",") if part.strip()]
    if any(value not in allowed for value in values):
        raise ValueError(f"Invalid {label}")
    return values


def activity(request: HttpRequest) -> JsonResponse:
    """The workspace log, newest first, paged by an exclusive `before` cursor."""
    raw_limit = request.GET.get("limit")
    try:
        limit = int(raw_limit) if raw_limit is not None else ACTIVITY_DEFAULT_LIMIT
    except ValueError:
        return error("Invalid limit")
    if limit < 1:
        return error("Invalid limit")
    limit = min(limit, ACTIVITY_MAX_LIMIT)
    raw_before = request.GET.get("before")
    before = None
    if raw_before is not None:
        try:
            before = datetime.fromisoformat(raw_before)
        except ValueError:
            return error("Invalid before")
        if timezone.is_naive(before):
            before = timezone.make_aware(before)
    try:
        events = _csv_filter(request.GET.get("events"), ActivityEvent.EVENTS, "events")
        types = _csv_filter(
            request.GET.get("types"), ActivityEvent.RESOURCE_TYPES, "types"
        )
    except ValueError as exc:
        return error(str(exc))

    raw_resource = request.GET.get("resourceId")
    resource_id = None
    if raw_resource is not None:
        try:
            resource_id = uuid.UUID(raw_resource)
        except ValueError:
            return error("Invalid resourceId")

    rows = ActivityEvent.objects.filter(user=request.user)
    # After the user scope, never instead of it: an id is not authorization,
    # so one workspace's log never answers for another's resource.
    if resource_id is not None:
        rows = rows.filter(resource_id=resource_id)
    if before is not None:
        rows = rows.filter(created_at__lt=before)
    if events:
        rows = rows.filter(event__in=events)
    if types:
        rows = rows.filter(resource_type__in=types)
    items = list(rows[:limit])
    return JsonResponse(
        {
            "items": [
                {
                    "id": str(row.id),
                    "actorName": row.actor_name,
                    "resourceType": row.resource_type,
                    "resourceId": str(row.resource_id) if row.resource_id else None,
                    "event": row.event,
                    "name": row.name,
                    "context": row.context,
                    "createdAt": row.created_at.isoformat(),
                }
                for row in items
            ],
            "nextBefore": (
                items[-1].created_at.isoformat() if len(items) == limit else None
            ),
        }
    )
