"""The one way an action writes a line to the workspace activity log."""

from typing import Any
from uuid import UUID

from ...models import ActivityEvent, User


def record_event(
    user: User,
    actor: User | None,
    resource_type: str,
    event: str,
    *,
    resource_id: UUID | str | None = None,
    name: str = "",
    **context: Any,
) -> ActivityEvent:
    if resource_type not in ActivityEvent.RESOURCE_TYPES:
        raise ValueError(f"Unknown activity resource type {resource_type!r}")
    if event not in ActivityEvent.EVENTS:
        raise ValueError(f"Unknown activity event {event!r}")
    return ActivityEvent.objects.create(
        user=user,
        actor=actor,
        actor_name=actor.name if actor else "",
        resource_type=resource_type,
        resource_id=resource_id,
        event=event,
        name=name[:200],
        context=context,
    )
