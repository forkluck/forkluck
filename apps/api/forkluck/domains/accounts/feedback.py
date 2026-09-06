"""The confidential Fider client can read a verified Forkluck identity.

This deliberately exposes only authorization code, token exchange and profile:
no client registration, password grant, refresh token, or application data.
Fider validates its browser-bound state; we bind every code to its one exact
callback and authenticate the server exchanging it. Secrets are never put in
browser URLs, and only digests of one-use codes and bearer tokens are stored.
"""

import base64
import binascii
import hashlib
import secrets
from datetime import timedelta
from urllib.parse import unquote, urlencode

from django.conf import settings
from django.db import transaction
from django.http import HttpResponseRedirect, JsonResponse
from django.utils import timezone
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from ...models import FeedbackGrant
from ...throttling import Throttled, client_ip, hit

CLIENT_ID = "forkluck-feedback"
CODE_LIFETIME = timedelta(minutes=2)
TOKEN_LIFETIME = timedelta(minutes=2)


def _digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def _error(code, status=400):
    response = JsonResponse({"error": code}, status=status)
    if status == 401:
        response["WWW-Authenticate"] = 'Bearer realm="Forkluck feedback"'
    return response


def _enabled():
    return bool(settings.FORKLUCK_FEEDBACK_CLIENT_SECRET)


def _callback():
    return settings.FORKLUCK_FEEDBACK_ORIGIN + "/oauth/_forkluck/callback"


def _single(params):
    return all(len(params.getlist(key)) == 1 for key in params)


def _verified(user):
    return user.is_authenticated and user.is_active and user.email_verified_at is not None


@never_cache
@require_GET
def authorize(request):
    if not _enabled():
        return _error("not_found", 404)
    params = request.GET
    # Refuse invalid requests locally: never redirect to unvalidated input.
    if (
        not _single(params)
        or params.get("client_id") != CLIENT_ID
        or params.get("redirect_uri") != _callback()
        or params.get("response_type") != "code"
        or params.get("scope") != "profile"
        or not 1 <= len(params.get("state", "")) <= 2048
        or params.get("code_challenge")
    ):
        return _error("invalid_request")
    if not _verified(request.user):
        params = {"next": request.get_full_path()}
        if request.user.is_authenticated:
            # A legacy unverified session must reach the password/code form,
            # rather than bounce between the signed-in login page and here.
            params["reauth"] = "1"
        return HttpResponseRedirect("/login?" + urlencode(params))
    try:
        hit("feedback-authorize", str(request.user.pk), limit=30,
            window=timedelta(minutes=5), message="Too many sign-in requests.")
    except Throttled:
        return _error("rate_limited", 429)
    now = timezone.now()
    FeedbackGrant.objects.filter(expires_at__lt=now - TOKEN_LIFETIME).delete()
    code = secrets.token_urlsafe(32)
    FeedbackGrant.objects.create(
        code_digest=_digest(code), user=request.user,
        credential_hash=request.user.get_session_auth_hash(),
        expires_at=now + CODE_LIFETIME,
    )
    response = HttpResponseRedirect(_callback() + "?" + urlencode({
        "code": code, "state": params["state"],
    }))
    response["Referrer-Policy"] = "no-referrer"
    return response


def _client_authenticated(request):
    client_id = request.POST.get("client_id", "")
    client_secret = request.POST.get("client_secret", "")
    authorization = request.headers.get("Authorization", "")
    if authorization:
        # Do not accept two simultaneous client authentication mechanisms.
        if client_id or client_secret or not authorization.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(authorization[6:], validate=True).decode()
            client_id, client_secret = map(unquote, decoded.split(":", 1))
        except (ValueError, UnicodeError, binascii.Error):
            return False
    return (
        secrets.compare_digest(client_id.encode(), CLIENT_ID.encode())
        and secrets.compare_digest(client_secret.encode(), settings.FORKLUCK_FEEDBACK_CLIENT_SECRET.encode())
    )


@never_cache
@csrf_exempt  # Server-to-server credentials replace browser session/CSRF auth.
@require_POST
def token(request):
    if not _enabled():
        return _error("not_found", 404)
    if request.content_type != "application/x-www-form-urlencoded" or not _single(request.POST):
        return _error("invalid_request")
    try:
        hit("feedback-token", client_ip(request), limit=120,
            window=timedelta(minutes=5), message="Too many token requests.")
    except Throttled:
        return _error("rate_limited", 429)
    if not _client_authenticated(request):
        return _error("invalid_client", 401)
    if request.POST.get("grant_type") != "authorization_code":
        return _error("unsupported_grant_type")
    if request.POST.get("redirect_uri") != _callback():
        return _error("invalid_grant")
    code = request.POST.get("code", "")
    if not 32 <= len(code) <= 128:
        return _error("invalid_grant")
    now = timezone.now()
    with transaction.atomic():
        grant = FeedbackGrant.objects.select_for_update().select_related("user").filter(
            code_digest=_digest(code),
        ).first()
        if grant is None:
            return _error("invalid_grant")
        if (
            grant.access_digest is not None or grant.expires_at <= now
            or not _verified(grant.user)
            or not secrets.compare_digest(grant.credential_hash, grant.user.get_session_auth_hash())
        ):
            # Replaying a code also revokes the token it previously issued.
            grant.delete()
            return _error("invalid_grant")
        access = secrets.token_urlsafe(32)
        grant.access_digest = _digest(access)
        grant.access_expires_at = now + TOKEN_LIFETIME
        grant.save(update_fields=["access_digest", "access_expires_at"])
    response = JsonResponse({
        "access_token": access, "token_type": "Bearer",
        "expires_in": int(TOKEN_LIFETIME.total_seconds()), "scope": "profile",
    })
    response["Pragma"] = "no-cache"
    return response


@never_cache
@require_GET
def profile(request):
    if not _enabled():
        return _error("not_found", 404)
    authorization = request.headers.get("Authorization", "")
    if not authorization.startswith("Bearer ") or not 32 <= len(authorization[7:]) <= 128:
        return _error("invalid_token", 401)
    grant = FeedbackGrant.objects.select_related("user").filter(
        access_digest=_digest(authorization[7:]), access_expires_at__gt=timezone.now(),
    ).first()
    if (
        grant is None or not _verified(grant.user)
        or not secrets.compare_digest(grant.credential_hash, grant.user.get_session_auth_hash())
    ):
        return _error("invalid_token", 401)
    return JsonResponse({
        "id": str(grant.user.pk), "name": (grant.user.name.strip() or "Forkluck member")[:100],
        "email": grant.user.email,
    })
