"""Resolving a wall-clock time in a timezone, including the two DST edges.

A local date and time with no offset does not always name exactly one instant:

- During the spring-forward gap the time never happens. 02:30 on a US
  spring-forward Sunday does not exist; a row carrying it is a source-data
  fault, so it is rejected and the operator is told which value to fix.

- During the fall-back overlap the time happens twice. 01:30 on a US fall-back
  Sunday occurs once before the clocks change and once after, an hour apart.
  Python resolves this with the `fold` attribute, and `replace(tzinfo=...)`
  silently leaves it at 0 — a real choice, made by accident.

This module makes that choice deliberate: **the first occurrence wins**. It is
the pre-transition instant, it matches how timeclock and POS exports order
their rows, and it is stable — the same input always yields the same instant,
which matters because import fingerprints are derived from these values and a
drifting resolution would turn re-imports into duplicates.

The first occurrence is also the conservative one for payroll. Durations come
from the source file's own paid-seconds field rather than being computed from
these timestamps, so the fold choice moves when a shift is recorded, never how
long it is judged to be.

A leaf module: it knows datetimes and nothing about domains.
"""

from datetime import datetime
from zoneinfo import ZoneInfo


def is_ambiguous(naive: datetime, zone: ZoneInfo) -> bool:
    """True when this wall-clock time happens twice in `zone` (fall-back).

    `fold` changes the resolved offset at *both* transitions, so a differing
    offset alone does not distinguish an overlap from a gap. A gap time happens
    zero times rather than twice, and is excluded here.
    """
    if is_nonexistent(naive, zone):
        return False
    return naive.replace(tzinfo=zone, fold=0).utcoffset() != naive.replace(
        tzinfo=zone, fold=1
    ).utcoffset()


def is_nonexistent(naive: datetime, zone: ZoneInfo) -> bool:
    """True when this wall-clock time never happens in `zone` (spring-forward).

    A time inside the gap survives the round trip through UTC as some *other*
    wall-clock time, because the offset it was interpreted with is not the one
    in force. Comparing the round trip against the input is what detects it.
    """
    aware = naive.replace(tzinfo=zone)
    round_trip = aware.astimezone(ZoneInfo("UTC")).astimezone(zone)
    return round_trip.replace(tzinfo=None) != naive


def resolve_local(naive: datetime, zone: ZoneInfo, label: str) -> datetime:
    """Attach `zone` to a naive wall-clock time under the documented policy.

    Raises ValueError for a time in the spring-forward gap. Ambiguous
    fall-back times resolve to the first (pre-transition) occurrence.

    Raises ValueError for a wall-clock time whose offset conversion would fall
    outside `datetime`'s year 1..9999 range — an instant within a day of either
    boundary shifts past it in a zone offset the wrong way. That is a
    source-data fault the operator can fix, so it must reach the client as a
    rejected value rather than an OverflowError the action funnel would turn
    into a 500.
    """
    try:
        gap = is_nonexistent(naive, zone)
    except OverflowError as exc:
        raise ValueError(f"{label} is outside the supported date range") from exc
    if gap:
        raise ValueError(f"{label} falls in a daylight-saving time gap")
    # fold=0 explicitly: the same value replace() would leave, stated so the
    # policy is visible at the point it is applied.
    return naive.replace(tzinfo=zone, fold=0)
