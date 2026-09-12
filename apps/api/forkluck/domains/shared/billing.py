"""Whether a workspace is open for business.

Lives here because two layers ask: the action funnel gates every write on it,
and the guest link read gates on the owner's account the same way.
"""

import math
from datetime import UTC, datetime, timedelta
from typing import Any

from django.conf import settings

from ...demo_data import DEMO_EMAIL
from ...models import BillingAccount, User

JsonObject = dict[str, Any]

# camelCase because these ship verbatim in the session JSON; every key is a
# plain on/off feature flag. The trial row is the paid row, because the point
# of a trial is to show the whole product. Expired is read-only and spends
# nothing. Withholding a feature from the trial is a one-key edit here.
PAID_ENTITLEMENTS = {
    "primo": True,
    "posSync": True,
    "connectors": True,
    "usdaSearch": True,
    "catalogSearch": True,
    "invoiceAi": True,
}
TRIAL_ENTITLEMENTS = dict(PAID_ENTITLEMENTS)
EXPIRED_ENTITLEMENTS = {key: False for key in PAID_ENTITLEMENTS}
PLAN_ENTITLEMENTS = {
    "paid": PAID_ENTITLEMENTS,
    "trial": TRIAL_ENTITLEMENTS,
    "expired": EXPIRED_ENTITLEMENTS,
}

# The hosted trial is a calendar window on the account, not a Stripe trial:
# no card, no subscription, no column. Accounts older than the floor start
# their window at the floor, so nobody who signed up before the trial existed
# is expired on the day it ships. Set the floor to the launch date; moving it
# later only ever adds days. Editing `date_joined` in the admin extends one
# account's trial.
TRIAL_DAYS = 14
TRIAL_FLOOR = datetime(2026, 9, 16, tzinfo=UTC)

# trialing is Stripe's own status. It stays paid so a subscription that
# predates the app-side trial keeps working until it converts.
PAID_STATUSES = ("active", "trialing", "past_due")


class EntitlementError(Exception):
    """A feature the caller's plan does not include."""

    def __init__(self, message: str, code: str = "upgrade_required") -> None:
        super().__init__(message)
        self.code = code


def billing_enabled() -> bool:
    return settings.STRIPE_BILLING_ENABLED


def is_paid_status(status: str) -> bool:
    return status in PAID_STATUSES


def trial_ends_at(user: User) -> datetime:
    return max(user.date_joined, TRIAL_FLOOR) + timedelta(days=TRIAL_DAYS)


def current_time() -> datetime:
    """Billing's own clock, deliberately not `timezone.now`.

    A test moves the trial calendar by patching this alone, without expiring
    the session that authenticates the request; and a test that fakes
    Django's clock for something else does not expire every account.
    """
    return datetime.now(UTC)


def _clock_plan(user: User) -> tuple[str, int | None]:
    """The plan an account without a live subscription is on right now."""
    remaining = (trial_ends_at(user) - current_time()).total_seconds()
    if remaining <= 0:
        return "expired", None
    return "trial", math.ceil(remaining / 86400)


def _state(status: str, plan: str, days_left: int | None, locked: bool) -> JsonObject:
    return {
        "status": status,
        "trialDaysLeft": days_left,
        "locked": locked,
        "plan": plan,
        "entitlements": PLAN_ENTITLEMENTS[plan],
    }


def billing_json(user: User) -> JsonObject:
    # Both exemptions answer before any query, so a self-hosted install pays
    # zero extra queries on the session view and on every action POST.
    if not billing_enabled():
        return _state("disabled", "paid", None, False)
    if settings.FORKLUCK_ALLOW_DEMO_ACCOUNT and user.email == DEMO_EMAIL:
        return _state("disabled", "paid", None, False)
    if user.is_staff:
        return _state("disabled", "paid", None, False)
    row = BillingAccount.objects.filter(user=user).values("status", "locked").first()
    if row is None:
        plan, days_left = _clock_plan(user)
        return _state("none", plan, days_left, False)
    if is_paid_status(row["status"]):
        return _state(row["status"], "paid", None, row["locked"])
    # Anything Stripe reports that is not live, and an account that never
    # subscribed, sit on the calendar: still inside the window or read-only.
    plan, days_left = _clock_plan(user)
    return _state(row["status"], plan, days_left, row["locked"])


def require_entitlement(user: User, key: str) -> None:
    if not billing_json(user)["entitlements"][key]:
        raise EntitlementError("This feature needs a subscription.")


def write_refusal_for(state: JsonObject) -> str | None:
    """Why this account may not write right now, or None while it may.

    Answered from one billing state so a caller that already holds it, or
    dispatch with its single lookup, can refuse with the right sentence.
    """
    if state["locked"]:
        return "This account is being deleted."
    if state["plan"] != "expired":
        return None
    if state["status"] == "none":
        return "Your trial has ended. Subscribe to keep editing."
    return "Your subscription has ended. Subscribe to keep editing."


def write_refusal(user: User) -> str | None:
    return write_refusal_for(billing_json(user))


def write_blocked(user: User) -> bool:
    return write_refusal(user) is not None


def workspace_closed(user: User) -> bool:
    """Whether the account is going away.

    Reads such as guest links stop at deletion, not at the end of a trial:
    read-only means reads still work.
    """
    return bool(billing_json(user)["locked"])
