import hashlib
import hmac
import secrets
from datetime import timedelta

from django.conf import settings
from django.contrib.admin import AdminSite
from django.contrib.auth import authenticate, login
from django.db import transaction
from django.http import HttpRequest, HttpResponse
from django.middleware.csrf import get_token
from django.shortcuts import redirect
from django.utils import timezone
from django.utils.html import format_html
from django.utils.safestring import mark_safe

from . import throttling
from .integrations.emails import EmailNotConfigured, send_verification_code
from .models import EmailVerificationCode

CODE_TTL = timedelta(minutes=10)
# At most this many codes per address+purpose inside the TTL window — covers
# both bot hammering and accidental resend loops.
MAX_ACTIVE_CODES = 3
# Looser, because one office or one mobile carrier NAT legitimately shares an
# address; tight enough to bound spraying many addresses from one place.
MAX_CODES_PER_IP = 20
# Wrong passwords per address and per client IP inside the window. Successful
# sign-ins clear the address counter, so a legitimate user who mistypes a few
# times and then succeeds starts clean.
MAX_SIGN_IN_ATTEMPTS = 10
MAX_SIGN_IN_ATTEMPTS_PER_IP = 50
SIGN_IN_WINDOW = timedelta(minutes=15)


def _hash_code(code: str) -> str:
    return hashlib.sha256(f"{code}:{settings.SECRET_KEY}".encode()).hexdigest()


def issue_code(email: str, purpose: str, *, client_ip: str | None = None) -> None:
    """Create, store, and email a fresh 6-digit code.

    Raises ValueError when the address or the client has hit the issuance
    limit, or when sending fails (propagated from the email module).
    """
    email = email.strip().lower()

    # Counted under a row lock rather than as a count-then-insert: two
    # concurrent requests could each read the same under-limit count and each
    # insert, so the limit was only advisory. The IP bucket is deliberately
    # looser than the address bucket but bounds an attacker spraying many
    # addresses from one place.
    try:
        # Both dimensions are one decision. If the client bucket rejects the
        # request, roll back the address hit too; otherwise an already-blocked
        # attacker could spend an arbitrary victim's address budget without a
        # code ever being issued.
        with transaction.atomic():
            throttling.hit(
                f"code:{purpose}",
                email,
                limit=MAX_ACTIVE_CODES,
                window=CODE_TTL,
                message="Too many codes requested. Wait a few minutes and try again.",
            )
            if client_ip:
                throttling.hit(
                    "code:ip",
                    client_ip,
                    limit=MAX_CODES_PER_IP,
                    window=CODE_TTL,
                    message=(
                        "Too many codes requested. Wait a few minutes and try again."
                    ),
                )
    except throttling.Throttled as exc:
        raise ValueError(str(exc)) from exc

    now = timezone.now()
    code = f"{secrets.randbelow(1_000_000):06d}"
    with transaction.atomic():
        # A new code retires the old ones. Without this, every code issued
        # inside the window stayed usable, so a resend widened the guessing
        # surface instead of replacing it.
        EmailVerificationCode.objects.filter(
            email=email, purpose=purpose, used_at__isnull=True
        ).update(used_at=now)
        row = EmailVerificationCode.objects.create(
            email=email,
            purpose=purpose,
            code_hash=_hash_code(code),
            expires_at=now + CODE_TTL,
        )

    try:
        send_verification_code(email, code, purpose=purpose)
    except Exception:
        # Nobody can ever enter a code that was not delivered. Leaving the row
        # behind would burn the address's quota and, worse, leave a live code
        # nobody holds. The throttle hit above is deliberately *not* refunded:
        # send failures must not become a free retry loop.
        EmailVerificationCode.objects.filter(pk=row.pk).delete()
        raise

    throttling.sweep()


def verify_code(email: str, purpose: str, code: str) -> bool:
    """Check a submitted code; single-use, attempt-limited, constant-time."""
    email = email.strip().lower()
    code = code.strip()
    if not code.isdigit() or len(code) != 6:
        return False

    now = timezone.now()
    # Read and update under one lock. Read-then-save let two submissions of the
    # same correct code both observe used_at as null and both return True —
    # for a password reset, two password changes from one single-use code.
    with transaction.atomic():
        row = (
            EmailVerificationCode.objects.select_for_update()
            .filter(
                email=email,
                purpose=purpose,
                used_at__isnull=True,
                expires_at__gt=now,
                attempts__lt=EmailVerificationCode.MAX_ATTEMPTS,
            )
            .order_by("-created_at")
            .first()
        )
        if row is None:
            return False

        row.attempts += 1
        if hmac.compare_digest(row.code_hash, _hash_code(code)):
            row.used_at = now
            row.save(update_fields=["attempts", "used_at", "updated_at"])
            return True
        row.save(update_fields=["attempts", "updated_at"])
        return False


def check_sign_in_allowed(email: str, client_ip: str) -> None:
    """Count one password attempt for this address and client.

    Raises ValueError when either bucket is exhausted. Called *before*
    authenticate() so a limiter exists on the credential-stuffing path at all;
    clear_sign_in_throttle() refunds the address bucket on success.
    """
    try:
        with transaction.atomic():
            throttling.hit(
                "signin:email",
                email,
                limit=MAX_SIGN_IN_ATTEMPTS,
                window=SIGN_IN_WINDOW,
                message="Too many sign-in attempts. Wait a few minutes and try again.",
            )
            throttling.hit(
                "signin:ip",
                client_ip,
                limit=MAX_SIGN_IN_ATTEMPTS_PER_IP,
                window=SIGN_IN_WINDOW,
                message="Too many sign-in attempts. Wait a few minutes and try again.",
            )
    except throttling.Throttled as exc:
        raise ValueError(str(exc)) from exc


def clear_sign_in_throttle(email: str) -> None:
    """Forget an address's failed attempts after it signs in successfully.

    The IP bucket is deliberately left alone: an attacker who guesses one
    account correctly must not thereby reset the budget they are spending
    against every other account.
    """
    throttling.reset("signin:email", email)


# ---------------------------------------------------------------------------
# /mommy admin sign-in: password first, then an emailed 6-digit code. The view
# shadows django.contrib.admin's own login URL (declared before it in
# config/urls.py), so every admin redirect lands here.

ADMIN_PENDING_SESSION_KEY = "mommy_pending_user_id"
ADMIN_VERIFIED_SESSION_KEY = "mommy_verified_user_id"


def admin_access_allowed(request: HttpRequest) -> bool:
    """An ordinary app session never proves completion of the admin code step."""
    return bool(
        request.user.is_active
        and request.user.is_staff
        and (
            not settings.FORKLUCK_ADMIN_CODE_LOGIN
            or request.session.get(ADMIN_VERIFIED_SESSION_KEY) == str(request.user.pk)
        )
    )


class ForkluckAdminSite(AdminSite):
    def has_permission(self, request: HttpRequest) -> bool:
        return admin_access_allowed(request)


_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Mommy&rsquo;s Kitchen — sign in</title>
<style>
  body {{ font-family: system-ui, sans-serif; background: #fafafa; color: #18181b;
         display: grid; place-items: center; min-height: 100svh; margin: 0; }}
  form {{ background: #fff; border: 1px solid #e4e4e7; border-radius: 8px;
          padding: 28px; width: min(20rem, 90vw); }}
  h1 {{ font-size: 1.1rem; margin: 0 0 4px; }}
  p {{ font-size: .85rem; color: #6f6f78; margin: 0 0 16px; }}
  label {{ display: block; font-size: .8rem; font-weight: 600; margin: 12px 0 4px; }}
  input {{ width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: .95rem;
           border: 1px solid #d4d4d8; border-radius: 6px; }}
  button {{ margin-top: 18px; width: 100%; padding: 9px; font-size: .95rem;
            font-weight: 600; color: #fff; background: #18181b; border: 0;
            border-radius: 999px; cursor: pointer; }}
  .error {{ color: #dc2626; font-size: .85rem; margin: 12px 0 0; }}
</style></head><body>
<form method="post" action="">
  <h1>Mommy&rsquo;s Kitchen</h1>
  {body}
  {error}
  <button type="submit">{button}</button>
  <input type="hidden" name="csrfmiddlewaretoken" value="{csrf}">
  <input type="hidden" name="stage" value="{stage}">
</form></body></html>"""


def _admin_page(request, *, stage: str, body: str, button: str, error: str = "") -> HttpResponse:
    return HttpResponse(
        format_html(
            _PAGE,
            # The field markup is static, trusted HTML defined in this module.
            body=mark_safe(body),
            error=format_html('<p class="error">{}</p>', error) if error else "",
            button=button,
            csrf=get_token(request),
            stage=stage,
        )
    )


_PASSWORD_FIELDS = (
    '<label for="id_email">Email</label>'
    '<input id="id_email" name="email" type="email" autocomplete="email" autofocus required>'
    '<label for="id_password">Password</label>'
    '<input id="id_password" name="password" type="password" autocomplete="current-password" required>'
)

_CODE_FIELDS = (
    "<p>We emailed a 6-digit code to the address on the account. "
    "Enter it to finish signing in.</p>"
    '<label for="id_code">Code</label>'
    '<input id="id_code" name="code" inputmode="numeric" pattern="[0-9]{6}" '
    'maxlength="6" autocomplete="one-time-code" autofocus required>'
)


def admin_login(request: HttpRequest) -> HttpResponse:
    if admin_access_allowed(request):
        return redirect("/mommy/")

    if request.method != "POST":
        return _admin_page(
            request, stage="password", body=_PASSWORD_FIELDS, button="Continue"
        )

    stage = request.POST.get("stage", "password")

    if stage == "code":
        pending_id = request.session.get(ADMIN_PENDING_SESSION_KEY)
        user = (
            authenticate_pending(pending_id) if pending_id else None
        )
        if user is None:
            return _admin_page(
                request,
                stage="password",
                body=_PASSWORD_FIELDS,
                button="Continue",
                error="Session expired. Start again.",
            )
        if verify_code(
            user.email, EmailVerificationCode.PURPOSE_ADMIN, request.POST.get("code", "")
        ):
            request.session.pop(ADMIN_PENDING_SESSION_KEY, None)
            login(request, user)
            request.session[ADMIN_VERIFIED_SESSION_KEY] = str(user.pk)
            return redirect("/mommy/")
        return _admin_page(
            request,
            stage="code",
            body=_CODE_FIELDS,
            button="Sign in",
            error="That code is wrong or expired.",
        )

    email = (request.POST.get("email") or "").strip().lower()
    password = request.POST.get("password") or ""
    try:
        check_sign_in_allowed(email, throttling.client_ip(request))
    except ValueError as exc:
        return _admin_page(
            request,
            stage="password",
            body=_PASSWORD_FIELDS,
            button="Continue",
            error=str(exc),
        )
    user = authenticate(request, email=email, password=password)
    if user is None or not user.is_staff:
        return _admin_page(
            request,
            stage="password",
            body=_PASSWORD_FIELDS,
            button="Continue",
            error="Email or password is incorrect.",
        )

    clear_sign_in_throttle(email)

    if not settings.FORKLUCK_ADMIN_CODE_LOGIN:
        login(request, user)
        return redirect("/mommy/")

    try:
        issue_code(
            user.email,
            EmailVerificationCode.PURPOSE_ADMIN,
            client_ip=throttling.client_ip(request),
        )
    except (EmailNotConfigured, ValueError) as exc:
        return _admin_page(
            request,
            stage="password",
            body=_PASSWORD_FIELDS,
            button="Continue",
            error=str(exc),
        )
    request.session[ADMIN_PENDING_SESSION_KEY] = str(user.pk)
    return _admin_page(request, stage="code", body=_CODE_FIELDS, button="Sign in")


def authenticate_pending(pending_id: str):
    from .models import User

    user = User.objects.filter(pk=pending_id).first()
    if user is None or not user.is_active or not user.is_staff:
        return None
    return user
