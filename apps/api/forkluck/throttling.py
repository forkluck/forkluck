"""Fixed-window throttling for authentication and credential endpoints.

Most of these endpoints run before a user is established, and often for
addresses that do not exist. Password change has a user but also needs a
client-address budget. Each call therefore takes a row lock on the (scope, key)
counter itself, so the read and increment are one step — a plain
count-then-insert lets concurrent requests both observe the same under-limit
count and both proceed.

Callers throttle on more than one key (normalized identity *and* client IP), so
one attacker cannot spread an attack across addresses, and one address cannot
be locked out by an attacker from elsewhere.
"""

import hashlib
from datetime import timedelta

from django.db import IntegrityError, transaction
from django.utils import timezone

from .models import AuthThrottle


class Throttled(Exception):
    """The caller exceeded a limit. The message is safe to show a user."""


# Retained windows are short; anything older is dead weight and is swept
# opportunistically rather than by a scheduled job.
SWEEP_AFTER = timedelta(days=1)


def client_ip(request) -> str:
    """The peer address, as seen by our own nginx.

    nginx *overwrites* X-Real-IP with $remote_addr for the locations that
    proxy to Django, so a client-supplied header cannot forge it.
    X-Forwarded-For is deliberately not used: nginx appends to it, leaving a
    client-controlled prefix. Falls back to REMOTE_ADDR when Django is reached
    directly, as in development and tests.
    """
    return (
        request.META.get("HTTP_X_REAL_IP")
        or request.META.get("REMOTE_ADDR")
        or "unknown"
    )


def _bucket_key(value: str) -> str:
    """Hash the key so email addresses are not stored a second time in the
    clear, and so an over-long value cannot overflow the column."""
    return hashlib.sha256(value.strip().lower().encode()).hexdigest()


def hit(scope: str, value: str, *, limit: int, window: timedelta, message: str) -> None:
    """Count one attempt against (scope, value); raise Throttled past `limit`.

    The window is fixed, not sliding: the first attempt starts it and it resets
    once `window` has elapsed. Attempts are counted even when they later
    succeed, so a caller that wants successes to be free must not call this.
    """
    key = _bucket_key(value)
    now = timezone.now()
    with transaction.atomic():
        try:
            row = AuthThrottle.objects.select_for_update().get(scope=scope, key=key)
        except AuthThrottle.DoesNotExist:
            try:
                with transaction.atomic():
                    AuthThrottle.objects.create(
                        scope=scope, key=key, count=1, window_start=now
                    )
                return
            except IntegrityError:
                # Another request created the row between the SELECT and the
                # INSERT; fall through and take its lock instead.
                row = AuthThrottle.objects.select_for_update().get(
                    scope=scope, key=key
                )

        if now - row.window_start >= window:
            row.count = 1
            row.window_start = now
            row.save(update_fields=["count", "window_start"])
            return

        if row.count >= limit:
            raise Throttled(message)

        row.count += 1
        row.save(update_fields=["count"])


def reset(scope: str, value: str) -> None:
    """Clear a counter, e.g. after a sign-in that actually succeeded."""
    AuthThrottle.objects.filter(scope=scope, key=_bucket_key(value)).delete()


def sweep() -> int:
    """Drop counters whose window is long past. Cheap, so callers run it on
    the rare path (issuing a code) rather than on every attempt."""
    deleted, _ = AuthThrottle.objects.filter(
        window_start__lt=timezone.now() - SWEEP_AFTER
    ).delete()
    return deleted
