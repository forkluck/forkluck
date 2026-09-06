"""Account mutations."""

from collections.abc import Callable
from typing import Any

from ...integrations.ghost_members import newsletter_status, set_newsletter
from ...models import User
from ..shared.values import bool_value, text_value

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


# Slugs this module answers for, composed into the one action route by
# forkluck/http/dispatch.py.
ACTIONS: dict[str, Callable[[User, JsonObject], JsonObject]] = {
    "update-account": action_update_account,
    "set-newsletter": action_set_newsletter,
}
