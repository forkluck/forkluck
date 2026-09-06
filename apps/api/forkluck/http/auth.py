"""The internal-secret guard.

A leaf module: it reads a header and a setting and knows nothing about
domains, so internal_urls.py can wrap any view with it.
"""

import secrets
from collections.abc import Callable
from functools import wraps

from django.conf import settings
from django.http import HttpRequest, JsonResponse

from .request import error


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
