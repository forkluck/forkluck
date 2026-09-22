"""Account mutations."""

from collections.abc import Callable
from typing import Any

from django.conf import settings

from ...integrations.emails import EmailNotConfigured
from ...integrations.ghost_members import newsletter_status, set_newsletter
from ...models import DeviceToken, EmailVerificationCode, User
from ...verification import issue_code, verify_code
from ..shared.values import bool_value, text_value, uuid_value
from .billing import delete_user_with_billing

JsonObject = dict[str, Any]


def action_update_account(user: User, body: JsonObject) -> JsonObject:
    # Name only. Email is the USERNAME_FIELD, so changing it is a sign-in
    # change and needs its own verified flow, not this form.
    user.name = text_value(body.get("name"), "Name", max_length=150).strip()
    user.save(update_fields=["name"])
    return {"name": user.name}


def action_set_newsletter(user: User, body: JsonObject) -> JsonObject:
    # Ghost is the record, so the answer is read back from it rather than
    # echoed from the request.
    enabled = bool_value(body.get("enabled"), "Newsletter")
    if not set_newsletter(user.email, enabled, user.name or None):
        raise ValueError("Couldn't update your newsletter preference")
    return {"enabled": newsletter_status(user.email)}


def action_revoke_device(user: User, body: JsonObject) -> JsonObject:
    """Sign one phone out from the web. Deleting the row is the revoke."""
    device_id = uuid_value(body.get("id"), "device id")
    deleted, _ = DeviceToken.objects.filter(user=user, id=device_id).delete()
    if not deleted:
        raise ValueError("Device not found")
    return {"ok": True}


def action_delete_account(user: User, body: JsonObject) -> JsonObject:
    """The owner deletes their own account: the same command the admin runs,
    so Stripe, the feedback board and the newsletter are all let go first.
    The phones follow by cascade from their tokens."""
    if settings.FORKLUCK_ALLOW_DEMO_ACCOUNT and user.email == "user@user.com":
        raise ValueError("Account deletion isn't available for the demo account")
    delete_user_with_billing(user)
    return {"ok": True}


def action_request_account_deletion(user: User, body: JsonObject) -> JsonObject:
    """Email the code the phone's delete asks for. Throttled per address like
    every other code; the caller is already signed in, so no client bucket."""
    try:
        issue_code(user.email, EmailVerificationCode.PURPOSE_DELETE_ACCOUNT)
    except EmailNotConfigured as exc:
        raise ValueError("Email sending is not configured") from exc
    return {"ok": True}


def action_delete_account_confirmed(user: User, body: JsonObject) -> JsonObject:
    """The phone's delete: a long-lived token on an unlocked phone is not the
    proof a password session is, so the emailed code stands in for it."""
    code = text_value(body.get("code"), "Code", max_length=6).strip()
    if not verify_code(user.email, EmailVerificationCode.PURPOSE_DELETE_ACCOUNT, code):
        raise ValueError("That code is wrong or expired. Request a new one.")
    return action_delete_account(user, body)


# Slugs this module answers for, composed into the one action route by
# forkluck/http/dispatch.py. The phone's confirmed delete is not a slug of
# its own: dispatch mounts it under `delete-account` on the mobile table.
ACTIONS: dict[str, Callable[[User, JsonObject], JsonObject]] = {
    "update-account": action_update_account,
    "set-newsletter": action_set_newsletter,
    "revoke-device": action_revoke_device,
    "request-account-deletion": action_request_account_deletion,
    "delete-account": action_delete_account,
}
