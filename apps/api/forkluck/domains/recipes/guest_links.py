"""Capability tokens for guest recipe links and recipe books.

The raw token only ever exists in the emailed URL; the row stores its hash,
so a database read cannot mint a working link.
"""

import hashlib

from ...models import RecipeBook, RecipeGuestLink


def hash_guest_token(token: str) -> str:
    # The raw token only, no SECRET_KEY pepper: 256 bits of randomness needs
    # none, and a key rotation must not kill links that never expire.
    return hashlib.sha256(token.encode()).hexdigest()


def resolve_guest_link(token: str) -> RecipeGuestLink | None:
    """The link a raw token names, or None.

    No constant-time compare: the token is 256 bits of randomness and the
    lookup is an indexed equality on its hash, so there is no per-character
    signal to time, the same reasoning as the OAuth state nonce.
    """
    if not token or len(token) > 64:
        return None
    return (
        RecipeGuestLink.objects.select_related("recipe__user")
        .filter(token_hash=hash_guest_token(token))
        .first()
    )


def resolve_book_link(token: str) -> RecipeBook | None:
    """The book a raw token names, or None.

    Books and single-recipe links share one token space and one hash, so the
    same reasoning about constant-time compares applies here too.
    """
    if not token or len(token) > 64:
        return None
    return (
        RecipeBook.objects.select_related("user")
        .filter(token_hash=hash_guest_token(token))
        .first()
    )
