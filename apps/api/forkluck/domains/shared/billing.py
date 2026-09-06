"""Whether a workspace is open for business.

Lives here because two layers ask: the action funnel gates every write on it,
and the guest link read gates on the owner's account the same way.
"""

import math
from typing import Any

from django.conf import settings
from django.utils import timezone

from ...demo_data import DEMO_EMAIL
from ...models import BillingAccount, User

JsonObject = dict[str, Any]

# camelCase because these ship verbatim in the session JSON. maxRecipes None
# means unlimited; every other key is a plain on/off feature flag.
FREE_ENTITLEMENTS = {
    "maxRecipes": 10,
    "primo": False,
    "posSync": True,
    "connectors": True,
    "usdaSearch": True,
    "catalogSearch": True,
    "invoiceAi": True,
}
PAID_ENTITLEMENTS = {
    "maxRecipes": None,
    "primo": True,
    "posSync": True,
    "connectors": True,
    "usdaSearch": True,
    "catalogSearch": True,
    "invoiceAi": True,
}
PLAN_ENTITLEMENTS = {"free": FREE_ENTITLEMENTS, "paid": PAID_ENTITLEMENTS}

# trialing stays here only so a subscription that predates the free plan keeps
# working until it converts; no new trial is ever granted.
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
    row = (
        BillingAccount.objects.filter(user=user)
        .values("status", "trial_end", "locked")
        .first()
    )
    if row is None:
        return _state("none", "free", None, False)
    days_left = None
    if row["status"] == "trialing" and row["trial_end"] is not None:
        remaining = (row["trial_end"] - timezone.now()).total_seconds()
        days_left = max(0, math.ceil(remaining / 86400))
    plan = "paid" if is_paid_status(row["status"]) else "free"
    return _state(row["status"], plan, days_left, row["locked"])


def require_entitlement(user: User, key: str) -> None:
    if not billing_json(user)["entitlements"][key]:
        raise EntitlementError(
            "This feature isn't available on the Free plan. Upgrade to use it."
        )


def write_blocked(user: User) -> bool:
    return bool(billing_json(user)["locked"])
