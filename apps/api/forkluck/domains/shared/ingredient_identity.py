"""Tenant-scoped ingredient identity resolution.

Recipe text is not an identity. A line is matched against a pantry ingredient
or component recipe, with an explicit target and exact pantry name taking
precedence over a saved line match. This module is the single Python read and
write path for ``RecipeLineMatch``; only current match and catalog vocabulary
participate in resolution.
"""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any

from django.db.models import Q

from ...models import (
    CatalogIngredientAlias,
    Ingredient,
    Preparation,
    Recipe,
    RecipeItem,
    RecipeLineMatch,
)
from .values import normalized_name
from .vocabulary import vocabulary


@dataclass(frozen=True)
class IdentityMatch:
    key: str
    kind: str
    name: str
    source: str


_VOCABULARY = vocabulary()
_UNIT_SOURCE = "|".join(
    f"(?:{entry.get('pattern') or re.escape(entry['slug'])})"
    for entry in _VOCABULARY["units"]
)
_LINE_PREFIX = re.compile(
    r"^\s*(?:[-*•]\s*)?(?:\d+(?:\s+\d+/\d+|/\d+)?(?:\.\d+)?|\d+\s+\d+/\d+)"
    rf"\s+(?:(?:{_UNIT_SOURCE})\.?\s+)?(.+?)\s*$",
    re.IGNORECASE,
)
_QUALIFIER_WORDS = _VOCABULARY["qualifierWords"]
_QUALIFIER_TAIL = re.compile(
    rf"^(.*?),\s*(?:{'|'.join(_QUALIFIER_WORDS)})"
    rf"(?:\s+(?:or\s+)?(?:{'|'.join(_QUALIFIER_WORDS)}))*$",
    re.IGNORECASE,
)
_PARENTHETICAL_QUALIFIER_TAIL = re.compile(
    rf"^(.*?)\s+\((?:{'|'.join(_QUALIFIER_WORDS)})"
    rf"(?:\s+(?:or\s+)?(?:{'|'.join(_QUALIFIER_WORDS)}))*\)$",
    re.IGNORECASE,
)


def _line_candidates(line: str) -> tuple[str, ...]:
    """Return the full line and its quantity/unit-stripped identity spelling."""
    full = normalized_name(line)
    match = _LINE_PREFIX.match(line)
    if match is None:
        return (full,)
    written = match.group(1).strip()
    qualifier = _QUALIFIER_TAIL.match(
        written
    ) or _PARENTHETICAL_QUALIFIER_TAIL.match(
        written
    )
    stripped = normalized_name(qualifier.group(1) if qualifier else written)
    return (full, stripped) if stripped and stripped != full else (full,)


def recipe_uses_ingredient(
    body: str,
    ingredient: Ingredient,
    *,
    by_name: dict[str, Any],
    by_id: dict[str, Any],
    saved: dict[str, tuple[str, str]],
) -> bool:
    """Resolve recipe lines with the same precedence as costing and pricing."""
    for line in body.splitlines():
        for candidate in _line_candidates(line):
            resolved = resolve_name(
                candidate,
                by_name=by_name,
                by_id=by_id,
                saved=saved,
            )
            if resolved is not None and resolved.id == ingredient.id:
                return True
    return False


def recipes_using_ingredient(user: Any, ingredient: Ingredient) -> list[Recipe]:
    """Recipes that currently resolve to this tenant-owned ingredient."""
    direct_ids = set(
        RecipeItem.objects.filter(
            recipe__user=user, ingredient=ingredient
        ).values_list("recipe_id", flat=True)
    )
    saved = saved_line_match_map(user)
    by_name = {ingredient.normalized_name: ingredient}
    by_id = {str(ingredient.id): ingredient}
    recipes = list(
        Recipe.objects.filter(user=user).only("id", "public_id", "title", "body")
    )
    return [
        recipe
        for recipe in recipes
        if recipe.id in direct_ids
        or recipe_uses_ingredient(
            recipe.body,
            ingredient,
            by_name=by_name,
            by_id=by_id,
            saved=saved,
        )
    ]


def qualifier_clauses(qualifier: str) -> tuple[str, ...]:
    """The states a line asks for, as costing reads them: one per clause."""
    return tuple(
        clause
        for piece in re.split(r"[,;]", qualifier)
        if (clause := normalized_name(piece))
    )


def recipes_using_preparation(user: Any, preparation: Preparation) -> list[Recipe]:
    """Recipes whose lines ask this ingredient for in this state.

    Nothing points at a preparation by id — a line names one, and costing
    matches it on exact equality with a normalized clause of the line's
    preparation note. Deleting a named row silently reprices those lines, so
    this is the usage that has to be answered before one goes.
    """
    items = (
        RecipeItem.objects.filter(
            recipe__user=user, ingredient_id=preparation.ingredient_id
        )
        .exclude(preparation_note="")
        .select_related("recipe")
    )
    found: dict[Any, Recipe] = {}
    for item in items:
        if preparation.normalized_name in qualifier_clauses(item.preparation_note):
            found.setdefault(item.recipe_id, item.recipe)
    return list(found.values())


def saved_line_matches(user: Any) -> list[tuple[str, str, str]]:
    """Return ``(normalized line, target id, kind)`` for this tenant.

    A match onto an archived ingredient is dropped: the pantry row is out of
    use, so a line resolving to it would put it back into a new recipe.
    """
    rows = (
        owned_line_match_queryset(user)
        .exclude(ingredient__status=Ingredient.STATUS_ARCHIVED)
        .values_list("normalized_text", "ingredient_id", "component_recipe_id")
    )
    return [
        (line, str(ingredient_id or recipe_id), "ingredient" if ingredient_id else "recipe")
        for line, ingredient_id, recipe_id in rows
    ]


def owned_line_match_queryset(user: Any):
    return RecipeLineMatch.objects.filter(user=user).filter(
        Q(ingredient__user=user) | Q(component_recipe__user=user)
    )


def saved_line_match_map(user: Any) -> dict[str, tuple[str, str]]:
    # Catalog vocabulary is a fallback. A tenant's explicit saved choice must
    # win when an imported alias happens to use the same spelling.
    result: dict[str, tuple[str, str]] = {}
    for line, target, kind in catalog_resolution_matches(user):
        # Canonical catalog names outrank aliases when a source vocabulary
        # happens to reuse a canonical spelling.
        if line not in result:
            result[line] = (target, kind)
    for line, target, kind in saved_line_matches(user):
        result[line] = (target, kind)
    return result


def unique_catalog_aliases(user: Any) -> list[tuple[str, str, str]]:
    """Return only unambiguous catalog spellings adopted by this tenant."""
    owned = _owned_catalog_ingredients(user)
    owned_ids = {catalog_id: target[0] for catalog_id, target in owned.items()}
    candidates: dict[str, set[str]] = {}
    for row in CatalogIngredientAlias.objects.filter(
        is_active=True, ingredient_id__in=owned_ids
    ).values_list("normalized_text", "ingredient_id"):
        candidates.setdefault(row[0], set()).add(owned_ids[str(row[1])])
    return [
        (text, next(iter(targets)), "ingredient")
        for text, targets in candidates.items()
        if len(targets) == 1
    ]


def catalog_resolution_matches(user: Any) -> list[tuple[str, str, str]]:
    """Canonical catalog names plus unambiguous aliases for owned rows."""
    owned = _owned_catalog_ingredients(user)
    # Canonical names are globally unique on CatalogIngredient, while aliases
    # require the ambiguity check performed by unique_catalog_aliases.
    result = {
        _name: (_target_id, "ingredient")
        for _catalog_id, (_target_id, _name) in owned.items()
    }
    candidates: dict[str, set[str]] = {}
    owned_ids = {catalog_id: target[0] for catalog_id, target in owned.items()}
    for line, catalog_id in CatalogIngredientAlias.objects.filter(
        is_active=True, ingredient_id__in=owned_ids
    ).values_list("normalized_text", "ingredient_id"):
        candidates.setdefault(line, set()).add(owned_ids[str(catalog_id)])
    for line, targets in candidates.items():
        if line not in result and len(targets) == 1:
            result[line] = (next(iter(targets)), "ingredient")
    return [(line, target_id, kind) for line, (target_id, kind) in result.items()]


def _owned_catalog_ingredients(user: Any) -> dict[str, tuple[str, str]]:
    return {
        str(row.catalog_ingredient_id): (str(row.id), row.catalog_ingredient.normalized_name)
        for row in Ingredient.objects.filter(
            user=user,
            status=Ingredient.STATUS_ACTIVE,
            catalog_ingredient__isnull=False,
            catalog_ingredient__is_active=True,
        ).select_related("catalog_ingredient")
    }


def resolve_name(
    name: str,
    *,
    by_name: dict[str, Any],
    by_id: dict[str, Any] | None = None,
    saved: dict[str, tuple[str, str]] | None = None,
    explicit_id: str | None = None,
) -> Any | None:
    """Resolve using explicit target, exact pantry/component, then saved match."""
    by_id = by_id or {}
    saved = saved or {}
    if explicit_id and explicit_id in by_id:
        return by_id[explicit_id]
    exact = by_name.get(normalized_name(name))
    if exact is not None:
        return exact
    target = saved.get(normalized_name(name))
    return by_id.get(target[0]) if target is not None else None


def save_line_match(
    *, user: Any, line: str, ingredient: Ingredient | None = None,
    component_recipe: Recipe | None = None
) -> RecipeLineMatch:
    """Create or replace one saved line match, already tenant-authorized."""
    if (ingredient is None) == (component_recipe is None):
        raise ValueError("A match must have exactly one target")
    target = ingredient or component_recipe
    if target is None or target.user_id != user.id:
        raise ValueError("Match target not found")
    row, _ = RecipeLineMatch.objects.update_or_create(
        user=user,
        normalized_text=normalized_name(line),
        defaults={
            "text": line.strip(),
            "ingredient": ingredient,
            "component_recipe": component_recipe,
        },
    )
    return row
