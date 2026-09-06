"""The one zone a workspace reports in."""

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ...models import BenchCostSettings, SalesLine, TimeEntry

DEFAULT_TIMEZONE = "UTC"


def known_zone(name: str | None) -> ZoneInfo | None:
    """The zone by that name, or None for one this build cannot resolve."""
    if not name:
        return None
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return None


def _stored(user) -> str | None:
    return (
        BenchCostSettings.objects.filter(user=user)
        .values_list("timezone", flat=True)
        .first()
    )


def _newest_sale(user) -> str | None:
    return SalesLine.objects.filter(user=user).values_list("timezone", flat=True).first()


def _newest_shift(user) -> str | None:
    return (
        TimeEntry.objects.filter(user=user)
        .values_list("labor_import__timezone", flat=True)
        .first()
    )


def workspace_timezone_name(user) -> str:
    """The stored choice, else the newest sale, else the newest shift, else UTC."""
    for source in (_stored, _newest_sale, _newest_shift):
        name = source(user)
        if known_zone(name) is not None:
            return str(name)
    return DEFAULT_TIMEZONE


def workspace_zone(user) -> ZoneInfo:
    return ZoneInfo(workspace_timezone_name(user))
