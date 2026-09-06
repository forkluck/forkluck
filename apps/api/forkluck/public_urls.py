from django.urls import path

from .integrations import connector_oauth, pos_oauth
from .domains.accounts import billing, feedback
from .domains.accounts import views as account_views


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
    path("integrations/square/connect", pos_oauth.square_connect),
    path("integrations/square/callback", pos_oauth.square_callback),
    path("integrations/shopify/connect", pos_oauth.shopify_connect),
    path("integrations/shopify/callback", pos_oauth.shopify_callback),
    path("integrations/connectors/callback", connector_oauth.connector_callback),
    path("billing/stripe-webhook", billing.stripe_webhook, name="stripe-webhook"),
]
