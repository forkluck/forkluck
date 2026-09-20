"""Phone sign-in: an emailed code becomes a long-lived device token.

The views are plain functions; mobile_urls.py wraps the two code steps as
anonymous POSTs and the rest with the device-token guard. `device_list`
also answers on the internal table so the web profile page can show and
revoke the phones an account has signed in.
"""

import secrets

from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.http import HttpRequest, JsonResponse
from django.utils import timezone
from django.views.decorators.cache import never_cache

from ...http.auth import DEVICE_TOKEN_PREFIX, device_token_digest
from ...http.request import error, read_json
from ...integrations import emails
from ...integrations.emails import EmailNotConfigured
from ...models import DeviceToken, EmailVerificationCode, User
from ...throttling import client_ip
from ...verification import issue_code, verify_code
from ..shared.recipe_invites import claim_invitations
from ..shared.values import iso, text_value
from .views import notify_owner_of_first_verified_sign_in

DEVICE_NAME_MAX_LENGTH = 100


def request_code(request: HttpRequest) -> JsonResponse:
    """Email a sign-in code to an address. Unknown addresses get the same answer."""
    try:
        body = read_json(request)
        email = text_value(body.get("email"), "Email", max_length=254).strip().lower()
        validate_email(email)
    except (ValueError, ValidationError) as exc:
        messages = exc.messages if isinstance(exc, ValidationError) else [str(exc)]
        return error(messages[0])

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
    if user is None or not verify_code(
        email, EmailVerificationCode.PURPOSE_DEVICE, code
    ):
        return error("That code is wrong or expired. Request a new one.")

    now = timezone.now()
    # Typing the code proves the address, exactly as a password reset does.
    if user.email_verified_at is None:
        user.email_verified_at = now
        user.save(update_fields=["email_verified_at"])
        claim_invitations(user)
        notify_owner_of_first_verified_sign_in(user)

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
