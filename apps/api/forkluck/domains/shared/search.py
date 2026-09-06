"""One matching and ranking rule for every search box, and the twin of
`apps/web/lib/search.ts`.

A row matches when every token is found somewhere in it, in any field and any
order, so "bread flour" finds "Flour, bread". Ranking is Zulip's typeahead
ladder — exact, prefix, word start, the rest — as an ORDER BY expression, so a
list ranks before it is sliced.

The per-record field sets live here because a domain's browse list and the
palette must agree on them and `Domains are independent` forbids either
importing the other.
"""

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass

from django.db.models import Case, Exists, F, IntegerField, OuterRef, Q, Value, When

from ...models import CatalogIngredientAlias, RecipeLineMatch, SupplierItem, normalized_name

# Each token is one more AND clause in the SQL.
MAX_TOKENS = 12

EXACT = 0
PREFIX = 1
WORD_START = 2
CONTAINS = 3
# Where a row reached only through an alias or a supplier title lands, since it
# scores on its own name.
NO_MATCH = 4


@dataclass(frozen=True)
class SearchToken:
    """One word of the query. `folded` compares against the `normalized_name`
    columns and stored aliases; `typed` is all a column with no normalized twin
    can match."""

    folded: str
    typed: str


def search_tokens(query: str) -> list[SearchToken]:
    """Comparison tokens in the order typed. `[]` means no search."""
    folded_pieces = normalized_name(query).split()
    typed_pieces = _split_typed(query)
    # Folding can merge or drop pieces, so the typed split is only trusted when
    # it lines up one-to-one.
    if len(typed_pieces) != len(folded_pieces):
        typed_pieces = folded_pieces
    return [
        SearchToken(folded=folded, typed=typed)
        for folded, typed in zip(folded_pieces, typed_pieces, strict=True)
    ][:MAX_TOKENS]


def _split_typed(query: str) -> list[str]:
    return (
        "".join(
            character if character.isalnum() else " " for character in query
        )
        .lower()
        .split()
    )


def tokens_filter(
    tokens: Sequence[SearchToken],
    fields: Sequence[str],
    extra: Callable[[SearchToken], Iterable[Q]] | None = None,
) -> Q:
    """AND across tokens, OR across fields: every token must be found, each one
    possibly in a different field.

    `extra` clauses should be `Exists(...)` subqueries rather than joins — a row
    with four matching aliases stays one row, so no `distinct()` is needed and
    the ordering survives.
    """
    combined = Q()
    for token in tokens:
        clause = Q()
        for field in fields:
            clause |= Q(**{f"{field}__icontains": token.folded})
            if token.typed != token.folded:
                clause |= Q(**{f"{field}__icontains": token.typed})
        for extra_clause in extra(token) if extra else ():
            clause |= extra_clause
        combined &= clause
    return combined


def relevance(field: str, query: str) -> Case:
    """The ladder as an ORDER BY expression on one field."""
    needle = query.strip()
    if not needle:
        return Case(default=Value(NO_MATCH), output_field=IntegerField())
    return Case(
        When(**{f"{field}__iexact": needle}, then=Value(EXACT)),
        When(**{f"{field}__istartswith": needle}, then=Value(PREFIX)),
        # A leading space, not a regex word boundary: `iregex`'s `\\m` is
        # PostgreSQL-only and development runs on SQLite.
        When(**{f"{field}__icontains": f" {needle}"}, then=Value(WORD_START)),
        When(**{f"{field}__icontains": needle}, then=Value(CONTAINS)),
        default=Value(NO_MATCH),
        output_field=IntegerField(),
    )


def relevance_order(field: str, tokens: Sequence[SearchToken]) -> list[Case]:
    """Whole query, then first token — a multi-token query reaches only
    `NO_MATCH` on the whole-string ladder, so the second rung breaks the tie."""
    if not tokens:
        return []
    whole = " ".join(token.folded for token in tokens)
    order = [relevance(field, whole)]
    if len(tokens) > 1:
        order.append(relevance(field, tokens[0].folded))
    return order


def ingredient_search(user_id: object, tokens: Sequence[SearchToken]) -> Q:
    """Name, normalized key, linked aliases, and the supplier's own wording."""

    def extra(token: SearchToken) -> Iterable[Q]:
        yield Exists(
            RecipeLineMatch.objects.filter(
                user_id=user_id,
                ingredient=OuterRef("pk"),
                normalized_text__icontains=token.folded,
            )
        )
        yield Exists(
            SupplierItem.objects.filter(
                user_id=user_id, ingredient=OuterRef("pk")
            ).filter(
                Q(title__icontains=token.folded)
                | Q(title__icontains=token.typed)
                | Q(external_id__icontains=token.typed)
            )
        )
        yield Exists(
            CatalogIngredientAlias.objects.filter(
                ingredient_id=OuterRef("catalog_ingredient_id"),
                is_active=True,
                normalized_text__icontains=token.folded,
            )
        )

    return tokens_filter(tokens, ("name", "normalized_name"), extra)


def recipe_search(_user_id: object, tokens: Sequence[SearchToken]) -> Q:
    """Title, code, public id, owner category name, and linked aliases.

    Callers apply their owned/shared access queryset before this predicate, so
    category and alias matching follow each recipe's owner rather than the
    viewer's tenant.
    """

    def extra(token: SearchToken) -> Iterable[Q]:
        yield Q(
            category__user_id=F("user_id"),
            category__name__icontains=token.folded,
        )
        yield Q(
            category__user_id=F("user_id"),
            category__name__icontains=token.typed,
        )
        yield Exists(
            RecipeLineMatch.objects.filter(
                user_id=OuterRef("user_id"),
                component_recipe=OuterRef("pk"),
                normalized_text__icontains=token.folded,
            )
        )

    return tokens_filter(tokens, ("title", "code", "public_id"), extra)
