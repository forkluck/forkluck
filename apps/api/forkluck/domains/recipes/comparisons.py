"""Saved comparisons: the reads both the views and the save action share."""

import uuid

from django.db.models import Prefetch

from ...models import SavedComparison, SavedComparisonColumn, User
from ..shared.recipe_access import accessible_recipe_queryset
from .serializers import JsonObject, saved_comparison_json


def comparison_columns():
    return Prefetch(
        "columns", queryset=SavedComparisonColumn.objects.select_related("recipe")
    )


def owned_comparison(user: User, comparison_ref: str) -> SavedComparison | None:
    queryset = SavedComparison.objects.filter(user=user).prefetch_related(
        comparison_columns()
    )
    if comparison_ref.startswith("cmp_"):
        return queryset.filter(public_id=comparison_ref).first()
    try:
        return queryset.filter(id=uuid.UUID(comparison_ref)).first()
    except ValueError:
        return None


def saved_comparison_payload(user: User, row: SavedComparison) -> JsonObject:
    recipe_ids = {column.recipe_id for column in row.columns.all() if column.recipe_id}
    accessible = (
        set(
            accessible_recipe_queryset(user, prefetch_shares=False)
            .filter(id__in=recipe_ids)
            .values_list("id", flat=True)
        )
        if recipe_ids
        else set()
    )
    return saved_comparison_json(row, accessible)
