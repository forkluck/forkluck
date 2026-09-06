"""Per-workspace serialization for import and undo.

An undo has to validate and mutate under one lock. Row locks on the records it
touches are necessary but not sufficient: a concurrent import creates rows that
do not exist yet when the undo reads them, so there is nothing to lock. Taking
the workspace's own User row first gives those flows a single rendezvous point.

A leaf module: it knows the User model and nothing else.
"""

from ...models import User


def lock_workspace(user: User) -> None:
    """Block until this workspace's other import/undo flows have finished.

    Must be called inside ``transaction.atomic()`` — the lock is held until the
    transaction ends. On backends without SELECT ... FOR UPDATE (SQLite, used by
    the test suite) this degrades to a plain read; those backends serialize
    writes globally, so the invariant still holds.
    """
    User.objects.select_for_update().only("id").get(pk=user.pk)
