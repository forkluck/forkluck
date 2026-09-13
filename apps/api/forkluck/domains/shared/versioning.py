"""Optimistic concurrency for the aggregate roots. A leaf: knows only models."""

from ...models import Ingredient, Invoice, Menu, Recipe, SavedComparison


class StaleWriteError(Exception):
    def __init__(self, current: int, kind: str) -> None:
        super().__init__(f"Stale write: {kind} is at edit_version {current}")
        self.current = current
        self.kind = kind


def check_and_bump(
    row: Ingredient | Invoice | Menu | Recipe | SavedComparison,
    expected: int | None,
) -> int:
    # Call inside transaction.atomic() after select_for_update() on the row.
    if expected is not None and expected != row.edit_version:
        raise StaleWriteError(row.edit_version, row._meta.model_name)
    row.edit_version += 1
    row.save(update_fields=["edit_version", "updated_at"])
    return row.edit_version
