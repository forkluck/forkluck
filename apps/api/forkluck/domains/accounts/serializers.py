"""Account JSON shape."""

from typing import Any

from ...models import User

JsonObject = dict[str, Any]


def user_json(user: User) -> JsonObject:
    return {
        "id": str(user.id), "name": user.name, "email": user.email,
        "hasPassword": user.has_usable_password(),
    }
