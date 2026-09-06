"""Tenant-safe recipe access shared by browse, detail, health, and search.

Two grants reach the same recipe: a `RecipeShare` on that one recipe, and a
`KitchenMembership` on the workspace that owns it. Both are dormant while the
recipient is unverified. Where they overlap the stronger one wins — an editor
of the kitchen stays an editor of a recipe someone also shared as a viewer —
so that the editable queryset and `recipe_permission` cannot disagree.
"""

from uuid import UUID

from django.db.models import Prefetch, Q

from ...models import KitchenMembership, Recipe, RecipeShare, User


def kitchen_roles(user: User) -> dict[UUID, str]:
    """Owner id -> role for every kitchen this user belongs to.

    Memoized on the user instance, which lives for one request, so the
    per-row permission calls in a browse page cost one query between them.
    Empty while the address is unverified: a membership is a promise to an
    account, and an unclaimed address is not one yet.
    """
    cached = getattr(user, "_kitchen_roles", None)
    if cached is None:
        cached = (
            {}
            if user.email_verified_at is None
            else {
                owner_id: role
                for owner_id, role in KitchenMembership.objects.filter(
                    member=user
                ).values_list("owner_id", "role")
            }
        )
        user._kitchen_roles = cached
    return cached


def _membership(user: User, role: str | None = None) -> Q:
    """The membership join, spelled as a join rather than as `kitchen_roles`.

    A subquery of ids would be a second query on every read that scopes
    recipes, including the search index, whose count is pinned at two.
    """
    filters = {
        "user__members__member": user,
        "user__members__member__email_verified_at__isnull": False,
    }
    if role is not None:
        filters["user__members__role"] = role
    return Q(**filters)


def accessible_recipe_queryset(
    user: User, *, prefetch_shares: bool = True, kitchens: bool = True
):
    visible = Q(user=user) | Q(
        shares__recipient=user,
        shares__recipient__email_verified_at__isnull=False,
    )
    if kitchens:
        visible |= _membership(user)
    rows = Recipe.objects.filter(visible).distinct()
    if prefetch_shares:
        rows = rows.prefetch_related(
            Prefetch(
                "shares",
                queryset=RecipeShare.objects.select_related("recipient"),
                to_attr="_all_shares",
            )
        )
    return rows


def editable_recipe_queryset(user: User):
    return Recipe.objects.filter(
        Q(user=user)
        | Q(
            shares__recipient=user,
            shares__recipient__email_verified_at__isnull=False,
            shares__role=RecipeShare.EDITOR,
        )
        | _membership(user, RecipeShare.EDITOR)
    ).distinct()


def recipe_permission(recipe: Recipe, user: User) -> str | None:
    if recipe.user_id == user.id:
        return "owner"
    if user.email_verified_at is None:
        return None
    share = next((share for share in getattr(recipe, "_all_shares", []) if share.recipient_id == user.id), None)
    if share is None:
        share = RecipeShare.objects.filter(recipe=recipe, recipient=user).first()
    roles = {kitchen_roles(user).get(recipe.user_id), share.role if share else None}
    if RecipeShare.EDITOR in roles:
        return RecipeShare.EDITOR
    return RecipeShare.VIEWER if RecipeShare.VIEWER in roles else None
