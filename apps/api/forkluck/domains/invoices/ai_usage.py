"""Reserve hosted AI work before any provider call, for uploads and Drive alike."""

from datetime import date, timezone as datetime_timezone

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from ...models import InvoiceAiRead, User
from ..shared.billing import EntitlementError, billing_json
from ..shared.locking import lock_workspace
from ..shared.values import uuid_value

FREE_AI_PAGES = 10
PAID_AI_PAGES = 100
# Detection, extraction, escalation and transport retries all consume this
# budget. Each attempt is separately bounded to 16,000 output tokens in Next.
ATTEMPTS_PER_PAGE = 8


def current_period() -> date:
    return timezone.now().astimezone(datetime_timezone.utc).date().replace(day=1)


def next_period(start: date) -> date:
    return date(start.year + (start.month == 12), start.month % 12 + 1, 1)


def page_limit(billing: dict) -> int | None:
    if billing["status"] == "disabled":
        return None
    return PAID_AI_PAGES if billing["plan"] == "paid" else FREE_AI_PAGES


def invoice_ai_usage(user: User, billing: dict | None = None) -> dict:
    start = current_period()
    limit = page_limit(billing if billing is not None else billing_json(user))
    totals = InvoiceAiRead.objects.filter(user=user, period_start=start).aggregate(
        pages=Sum("pages"), attempts=Sum("attempts")
    )
    pages, attempts = totals["pages"] or 0, totals["attempts"] or 0
    return {
        "usedPages": pages,
        "maxPages": limit,
        "resetsOn": next_period(start).isoformat(),
        "exhausted": limit is not None
        and (pages >= limit or attempts >= limit * ATTEMPTS_PER_PAGE),
    }


def integer(body: dict, key: str, minimum: int, maximum: int) -> int:
    value = body.get(key)
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{key} must be a whole number from {minimum} to {maximum}")
    return value


def action_invoice_ai_usage(user: User, body: dict) -> dict:
    operation = body.get("operation")
    if operation not in ("reserve", "record"):
        raise ValueError("Unknown AI usage operation")
    read_id = uuid_value(body["readId"], "AI read") if body.get("readId") else None
    if operation == "record":
        input_tokens = integer(body, "inputTokens", 0, 1_000_000_000)
        output_tokens = integer(body, "outputTokens", 0, 1_000_000_000)
        with transaction.atomic():
            row = (
                InvoiceAiRead.objects.select_for_update()
                .filter(user=user, id=read_id)
                .first()
            )
            if row is None:
                raise ValueError("AI read not found")
            # Cumulative totals make a repeated acknowledgement harmless. No
            # record operation ever reduces the reserved work budget.
            row.input_tokens = max(row.input_tokens, input_tokens)
            row.output_tokens = max(row.output_tokens, output_tokens)
            row.save(update_fields=["input_tokens", "output_tokens"])
        return {"ok": True}

    pages = integer(body, "pages", 0 if read_id else 1, 200)
    attempts = integer(body, "attempts", 1, 2)
    if read_id and pages:
        raise ValueError("A continuing AI read cannot add pages")
    with transaction.atomic():
        lock_workspace(user)
        billing = billing_json(user)
        if billing["locked"]:
            raise EntitlementError(
                "This kitchen is unavailable.", "subscription_required"
            )
        limit = page_limit(billing)
        if limit is None:
            return {"readId": None}
        start = current_period()
        row = None
        if read_id:
            row = InvoiceAiRead.objects.filter(user=user, id=read_id).first()
            if row is None:
                raise ValueError("AI read not found")
            if row.period_start != start:
                raise EntitlementError(
                    "Your AI allowance has reset. Try this file again.",
                    "invoice_ai_limit_reached",
                )
        totals = InvoiceAiRead.objects.filter(user=user, period_start=start).aggregate(
            pages=Sum("pages"), attempts=Sum("attempts")
        )
        if (totals["pages"] or 0) + pages > limit or (
            totals["attempts"] or 0
        ) + attempts > limit * ATTEMPTS_PER_PAGE:
            reset = next_period(start).strftime("%B %-d")
            ending = (
                "Enter invoices manually or upgrade."
                if billing["plan"] == "free"
                else "You can still enter invoices manually."
            )
            raise EntitlementError(
                f"This read exceeds your monthly AI allowance of {limit} pages. "
                f"Resets {reset}. {ending}",
                "invoice_ai_limit_reached",
            )
        if row is None:
            row = InvoiceAiRead.objects.create(
                user=user, period_start=start, pages=pages, attempts=attempts
            )
        else:
            row.attempts += attempts
            row.save(update_fields=["attempts"])
    return {"readId": str(row.id)}
