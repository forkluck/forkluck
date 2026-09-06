"""Claiming the invitations that were waiting for an address to verify.

A guest link, a recipe book and a kitchen invite are all promises made to an
email address.
Verification is when the address becomes an account, so it is also when the
promises are kept: each turns into the share or membership row it always
described and stops being a second way in.
"""

from django.db import transaction

from ...models import (
    KitchenInvite,
    KitchenMembership,
    RecipeBook,
    RecipeGuestLink,
    RecipeShare,
    User,
)


def claim_invitations(user: User) -> int:
    """Turn every invitation for this user's address into the row it promised.

    Returns how many shares and memberships were created or updated. An
    invitation to the user's own recipe or own kitchen is simply dropped — an
    owner needs no grant — so the count can be lower than the number of
    invitations claimed. Idempotent: the invitations are gone afterwards, so
    a second call claims nothing.
    """
    claimed = 0
    with transaction.atomic():
        # Books first: a recipe reached by both a book and its own link takes
        # the link's role, because the more specific grant should win.
        books = RecipeBook.objects.filter(email__iexact=user.email)
        for book in books.prefetch_related("items__recipe"):
            for item in book.items.all():
                if item.recipe.user_id != user.id:
                    RecipeShare.objects.update_or_create(
                        recipe=item.recipe,
                        recipient=user,
                        defaults={"role": book.role},
                    )
                    claimed += 1
            book.delete()
        links = RecipeGuestLink.objects.filter(email__iexact=user.email)
        for link in links.select_related("recipe"):
            if link.recipe.user_id != user.id:
                RecipeShare.objects.update_or_create(
                    recipe=link.recipe,
                    recipient=user,
                    defaults={"role": link.role},
                )
                claimed += 1
            link.delete()
        for invite in KitchenInvite.objects.filter(email__iexact=user.email):
            if invite.owner_id != user.id:
                KitchenMembership.objects.update_or_create(
                    owner_id=invite.owner_id,
                    member=user,
                    defaults={"role": invite.role},
                )
                claimed += 1
            invite.delete()
    return claimed
