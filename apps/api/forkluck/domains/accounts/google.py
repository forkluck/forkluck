"""Google sign-in state, account resolution and activation."""

import logging
import re
import secrets
from datetime import timedelta
from urllib.parse import urlencode

from django.conf import settings
from django.contrib.auth import login
from django.core import signing
from django.db import IntegrityError, transaction
from django.http import HttpRequest, HttpResponse, HttpResponseRedirect, JsonResponse
from django.utils import timezone
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET

from ...integrations import google_sign_in as google
from ...integrations import turnstile
from ...models import User
from ...services import seed_user_workspace
from ...throttling import Throttled, client_ip, hit
from ..shared.recipe_invites import claim_invitations
from . import views as account_views

logger = logging.getLogger(__name__)
STATE_SALT = "google-sign-in"
STATE_MAX_AGE_S = 600
SESSION_KEY = "google_sign_in"


def safe_next(value) -> str:
    """Keep in sync with apps/web/lib/auth-next.ts's safeAuthNext."""
    if not isinstance(value, str) or len(value.encode("utf-16-le", errors="surrogatepass")) > 16384:
        return "/"
    if not value.startswith("/") or value.startswith("//"):
        return "/"
    return "/" if re.search(r"[\\\x00-\x20\x7f]", value) else value


def mint_state(request: HttpRequest, next_path: str) -> str:
    nonce = secrets.token_urlsafe(32)
    request.session[SESSION_KEY] = {
        "nonce": nonce,
        "oidc_nonce": secrets.token_urlsafe(32),
        "verifier": google.new_code_verifier(),
        "next": safe_next(next_path),
    }
    return signing.dumps({"n": nonce}, salt=STATE_SALT)


def consume_state(request: HttpRequest, raw: str) -> dict | None:
    # Retire before validation, including malformed, cancelled and stale flows.
    held = request.session.pop(SESSION_KEY, None)
    try:
        state = signing.loads(raw, salt=STATE_SALT, max_age=STATE_MAX_AGE_S)
    except signing.BadSignature:
        return None
    if not isinstance(held, dict) or not isinstance(state, dict):
        return None
    nonce = state.get("n")
    if not isinstance(nonce, str) or not secrets.compare_digest(
        str(held.get("nonce") or "").encode(), nonce.encode()
    ):
        return None
    return held


def failure(code: str, next_path: str = "/") -> HttpResponseRedirect:
    params = {"error": code}
    if safe_next(next_path) != "/":
        params["next"] = safe_next(next_path)
    return HttpResponseRedirect("/login?" + urlencode(params))


def resolve_user(identity: dict[str, str]) -> User:
    # A unique email/subject may be inserted while our first SELECT sees no
    # row. Retry resolution after rolling back the losing transaction.
    for attempt in range(2):
        try:
            with transaction.atomic():
                user = User.objects.select_for_update().filter(
                    google_subject=identity["sub"]
                ).first()
                if user is not None:
                    if user.email != identity["email"]:
                        logger.info("Google email drift for user %s; kept account address", user.pk)
                else:
                    user = User.objects.select_for_update().filter(email=identity["email"]).first()
                    if user is None:
                        user = User.objects.create_user(
                            email=identity["email"],
                            name=identity["name"] or identity["email"].split("@", 1)[0][:150],
                            password=None,
                            email_verified_at=timezone.now(),
                            google_subject=identity["sub"],
                            first_sign_in_notification_pending=True,
                        )
                        seed_user_workspace(user)
                        claim_invitations(user)
                        return user
                    if not user.is_active:
                        return user
                    if not user.google_subject:
                        user.google_subject = identity["sub"]
                        user.save(update_fields=["google_subject"])
                    elif user.google_subject != identity["sub"]:
                        logger.info("Google email match for user %s; kept existing subject", user.pk)
                if user.is_active and user.email_verified_at is None:
                    user.email_verified_at = timezone.now()
                    user.save(update_fields=["email_verified_at"])
                    claim_invitations(user)
                return user
        except IntegrityError:
            if attempt:
                raise
    raise AssertionError("Unreachable")


@never_cache
@require_GET
def google_start(request: HttpRequest) -> HttpResponse:
    next_values = request.GET.getlist("next")
    next_path = safe_next(next_values[0] if len(next_values) == 1 else None)
    if not google.is_configured():
        return failure("google-not-configured", next_path)
    try:
        hit("google-start:ip", client_ip(request), limit=30,
            window=timedelta(minutes=15), message="Too many Google sign-in attempts")
    except Throttled:
        return failure("google-rate-limited", next_path)
    state = mint_state(request, next_path)
    held = request.session[SESSION_KEY]
    response = HttpResponseRedirect(google.authorize_url(
        state, held["oidc_nonce"], google.pkce_challenge(held["verifier"])
    ))
    response["Referrer-Policy"] = "no-referrer"
    return response


@never_cache
@require_GET
def google_callback(request: HttpRequest) -> HttpResponse:
    held = request.session.get(SESSION_KEY, {})
    next_path = safe_next(held.get("next")) if isinstance(held, dict) else "/"
    state = consume_state(request, request.GET.get("state", ""))
    try:
        hit("google-callback:ip", client_ip(request), limit=60,
            window=timedelta(minutes=15), message="Too many Google sign-in attempts")
    except Throttled:
        return failure("google-rate-limited", next_path)
    if request.GET.get("error"):
        code = "google-cancelled" if request.GET["error"] == "access_denied" else "google-failed"
        return failure(code, next_path)
    if state is None:
        return failure("google-state", next_path)
    if not google.is_configured():
        return failure("google-not-configured", next_path)
    code = request.GET.get("code")
    if not code:
        return failure("google-failed", next_path)
    try:
        token = google.exchange_code(code, state["verifier"])
        identity = google.validate_claims(google.decode_id_token(token), state["oidc_nonce"])
    except google.GoogleUnverifiedEmail:
        return failure("google-unverified-email", next_path)
    except google.GoogleSignInError:
        return failure("google-failed", next_path)
    if identity["email"] == "user@user.com" and not settings.FORKLUCK_ALLOW_DEMO_ACCOUNT:
        return failure("google-failed", next_path)
    user = resolve_user(identity)
    if user.email == "user@user.com" and not settings.FORKLUCK_ALLOW_DEMO_ACCOUNT:
        return failure("google-failed", next_path)
    if not user.is_active:
        return failure("google-inactive", next_path)
    login(request, user)
    account_views.notify_owner_of_first_verified_sign_in(user)
    account_views.sync_newsletter_member(user)
    return account_views.mark_signed_in(HttpResponseRedirect(next_path))


def auth_methods(request: HttpRequest) -> JsonResponse:
    return JsonResponse(
        {
            "google": google.is_configured(),
            # Public by design: the site key only names the widget the signup
            # page renders. The secret never leaves Django.
            "turnstileSiteKey": (
                settings.TURNSTILE_SITE_KEY if turnstile.configured() else None
            ),
        }
    )
