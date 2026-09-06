"""Sign-up, verification, password reset and session endpoints.

The public views keep their own method and CSRF decorators because
public_urls.py routes to them directly. internal_session is a plain
function: its guard is applied by internal_urls.py.
"""

import logging
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import authenticate, login, logout, update_session_auth_hash
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from django.db.models.functions import Lower
from django.http import HttpRequest, JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

from ...integrations.emails import (
    EmailNotConfigured,
    send_new_user_notification,
)
from ...integrations.ghost_members import (
    is_configured as newsletter_configured,
    newsletter_status,
    upsert_member,
)
from ...http.request import error, read_json
from ...models import EmailVerificationCode, KitchenMembership, Recipe, User
from ...services import seed_user_workspace
from ...throttling import Throttled, client_ip, hit, reset
from ...verification import (
    check_sign_in_allowed,
    clear_sign_in_throttle,
    issue_code,
    verify_code,
)
from ..shared.recipe_invites import claim_invitations
from ..shared.values import text_value
from .billing import billing_json
from .serializers import user_json

logger = logging.getLogger(__name__)


def mark_signed_in(response: JsonResponse) -> JsonResponse:
    """Tell forkluck.com a session exists so its header can say Log out.

    Readable by script and shared with the marketing host on purpose; it
    carries no identity and grants nothing.
    """
    response.set_cookie(
        settings.FORKLUCK_SIGNED_IN_COOKIE_NAME,
        "1",
        max_age=settings.SESSION_COOKIE_AGE,
        domain=settings.FORKLUCK_SIGNED_IN_COOKIE_DOMAIN,
        path="/",
        secure=settings.SESSION_COOKIE_SECURE,
        httponly=False,
        samesite="Lax",
    )
    return response


def sync_newsletter_member(user: User) -> None:
    """Mirror one verified account into the Ghost newsletter, best effort.

    upsert_member never raises and never re-subscribes somebody Ghost has
    already unsubscribed, so this is safe to call on every verified sign-in.
    """
    if user.email_verified_at is None:
        return
    transaction.on_commit(lambda: upsert_member(user.email, user.name or None))


def notify_owner_of_first_verified_sign_in(user: User) -> None:
    """Send one best-effort owner alert without delaying account activation.

    The atomic update is a lightweight claim, preventing concurrent sign-ins
    from sending duplicates. A failed send restores the claim for a later
    verified sign-in to retry.
    """
    recipient = settings.FORKLUCK_REGISTRATION_NOTIFICATION_EMAIL
    if not recipient or user.email_verified_at is None:
        return
    claimed = User.objects.filter(
        id=user.id, first_sign_in_notification_pending=True
    ).update(first_sign_in_notification_pending=False)
    if not claimed:
        return
    try:
        send_new_user_notification(
            recipient,
            name=user.name,
            email=user.email,
            registered_at=user.date_joined.isoformat(),
            verified_at=user.email_verified_at.isoformat(),
        )
    except (EmailNotConfigured, ValueError):
        User.objects.filter(id=user.id).update(
            first_sign_in_notification_pending=True
        )
        logger.exception(
            "Could not send first verified sign-in notification for user %s",
            user.id,
        )


@require_GET
@ensure_csrf_cookie
def csrf(request: HttpRequest) -> JsonResponse:
    return JsonResponse({"ok": True})


@require_GET
def public_session(request: HttpRequest) -> JsonResponse:
    if not request.user.is_authenticated:
        return error("Authentication required", 401)
    return JsonResponse({"user": user_json(request.user)})


# Accounts per client IP inside the window. Counted before the account exists,
# because creating it also seeds a workspace — so an unlimited signup path is a
# write amplifier, and with email verification off (the default) nothing else on
# this path counts at all.
MAX_REGISTRATIONS_PER_IP = 10
REGISTRATION_WINDOW = timedelta(hours=1)
MAX_CHANGE_PASSWORD_ATTEMPTS = 10
MAX_CHANGE_PASSWORD_ATTEMPTS_PER_IP = 50
CHANGE_PASSWORD_WINDOW = timedelta(minutes=15)


@require_POST
def register(request: HttpRequest) -> JsonResponse:
    try:
        hit(
            "register:ip",
            client_ip(request),
            limit=MAX_REGISTRATIONS_PER_IP,
            window=REGISTRATION_WINDOW,
            message="Too many accounts created from here. Try again later.",
        )
    except Throttled as exc:
        return error(str(exc), 429, code="rate_limited")

    try:
        body = read_json(request)
        name = text_value(body.get("name"), "Name", max_length=150).strip()
        email = text_value(body.get("email"), "Email", max_length=254).strip().lower()
        password = text_value(body.get("password"), "Password", max_length=1024)
        validate_email(email)
        candidate = User(email=email, name=name)
        validate_password(password, user=candidate)
    except (ValueError, ValidationError) as exc:
        messages = exc.messages if isinstance(exc, ValidationError) else [str(exc)]
        return error(messages[0])

    try:
        with transaction.atomic():
            user = User.objects.create_user(
                email=email,
                name=name,
                password=password,
                first_sign_in_notification_pending=True,
            )
            seed_user_workspace(user)
    except IntegrityError:
        return error("An account with that email already exists")

    if settings.FORKLUCK_REQUIRE_EMAIL_VERIFICATION:
        # No session until the address is proven; the code email is the gate
        # that keeps bots from creating live workspaces.
        try:
            issue_code(
                email,
                EmailVerificationCode.PURPOSE_SIGNUP,
                client_ip=client_ip(request),
            )
        except (EmailNotConfigured, ValueError) as exc:
            # Roll the fresh account back so the address can simply retry.
            user.delete()
            if isinstance(exc, EmailNotConfigured):
                return error("Email sending is not configured", 500)
            return error(str(exc))
        return JsonResponse(
            {"pendingVerification": True, "email": email}, status=202
        )

    login(request, user)
    return mark_signed_in(JsonResponse({"user": user_json(user)}, status=201))


@require_POST
def verify_email(request: HttpRequest) -> JsonResponse:
    try:
        body = read_json(request)
        email = text_value(body.get("email"), "Email", max_length=254).strip().lower()
        code = text_value(body.get("code"), "Code", max_length=6).strip()
    except ValueError as exc:
        return error(str(exc))

    if not verify_code(email, EmailVerificationCode.PURPOSE_SIGNUP, code):
        return error("That code is wrong or expired. Request a new one.")

    user = User.objects.filter(email=email).first()
    if user is None:
        return error("That code is wrong or expired. Request a new one.")
    if user.email_verified_at is None:
        user.email_verified_at = timezone.now()
        user.save(update_fields=["email_verified_at"])
        claim_invitations(user)
    login(request, user)
    notify_owner_of_first_verified_sign_in(user)
    sync_newsletter_member(user)
    return mark_signed_in(JsonResponse({"user": user_json(user)}))


@require_POST
def resend_code(request: HttpRequest) -> JsonResponse:
    try:
        body = read_json(request)
        email = text_value(body.get("email"), "Email", max_length=254).strip().lower()
    except ValueError as exc:
        return error(str(exc))

    # Only unverified accounts have a code to resend; respond identically for
    # unknown addresses so this endpoint can't be used to probe for accounts.
    user = User.objects.filter(email=email, email_verified_at__isnull=True).first()
    if user is not None:
        try:
            issue_code(
                email,
                EmailVerificationCode.PURPOSE_SIGNUP,
                client_ip=client_ip(request),
            )
        except EmailNotConfigured:
            return error("Email sending is not configured", 500)
        except ValueError as exc:
            return error(str(exc))
    return JsonResponse({"ok": True})


@require_POST
def request_password_reset(request: HttpRequest) -> JsonResponse:
    try:
        body = read_json(request)
        email = text_value(body.get("email"), "Email", max_length=254).strip().lower()
        validate_email(email)
    except (ValueError, ValidationError) as exc:
        messages = exc.messages if isinstance(exc, ValidationError) else [str(exc)]
        return error(messages[0])

    # Check configuration before looking up the account so a broken email
    # setup cannot turn this endpoint into an address-existence oracle.
    if not settings.ACS_CONNECTION_STRING:
        return error("Email sending is not configured", 500)

    # Unknown and inactive accounts receive the same response as real ones.
    # This keeps the form from exposing which addresses are registered.
    user = User.objects.filter(email=email, is_active=True).first()
    if user is not None:
        try:
            issue_code(
                email,
                EmailVerificationCode.PURPOSE_PASSWORD_RESET,
                client_ip=client_ip(request),
            )
        except EmailNotConfigured:
            return error("Email sending is not configured", 500)
        except ValueError as exc:
            return error(str(exc))
    return JsonResponse({"ok": True})


@require_POST
def reset_password(request: HttpRequest) -> JsonResponse:
    try:
        body = read_json(request)
        email = text_value(body.get("email"), "Email", max_length=254).strip().lower()
        code = text_value(body.get("code"), "Code", max_length=6).strip()
        password = text_value(body.get("password"), "Password", max_length=1024)
        validate_email(email)
        user = User.objects.filter(email=email, is_active=True).first()
        password_owner = user if user is not None else User(email=email)
        validate_password(password, user=password_owner)
    except (ValueError, ValidationError) as exc:
        messages = exc.messages if isinstance(exc, ValidationError) else [str(exc)]
        return error(messages[0])

    if user is None or not verify_code(
        email, EmailVerificationCode.PURPOSE_PASSWORD_RESET, code
    ):
        return error("That code is wrong or expired. Request a new one.")

    user.set_password(password)
    if user.email_verified_at is None:
        user.email_verified_at = timezone.now()
        user.save(update_fields=["password", "email_verified_at"])
        claim_invitations(user)
    else:
        user.save(update_fields=["password"])

    # A successful reset retires every other reset code for the address so a
    # previously requested code cannot be used to change the password again.
    EmailVerificationCode.objects.filter(
        email=email,
        purpose=EmailVerificationCode.PURPOSE_PASSWORD_RESET,
        used_at__isnull=True,
    ).update(used_at=timezone.now())
    return JsonResponse({"ok": True})


@require_POST
def change_password(request: HttpRequest) -> JsonResponse:
    if not request.user.is_authenticated:
        return error("Authentication required", 401)
    if (
        settings.FORKLUCK_ALLOW_DEMO_ACCOUNT
        and request.user.email == "user@user.com"
    ):
        return error("Password changes aren't available for the demo account")

    try:
        body = read_json(request)
        current_password = text_value(
            body.get("currentPassword"), "Current password", max_length=1024
        )
        new_password = text_value(
            body.get("newPassword"), "New password", max_length=1024
        )
    except ValueError as exc:
        return error(str(exc))

    try:
        with transaction.atomic():
            hit(
                "change-password:user",
                str(request.user.pk),
                limit=MAX_CHANGE_PASSWORD_ATTEMPTS,
                window=CHANGE_PASSWORD_WINDOW,
                message=(
                    "Too many password attempts. Wait a few minutes and try again."
                ),
            )
            hit(
                "change-password:ip",
                client_ip(request),
                limit=MAX_CHANGE_PASSWORD_ATTEMPTS_PER_IP,
                window=CHANGE_PASSWORD_WINDOW,
                message=(
                    "Too many password attempts. Wait a few minutes and try again."
                ),
            )
    except Throttled as exc:
        return error(str(exc), 429, code="rate_limited")

    with transaction.atomic():
        user = User.objects.select_for_update().get(pk=request.user.pk)
        if not user.check_password(current_password):
            return error("Current password is incorrect")

        reset("change-password:user", str(user.pk))
        if user.check_password(new_password):
            return error(
                "Choose a new password that is different from your current one"
            )
        try:
            validate_password(new_password, user=user)
        except ValidationError as exc:
            return error(exc.messages[0])

        user.set_password(new_password)
        user.save(update_fields=["password"])
        EmailVerificationCode.objects.filter(
            email=user.email,
            purpose=EmailVerificationCode.PURPOSE_PASSWORD_RESET,
            used_at__isnull=True,
        ).update(used_at=timezone.now())
        update_session_auth_hash(request, user)

    return JsonResponse({"ok": True})


@require_POST
def sign_in(request: HttpRequest) -> JsonResponse:
    try:
        body = read_json(request)
        email = text_value(body.get("email"), "Email", max_length=254).strip().lower()
        password = text_value(body.get("password"), "Password", max_length=1024)
    except ValueError as exc:
        return error(str(exc))

    if email == "user@user.com" and not settings.FORKLUCK_ALLOW_DEMO_ACCOUNT:
        return error("Email or password is incorrect", 401)

    # Counted before authenticate() so there is a limiter on the
    # credential-stuffing path at all. 429 rather than 401: the caller is being
    # refused for rate, not told anything about the credentials.
    try:
        check_sign_in_allowed(email, client_ip(request))
    except ValueError as exc:
        return error(str(exc), 429, code="rate_limited")

    user = authenticate(request, email=email, password=password)
    if user is None:
        return error("Email or password is incorrect", 401)
    clear_sign_in_throttle(email)
    if (
        settings.FORKLUCK_REQUIRE_EMAIL_VERIFICATION
        and user.email_verified_at is None
    ):
        # Password was right, so finishing verification is safe to offer.
        try:
            issue_code(
                email,
                EmailVerificationCode.PURPOSE_SIGNUP,
                client_ip=client_ip(request),
            )
        except (EmailNotConfigured, ValueError):
            pass  # the existing code may still be valid; let them type it
        return JsonResponse(
            {
                "error": "Check your email for a verification code to finish setup.",
                "needsVerification": True,
                "email": email,
            },
            status=403,
        )
    login(request, user)
    notify_owner_of_first_verified_sign_in(user)
    sync_newsletter_member(user)
    return mark_signed_in(JsonResponse({"user": user_json(user)}))


@require_POST
def sign_out(request: HttpRequest) -> JsonResponse:
    logout(request)
    response = JsonResponse({"ok": True})
    response.delete_cookie(
        settings.FORKLUCK_SIGNED_IN_COOKIE_NAME,
        domain=settings.FORKLUCK_SIGNED_IN_COOKIE_DOMAIN,
        path="/",
    )
    return response


def internal_session(request: HttpRequest) -> JsonResponse:
    billing = billing_json(request.user)
    # Unconditional: the count is what tells the app whether a member with no
    # recipes of their own should land in the kitchen they were invited to,
    # and that question is asked on every plan.
    billing["recipeCount"] = Recipe.objects.filter(user=request.user).count()
    # Kitchens this account belongs to, never the ones it owns. Dormant while
    # the address is unverified, exactly as the access helpers read them.
    kitchens = [
        {
            "id": str(row.id),
            "ownerId": str(row.owner_id),
            "ownerName": row.owner.name,
            "role": row.role,
        }
        for row in KitchenMembership.objects.filter(
            member=request.user, member__email_verified_at__isnull=False
        )
        .select_related("owner")
        .order_by(Lower("owner__name"), "id")
    ]
    return JsonResponse(
        {
            "user": user_json(request.user),
            "billing": billing,
            "kitchens": kitchens,
        }
    )


def internal_newsletter(request: HttpRequest) -> JsonResponse:
    """Ghost holds the subscription, so the settings screen asks it each time.

    `enabled` is null when Ghost cannot say — unconfigured, unreachable, or no
    member for this address.
    """
    available = newsletter_configured()
    return JsonResponse(
        {
            "enabled": newsletter_status(request.user.email) if available else None,
            "available": available,
        }
    )
