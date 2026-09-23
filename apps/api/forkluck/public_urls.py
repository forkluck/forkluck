from functools import wraps

from django.urls import path

from .integrations import connector_oauth, pos_oauth
from .domains.accounts import billing, feedback, google
from .domains.accounts import views as account_views
from .domains.shared.billing import billing_json


def operations_connect(view, provider: str):
    """Connecting a sales channel starts here, outside the action funnel,
    and it is operations. A plan without POS sync is turned back before a
    state is minted, and the callback needs that state, so both are closed.
    The integrations layer cannot import billing, which is why the gate sits
    on the route."""

    @wraps(view)
    def wrapped(request):
        if (
            request.user.is_authenticated
            and not billing_json(request.user)["entitlements"]["posSync"]
        ):
            return pos_oauth.error_redirect(provider, "upgrade_required")
        return view(request)

    return wrapped


urlpatterns = [
    path("auth/feedback/authorize", feedback.authorize),
    path("auth/feedback/token", feedback.token),
    path("auth/feedback/profile", feedback.profile),
    path("auth/csrf", account_views.csrf, name="csrf"),
    path("auth/session", account_views.public_session, name="public-session"),
    path("auth/register", account_views.register, name="register"),
    path("auth/verify-email", account_views.verify_email, name="verify-email"),
    path("auth/resend-code", account_views.resend_code, name="resend-code"),
    path(
        "auth/request-password-reset",
        account_views.request_password_reset,
        name="request-password-reset",
    ),
    path(
        "auth/reset-password",
        account_views.reset_password,
        name="reset-password",
    ),
    path(
        "auth/change-password",
        account_views.change_password,
        name="change-password",
    ),
    path("auth/login", account_views.sign_in, name="login"),
    path("auth/logout", account_views.sign_out, name="logout"),
    path("auth/google/start", google.google_start),
    path("auth/google/callback", google.google_callback),
    path(
        "integrations/square/connect",
        operations_connect(pos_oauth.square_connect, "square"),
    ),
    path("integrations/square/callback", pos_oauth.square_callback),
    path(
        "integrations/shopify/connect",
        operations_connect(pos_oauth.shopify_connect, "shopify"),
    ),
    path("integrations/shopify/callback", pos_oauth.shopify_callback),
    path("integrations/connectors/callback", connector_oauth.connector_callback),
    path("billing/stripe-webhook", billing.stripe_webhook, name="stripe-webhook"),
]
