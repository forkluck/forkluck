"""Phone sign-in: an emailed code becomes a long-lived device token.

The views are plain functions; mobile_urls.py wraps the two code steps as
anonymous POSTs and the rest with the device-token guard. `device_list`
also answers on the internal table so the web profile page can show and
revoke the phones an account has signed in.
"""

import hmac
import secrets

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.http import HttpRequest, JsonResponse
from django.utils import timezone
from django.views.decorators.cache import never_cache

from ... import throttling
from ...http.auth import DEVICE_TOKEN_PREFIX, device_token_digest
from ...http.request import error, read_json
from ...integrations import app_attest, emails
from ...integrations.emails import EmailNotConfigured
from ...models import DeviceToken, EmailVerificationCode, User
from ...throttling import Throttled, client_ip
from ...verification import (
    MAX_SIGN_IN_ATTEMPTS,
    SIGN_IN_WINDOW,
    issue_code,
    verify_code,
)
from ..shared.recipe_invites import claim_invitations
from ..shared.values import iso, text_value
from .views import (
    create_account,
    notify_owner_of_first_verified_sign_in,
    registration_values,
    sync_newsletter_member,
    throttle_registration,
)

DEVICE_NAME_MAX_LENGTH = 100
ATTEST_FAILED = "We couldn't verify this device. Try again."


def is_review_account(email: str) -> bool:
    """The App Review address, whose sign-in code is fixed rather than emailed."""
    review = settings.FORKLUCK_APP_REVIEW_EMAIL
    return bool(review) and email == review


def _code_is_right(email: str, code: str) -> bool:
    if not is_review_account(email):
        return verify_code(email, EmailVerificationCode.PURPOSE_DEVICE, code)
    # A fixed code has no row to count attempts on, so the sign-in throttle
    # bounds guessing here the way the code row's attempt cap does elsewhere.
    try:
        throttling.hit(
            "device:review",
            email,
            limit=MAX_SIGN_IN_ATTEMPTS,
            window=SIGN_IN_WINDOW,
            message="Too many attempts. Wait a few minutes and try again.",
        )
    except throttling.Throttled:
        return False
    return hmac.compare_digest(code, settings.FORKLUCK_APP_REVIEW_CODE)


def request_code(request: HttpRequest) -> JsonResponse:
    """Email a sign-in code to an address. Unknown addresses get the same answer."""
    try:
        body = read_json(request)
        email = text_value(body.get("email"), "Email", max_length=254).strip().lower()
        validate_email(email)
    except (ValueError, ValidationError) as exc:
        messages = exc.messages if isinstance(exc, ValidationError) else [str(exc)]
        return error(messages[0])

    # Nothing to send: the reviewer types the fixed code from the review notes.
    if is_review_account(email):
        return JsonResponse({"ok": True})

    # Check configuration before looking up the account so a broken email
    # setup cannot turn this endpoint into an address-existence oracle.
    if not emails.is_configured():
        return error("Email sending is not configured", 500)

    user = User.objects.filter(email=email, is_active=True).first()
    if user is not None:
        try:
            issue_code(
                email,
                EmailVerificationCode.PURPOSE_DEVICE,
                client_ip=client_ip(request),
            )
        except EmailNotConfigured:
            return error("Email sending is not configured", 500)
        except ValueError as exc:
            return error(str(exc))
    return JsonResponse({"ok": True})


def app_attest_challenge(request: HttpRequest) -> JsonResponse:
    """A challenge for the phone's attestation key, before it registers."""
    try:
        body = read_json(request)
        key_id = app_attest.key_id_bytes(body.get("keyId"))
    except ValueError as exc:
        return error(str(exc))
    except app_attest.AttestationInvalid:
        return error("Key id is required")
    return JsonResponse({"challenge": app_attest.issue_challenge(key_id)})


def register(request: HttpRequest) -> JsonResponse:
    """Create an account from the phone. The same fields and checks as the
    web form, with App Attest where the web has Turnstile; the code that
    follows is a `device` one, so `verify-code` finishes the sign-up by
    minting the token, and `request-code` is the resend."""
    try:
        throttle_registration(request)
    except Throttled as exc:
        return error(str(exc), 429, code="rate_limited")

    try:
        body = read_json(request)
        name, email, password = registration_values(body)
    except (ValueError, ValidationError) as exc:
        messages = exc.messages if isinstance(exc, ValidationError) else [str(exc)]
        return error(messages[0])

    # After field validation, so a bad password does not spend the one-time
    # attestation, and before any row is written. Unset app id skips the check.
    fields = {}
    if app_attest.configured():
        try:
            key_id = app_attest.verify_attestation(
                body.get("keyId"), body.get("attestation"), body.get("challenge")
            )
        except app_attest.AttestationInvalid:
            return error(ATTEST_FAILED, code="verification_failed")
        if User.objects.filter(app_attest_key_id=key_id).exists():
            return error(ATTEST_FAILED, code="verification_failed")
        fields["app_attest_key_id"] = key_id

    try:
        user = create_account(name, email, password, **fields)
    except ValueError as exc:
        return error(str(exc))

    try:
        issue_code(email, EmailVerificationCode.PURPOSE_DEVICE, client_ip=client_ip(request))
    except (EmailNotConfigured, ValueError) as exc:
        # Roll the fresh account back so the address can simply retry.
        user.delete()
        if isinstance(exc, EmailNotConfigured):
            return error("Email sending is not configured", 500)
        return error(str(exc))
    return JsonResponse({"pendingVerification": True, "email": email}, status=202)


def device_json(row: DeviceToken) -> dict:
    return {
        "id": str(row.id),
        "name": row.name,
        "createdAt": iso(row.created_at),
        "lastUsedAt": iso(row.last_used_at) if row.last_used_at else None,
    }


@never_cache
def redeem_code(request: HttpRequest) -> JsonResponse:
    """Trade a correct code for a device token. The token is shown once."""
    try:
        body = read_json(request)
        email = text_value(body.get("email"), "Email", max_length=254).strip().lower()
        code = text_value(body.get("code"), "Code", max_length=6).strip()
        name = text_value(
            body.get("deviceName", ""),
            "Device name",
            max_length=DEVICE_NAME_MAX_LENGTH,
            allow_blank=True,
        )
        validate_email(email)
    except (ValueError, ValidationError) as exc:
        messages = exc.messages if isinstance(exc, ValidationError) else [str(exc)]
        return error(messages[0])

    user = User.objects.filter(email=email, is_active=True).first()
    if user is None or not _code_is_right(email, code):
        return error("That code is wrong or expired. Request a new one.")

    now = timezone.now()
    # Typing the code proves the address, exactly as a password reset does.
    if user.email_verified_at is None:
        user.email_verified_at = now
        user.save(update_fields=["email_verified_at"])
        claim_invitations(user)
        notify_owner_of_first_verified_sign_in(user)
        sync_newsletter_member(user)

    # One sign-in retires every other code for the address, so a code
    # requested earlier cannot mint a second token later.
    EmailVerificationCode.objects.filter(
        email=email,
        purpose=EmailVerificationCode.PURPOSE_DEVICE,
        used_at__isnull=True,
    ).update(used_at=now)

    credential_hash = user.get_session_auth_hash()
    # Rows a password change already signed out are dead weight; sweep them
    # while the account is here.
    DeviceToken.objects.filter(user=user).exclude(
        credential_hash=credential_hash
    ).delete()

    token = DEVICE_TOKEN_PREFIX + secrets.token_urlsafe(32)
    row = DeviceToken.objects.create(
        token_digest=device_token_digest(token),
        user=user,
        credential_hash=credential_hash,
        name=name,
    )
    return JsonResponse({"token": token, "device": device_json(row)})


def sign_out(request: HttpRequest) -> JsonResponse:
    """Revoke the token this request presented. Never gated by billing: an
    expired or locked account can still sign a phone out."""
    request.device_token.delete()
    return JsonResponse({"ok": True})


def device_list(request: HttpRequest) -> JsonResponse:
    rows = DeviceToken.objects.filter(
        user=request.user,
        credential_hash=request.user.get_session_auth_hash(),
    ).order_by("-created_at", "id")
    return JsonResponse({"items": [device_json(row) for row in rows]})
