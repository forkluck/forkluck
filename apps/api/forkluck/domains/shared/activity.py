"""The one way an action writes a line to the workspace activity log."""

from typing import Any
from uuid import UUID

from ...models import ActivityEvent, User


def activity_event(
    user: User,
    actor: User | None,
    resource_type: str,
    event: str,
    *,
    resource_id: UUID | str | None = None,
    name: str = "",
    **context: Any,
) -> ActivityEvent:
    """One line, built and checked but not yet written.

    A batch action builds one per row it changed and writes them in a single
    statement, so its query count does not grow with the selection.
    """
    if resource_type not in ActivityEvent.RESOURCE_TYPES:
        raise ValueError(f"Unknown activity resource type {resource_type!r}")
    if event not in ActivityEvent.EVENTS:
        raise ValueError(f"Unknown activity event {event!r}")
    return ActivityEvent(
        user=user,
        actor=actor,
        actor_name=actor.name if actor else "",
        resource_type=resource_type,
        resource_id=resource_id,
        event=event,
        name=name[:200],
        context=context,
    )


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
    row = activity_event(
        user,
        actor,
        resource_type,
        event,
        resource_id=resource_id,
        name=name,
        **context,
    )
    row.save()
    return row
