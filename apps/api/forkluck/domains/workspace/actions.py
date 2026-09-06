"""Workspace settings mutations: currency, measurement, membership, the reset."""

import logging
from collections.abc import Callable
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from django.conf import settings
from django.db import transaction
from django.db.models import Q

from ... import throttling
from ...integrations.emails import (
    EmailNotConfigured,
    send_kitchen_invite,
    send_kitchen_member_notification,
)
from ...integrations.exchange_rates import SUPPORTED_CURRENCIES, get_exchange_rate_quote
from ...models import (
    BenchCostSettings,
    KitchenInvite,
    KitchenMembership,
    RecipeBook,
    RecipeGuestLink,
    RecipeShare,
    SalesProductComponent,
    User,
)
from ..shared.activity import record_event
from ..shared.labor_policy import policy_of, recost_workspace_shifts
from ..shared.locking import lock_workspace
from ..shared.values import int_value, number_value, text_value, uuid_value
from ..shared.workspace_timezone import known_zone
from .currency import convert_workspace_currency

JsonObject = dict[str, Any]

logger = logging.getLogger(__name__)

# Rows a reset must clear by their own queryset because they hang off a
# product rather than the user. A product component may protect another
# product, and Django's collector raises on a PROTECT edge even when the
# protecting row is inside the same delete set, so `sales_products` cannot
# empty a bundle on its own.
KITCHEN_PRE_DELETES: tuple[Callable[[User], Any], ...] = (
    lambda user: SalesProductComponent.objects.filter(product__user=user),
)

# The tenant relations a kitchen reset clears, in an order that empties every
# PROTECT/RESTRICT edge before its target: SalesProductComponent protects
# Recipe and RecipeItem restricts Ingredient, so all of sales goes before
# recipes and recipes before ingredients. Everything not named here survives:
# the user, settings, billing, the POS and supplier connectors, the catalog
# accesses, the currency conversion history, and the activity log.
KITCHEN_RELATIONS: tuple[str, ...] = (
    "sales_product_variants",
    "sales_products",
    "sales_catalog_items",
    "sales_modifier_lists",
    "sales_line_modifiers",
    "sales_lines",
    "sales_imports",
    "sales_ignore_rules",
    "sales_sku_ignores",
    "menus",
    "recipes",
    "recipe_categories",
    "recipe_tags",
    "recipe_pastes",
    "recipe_line_matches",
    "recipe_external_refs",
    "benchcost_recipes",
    "ingredients",
    "ingredient_categories",
    "ingredient_tags",
    "preparations",
    "ingredient_conversions",
    "supplier_items",
    "ignored_supplier_items",
    "ingredient_imports",
    "nutrition_requests",
    "dismissed_master_prices",
    "invoices",
    "receipt_feedback",
    "invoice_lines",
    "expense_categories",
    "employees",
    "labor_imports",
    "time_entries",
)


def action_currency_conversion_quote(user: User, body: JsonObject) -> JsonObject:
    target_currency = body.get("targetCurrency")
    if target_currency not in SUPPORTED_CURRENCIES:
        raise ValueError("Invalid currency")
    row, _ = BenchCostSettings.objects.get_or_create(user=user)
    expected_currency = body.get("expectedCurrencyCode")
    if expected_currency != row.currency_code:
        raise ValueError(
            "Currency settings changed in another window. Refresh and try again."
        )
    quote = get_exchange_rate_quote(row.currency_code, target_currency)
    return {"quote": quote.as_json()}


def action_update_business_settings(user: User, body: JsonObject) -> JsonObject:
    measurement_system = body.get("measurementSystem")
    if measurement_system not in {"metric", "us"}:
        raise ValueError("Invalid measurement system")
    currency_code = body.get("currencyCode")
    if currency_code not in SUPPORTED_CURRENCIES:
        raise ValueError("Invalid currency")
    cents = int_value(
        body.get("wagePerHourCents"),
        "Wage",
        minimum=0,
        maximum=100000000,
    )
    row, _ = BenchCostSettings.objects.get_or_create(user=user)
    # Absent keeps the stored choice, blank included; a value must be a region.
    label_region = body.get("labelRegion", row.label_region)
    if "labelRegion" in body and label_region not in {"us", "eu"}:
        raise ValueError("Invalid label region")
    food_cost_target = number_value(
        body.get("foodCostTarget", row.food_cost_target_bps / 10000),
        "Food cost target",
        minimum=0.01,
        maximum=1,
    )
    assert food_cost_target is not None
    food_cost_target_bps = round(food_cost_target * 10000)
    overtime_weekly_minutes = int_value(
        body.get("overtimeWeeklyMinutes", row.overtime_weekly_minutes),
        "Overtime threshold",
        minimum=60,
        maximum=10080,
    )
    # A percent on the wire, basis points in the row: the dialog speaks in the
    # 9.39% an employer reads off a rate notice, and two decimal places of it
    # survive the round trip. The ceiling is deliberately loose — a burden
    # over 100% is nonsense in a kitchen but the field is not only payroll
    # tax, and a hard 100 would be a rule we would have to explain.
    payroll_tax_percent = number_value(
        body.get("payrollTaxPercent", row.payroll_tax_bps / 100),
        "Payroll tax",
        minimum=0,
        maximum=200,
    )
    assert payroll_tax_percent is not None
    payroll_tax_bps = round(payroll_tax_percent * 100)
    unpaid_break_minutes = int_value(
        body.get("unpaidBreakMinutes", row.unpaid_break_minutes),
        "Unpaid break",
        minimum=0,
        maximum=480,
    )
    unpaid_break_per_hours = int_value(
        body.get("unpaidBreakPerHours", row.unpaid_break_per_hours),
        "Unpaid break interval",
        minimum=1,
        maximum=24,
    )
    # Absent keeps the stored choice, blank included; a value must be a zone.
    timezone_name = body.get("timezone", row.timezone)
    if "timezone" in body and known_zone(timezone_name) is None:
        raise ValueError("Timezone is not recognized")

    expected_currency = body.get("expectedCurrencyCode")
    if expected_currency != row.currency_code:
        raise ValueError(
            "Currency settings changed in another window. Refresh and try again."
        )

    def settings_delta(before: BenchCostSettings) -> list[str]:
        return [
            key
            for key, was, now in (
                ("wagePerHourCents", before.wage_per_hour_cents, cents),
                (
                    "measurementSystem",
                    before.measurement_system,
                    measurement_system,
                ),
                (
                    "foodCostTarget",
                    before.food_cost_target_bps,
                    food_cost_target_bps,
                ),
                (
                    "overtimeWeeklyMinutes",
                    before.overtime_weekly_minutes,
                    overtime_weekly_minutes,
                ),
                ("currencyCode", before.currency_code, currency_code),
                ("timezone", before.timezone, timezone_name),
                ("payrollTaxPercent", before.payroll_tax_bps, payroll_tax_bps),
                (
                    "unpaidBreakMinutes",
                    before.unpaid_break_minutes,
                    unpaid_break_minutes,
                ),
                (
                    "unpaidBreakPerHours",
                    before.unpaid_break_per_hours,
                    unpaid_break_per_hours,
                ),
            )
            if was != now
        ]

    if currency_code == row.currency_code:
        # Locked for the whole write. The break rule decides whether every
        # stored shift cost has to be recomputed, and that decision has to be
        # made against the committed row: judging it from the unlocked read
        # above would let a save that lands between the two skip a recost it
        # needs, leaving the workspace reading a rule its own costs disobey.
        # Labor imports take this same lock before writing shift costs, so
        # holding it also stops an import from landing shifts costed on the
        # rule this save is replacing.
        with transaction.atomic():
            lock_workspace(user)
            locked = BenchCostSettings.objects.select_for_update().get(user=user)
            changed = settings_delta(locked)
            # The payroll tax is derived at read time, so only the break rule
            # can make a stored cost wrong.
            break_rule_moved = (
                locked.unpaid_break_minutes,
                locked.unpaid_break_per_hours,
            ) != (unpaid_break_minutes, unpaid_break_per_hours)
            locked.wage_per_hour_cents = cents
            locked.measurement_system = measurement_system
            locked.label_region = label_region
            locked.food_cost_target_bps = food_cost_target_bps
            locked.overtime_weekly_minutes = overtime_weekly_minutes
            locked.timezone = timezone_name
            locked.payroll_tax_bps = payroll_tax_bps
            locked.unpaid_break_minutes = unpaid_break_minutes
            locked.unpaid_break_per_hours = unpaid_break_per_hours
            locked.save(
                update_fields=[
                    "wage_per_hour_cents",
                    "measurement_system",
                    "label_region",
                    "food_cost_target_bps",
                    "overtime_weekly_minutes",
                    "timezone",
                    "payroll_tax_bps",
                    "unpaid_break_minutes",
                    "unpaid_break_per_hours",
                ]
            )
            if break_rule_moved:
                recost_workspace_shifts(user, policy_of(locked))
        if changed:
            record_event(
                user, user, "settings", "edited", name="Business defaults",
                changed=changed,
            )
        return {"ok": True, "currencyConversion": None}

    changed = settings_delta(row)

    if body.get("confirmCurrencyConversion") is not True:
        raise ValueError("Confirm the currency conversion before saving")
    quote = get_exchange_rate_quote(row.currency_code, currency_code)
    try:
        quoted_rate = Decimal(str(body.get("quotedRate")))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError("The confirmed exchange rate was invalid") from exc
    if (
        quoted_rate != quote.rate
        or body.get("quotedRateDate") != quote.rate_date.isoformat()
    ):
        raise ValueError("The exchange rate changed. Review the latest rate and try again.")

    conversion = convert_workspace_currency(
        user=user,
        quote=quote,
        wage_per_hour_cents=cents,
        measurement_system=measurement_system,
        label_region=label_region,
        food_cost_target_bps=food_cost_target_bps,
        overtime_weekly_minutes=overtime_weekly_minutes,
        timezone_name=timezone_name,
        payroll_tax_bps=payroll_tax_bps,
        unpaid_break_minutes=unpaid_break_minutes,
        unpaid_break_per_hours=unpaid_break_per_hours,
    )
    record_event(
        user, user, "settings", "edited", name="Business defaults", changed=changed
    )
    return {
        "ok": True,
        "currencyConversion": {
            "id": str(conversion.id),
            **quote.as_json(),
        },
    }


def action_delete_kitchen_data(user: User, body: JsonObject) -> JsonObject:
    """Empty the workspace of everything the kitchen made, keeping the account
    itself, its settings, its billing and its connectors."""
    deleted = {
        "recipes": user.recipes.count(),
        "ingredients": user.ingredients.count(),
        "menus": user.menus.count(),
        "invoices": user.invoices.count(),
        "employees": user.employees.count(),
    }
    with transaction.atomic():
        for pre_delete in KITCHEN_PRE_DELETES:
            pre_delete(user).delete()
        for relation in KITCHEN_RELATIONS:
            getattr(user, relation).all().delete()
        record_event(
            user, user, "workspace", "deleted", name="Kitchen data", **deleted
        )
    return {"ok": True, "deleted": deleted}


def action_reset_guest_links(user: User, body: JsonObject) -> JsonObject:
    """Revoke every guest share link the workspace has handed out — the single
    recipe links and the books alike. The token is the whole credential, so
    deleting the row is what invalidates the URL."""
    _, links = RecipeGuestLink.objects.filter(recipe__user=user).delete()
    _, books = RecipeBook.objects.filter(user=user).delete()
    # Per model, not the delete() total: a book's item rows go with it and
    # counting them would report more links than were ever handed out.
    revoked = links.get("forkluck.RecipeGuestLink", 0) + books.get(
        "forkluck.RecipeBook", 0
    )
    return {"ok": True, "revoked": revoked}


def _role_value(value: Any) -> str:
    if value not in {RecipeShare.VIEWER, RecipeShare.EDITOR}:
        raise ValueError("Invalid role")
    return value


def action_invite_kitchen_member(user: User, body: JsonObject) -> JsonObject:
    """Let an address into the whole kitchen, as a viewer or an editor.

    A verified account becomes a membership straight away; an address with no
    account gets an invite row and a mail asking it to create one, which the
    verification claim then turns into the membership.
    """
    email = text_value(body.get("email"), "Email", max_length=320).lower()
    role = _role_value(body.get("role", RecipeShare.VIEWER))
    member = User.objects.filter(
        email__iexact=email, email_verified_at__isnull=False
    ).first()
    if member is None:
        return {"invite": _mint_kitchen_invite(user, email, role)}
    if member.id == user.id:
        raise ValueError("You already own this kitchen")
    membership, _ = KitchenMembership.objects.update_or_create(
        owner=user, member=member, defaults={"role": role}
    )
    _notify_kitchen_member(user, member, membership.role)
    return {
        "id": str(membership.id),
        "memberId": str(member.id),
        "name": member.name,
        "email": member.email,
        "role": membership.role,
    }


def _mint_kitchen_invite(user: User, email: str, role: str) -> JsonObject:
    try:
        throttling.hit(
            "kitchen-invite",
            str(user.id),
            limit=20,
            window=timedelta(days=1),
            message="Too many kitchen invites today. Try again tomorrow.",
        )
    except throttling.Throttled as exc:
        raise ValueError(str(exc)) from exc
    # Re-inviting the same address restates the role rather than adding a row.
    invite, _ = KitchenInvite.objects.update_or_create(
        owner=user, email=email, defaults={"role": role}
    )
    _mail_after_commit(
        lambda: send_kitchen_invite(
            email,
            owner_name=user.name,
            role=invite.role,
            link=f"{settings.FORKLUCK_APP_ORIGIN}/login",
        ),
        "Could not send the kitchen invite %s",
        invite.id,
    )
    throttling.sweep()
    return {"id": str(invite.id), "email": invite.email, "role": invite.role}


def _notify_kitchen_member(owner: User, member: User, role: str) -> None:
    _mail_after_commit(
        lambda: send_kitchen_member_notification(
            member.email,
            owner_name=owner.name,
            role=role,
            link=f"{settings.FORKLUCK_APP_ORIGIN}/login?next=/recipes",
        ),
        "Could not send the kitchen notification for member %s",
        member.id,
    )


def _mail_after_commit(send: Callable[[], None], log_format: str, row_id: Any) -> None:
    """Post a membership mail once the row it announces is committed.

    Best effort in both directions: a kitchen invite is claimed by address
    rather than by a token in the mail, so a message that never leaves costs
    the invitee a nudge, not their access, and must not undo the row.
    """

    def run() -> None:
        try:
            send()
        except (EmailNotConfigured, ValueError):
            logger.exception(log_format, row_id)

    transaction.on_commit(run)


def action_update_kitchen_member(user: User, body: JsonObject) -> JsonObject:
    membership = KitchenMembership.objects.filter(
        owner=user, member_id=uuid_value(body.get("memberId"), "member")
    ).first()
    if membership is None:
        raise ValueError("Member not found")
    membership.role = _role_value(body.get("role"))
    membership.save(update_fields=["role", "updated_at"])
    return {"ok": True}


def action_remove_kitchen_member(user: User, body: JsonObject) -> JsonObject:
    """One slug for both directions: the owner removing someone, and a member
    leaving a kitchen they were let into."""
    KitchenMembership.objects.filter(
        Q(owner=user) | Q(member=user),
        id=uuid_value(body.get("membershipId"), "membership"),
    ).delete()
    return {"ok": True}


def action_remove_kitchen_invite(user: User, body: JsonObject) -> JsonObject:
    KitchenInvite.objects.filter(
        owner=user, id=uuid_value(body.get("inviteId"), "invite")
    ).delete()
    return {"ok": True}


# Slugs this module answers for, composed into the one action route by
# forkluck/http/dispatch.py.
ACTIONS: dict[str, Callable[[User, JsonObject], JsonObject]] = {
    "update-business-settings": action_update_business_settings,
    "currency-conversion-quote": action_currency_conversion_quote,
    "delete-kitchen-data": action_delete_kitchen_data,
    "reset-guest-links": action_reset_guest_links,
    "invite-kitchen-member": action_invite_kitchen_member,
    "update-kitchen-member": action_update_kitchen_member,
    "remove-kitchen-member": action_remove_kitchen_member,
    "remove-kitchen-invite": action_remove_kitchen_invite,
}
