"""The internal-secret guard and the device-token guard.

A leaf module: it reads a header, a setting and the device-token table and
knows nothing about domains, so internal_urls.py and mobile_urls.py can wrap
any view with it.
"""

import hashlib
import secrets
from collections.abc import Callable
from datetime import timedelta
from functools import wraps

from django.conf import settings
from django.http import HttpRequest, JsonResponse
from django.utils import timezone

from ..models import DeviceToken
from .request import error

DEVICE_TOKEN_PREFIX = "fdt_"
# A phone's last-used stamp is written at most this often, so a scroll
# through the recipe list is not a write per request.
LAST_USED_GRANULARITY = timedelta(minutes=15)


def secret_matches(request: HttpRequest) -> bool:
    """The one place the header is compared, so every guard answers alike."""
    received = request.headers.get("X-Forkluck-Internal-Secret", "")
    expected = settings.FORKLUCK_INTERNAL_SECRET
    return bool(expected) and secrets.compare_digest(received, expected)


def internal_user(view: Callable[..., JsonResponse]):
    @wraps(view)
    def wrapped(request: HttpRequest, *args, **kwargs):
        if not secret_matches(request):
            return error("Not found", 404)
        if not request.user.is_authenticated:
            return error("Authentication required", 401)
        return view(request, *args, **kwargs)

    return wrapped


def _secret_only(view: Callable[..., JsonResponse]):
    """The secret check with no session check: the two categories below."""

    @wraps(view)
    def wrapped(request: HttpRequest, *args, **kwargs):
        if not secret_matches(request):
            return error("Not found", 404)
        return view(request, *args, **kwargs)

    return wrapped


def internal_guest(view: Callable[..., JsonResponse]):
    """The URL carries its own proof, so no user is required; a wrong or
    missing internal secret still answers 404."""
    return _secret_only(view)


def internal_system(view: Callable[..., JsonResponse]):
    """The Next process acting as itself, not on behalf of a browser.

    The Drive watcher runs on a timer with no request and no session behind
    it, so there is no `request.user` to read: the workspace a system call
    means is named in the body. The secret alone authorizes it.
    """
    return _secret_only(view)


def device_token_digest(token: str) -> str:
    """The one way a bearer token is hashed, at issue and at lookup."""
    return hashlib.sha256(token.encode()).hexdigest()


def _device_from(request: HttpRequest) -> DeviceToken | None:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    token = header[7:].strip()
    # Reject anything that is not one of ours before the database is asked.
    if not token.startswith(DEVICE_TOKEN_PREFIX) or not 40 <= len(token) <= 128:
        return None
    row = (
        DeviceToken.objects.select_related("user")
        .filter(token_digest=device_token_digest(token))
        .first()
    )
    if row is None or not row.user.is_active:
        return None
    if not secrets.compare_digest(
        row.credential_hash, row.user.get_session_auth_hash()
    ):
        return None
    return row


def device_user(view: Callable[..., JsonResponse]):
    """A phone acting for its user: the bearer token alone authorizes.

    No session is read or written, so no cookie is ever set on the answer.
    A missing, foreign, revoked or password-rotated token answers 401.
    """

    @wraps(view)
    def wrapped(request: HttpRequest, *args, **kwargs):
        row = _device_from(request)
        if row is None:
            response = error("Authentication required", 401)
            response["WWW-Authenticate"] = 'Bearer realm="Forkluck"'
            return response
        request.user = row.user
        request.device_token = row
        now = timezone.now()
        if (
            row.last_used_at is None
            or now - row.last_used_at >= LAST_USED_GRANULARITY
        ):
            DeviceToken.objects.filter(pk=row.pk).update(last_used_at=now)
        return view(request, *args, **kwargs)

    return wrapped
