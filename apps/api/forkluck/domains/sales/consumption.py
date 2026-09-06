"""Canonical daily physical consumption for tracked sales.

This module is the read-only seam between the sales ledger and planning.  It
does not repeat variant, bundle, modifier, attribution, or return rules:
``interpret_line`` supplies those product contributions.  The result is
grouped by product, the workspace-local business day, ledger channel, and
contribution source (``base``, ``bundle`` or ``modifier``).

Rows intentionally contain physical quantities only.  Revenue attribution is
an independent view of the source financial line and must not be smuggled into
consumption or used to scale it.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timezone as datetime_timezone
from decimal import Decimal
from typing import Any, Collection

from django.db.models import Prefetch

from ...models import (
    SalesLine,
    SalesLineModifier,
    User,
)
from ..shared.workspace_timezone import workspace_zone
from .bundles import BundleIndex
from .core import interpret_line


DailyProductConsumption = dict[str, Any]


def _workspace_window(
    start: date, end: date, timezone_name
) -> tuple[datetime, datetime]:
    """Translate inclusive workspace dates into a UTC half-open window."""
    window_start = datetime.combine(start, time.min, tzinfo=timezone_name)
    window_end = datetime.combine(
        end + date.resolution, time.min, tzinfo=timezone_name
    )
    return (
        window_start.astimezone(datetime_timezone.utc),
        window_end.astimezone(datetime_timezone.utc),
    )


def daily_product_consumption_rows(
    user: User,
    start: date,
    end: date,
    product_ids: Collection[Any] | None = None,
) -> list[DailyProductConsumption]:
    """Return canonical physical product consumption for an inclusive period.

    ``start`` and ``end`` are business dates in the workspace timezone.  A
    row is emitted for each ``productId × soldOn × channel × source`` key;
    ``source`` is ``base`` for the variant's own product, ``bundle`` for a
    product reached inside a bundle, and ``modifier`` for a mapped modifier
    occurrence.  Negative quantities remain negative, so returns reverse the
    same physical consumption they reverse in the ledger.

    ``product_ids`` filters contributions after interpretation.  This is
    deliberate: filtering source lines by their direct product would drop a
    bundle member or a mapped modifier whose product is only reached through
    what the sold product contains.
    """
    if end < start:
        raise ValueError("Consumption end date must not precede its start date")

    wanted = None if product_ids is None else {str(product_id) for product_id in product_ids}
    if wanted == set():
        return []

    zone = workspace_zone(user)
    window_start, window_end = _workspace_window(start, end, zone)
    index = BundleIndex.for_user(user)
    modifier_queryset = SalesLineModifier.objects.filter(
        user=user,
        sales_line__user=user,
        variant__user=user,
    ).select_related("variant", "variant__product")
    lines = (
        SalesLine.objects.filter(
            user=user,
            sales_import__undone_at__isnull=True,
            variant__isnull=False,
            variant__user=user,
            sold_at__gte=window_start,
            sold_at__lt=window_end,
        )
        .select_related("variant", "variant__product")
        .prefetch_related(Prefetch("modifiers", queryset=modifier_queryset))
        .order_by("sold_at", "id")
    )

    grouped: defaultdict[tuple[str, date, str, str], Decimal] = defaultdict(
        lambda: Decimal("0")
    )
    for line in lines:
        sold_on = line.sold_at.astimezone(zone).date()
        for contribution in interpret_line(line, index=index):
            product_id = str(contribution.product.id)
            if contribution.product.user_id != user.pk:
                continue
            if wanted is not None and product_id not in wanted:
                continue
            # A modifier stays a modifier however it was reached; a base
            # contribution that arrived inside a box says so.
            source = (
                "bundle"
                if contribution.via_bundle and contribution.source == "base"
                else contribution.source
            )
            grouped[
                (product_id, sold_on, line.channel, source)
            ] += contribution.quantity

    return [
        {
            "productId": product_id,
            "soldOn": sold_on.isoformat(),
            "channel": channel,
            "source": source,
            "quantity": quantity,
        }
        for product_id, sold_on, channel, source in sorted(grouped)
        for quantity in (grouped[(product_id, sold_on, channel, source)],)
    ]
