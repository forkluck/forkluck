"""The route table for the native app, mounted at /api/mobile/v1/.

A phone holds no session and no CSRF cookie: a bearer device token is the
whole credential, so every write here is csrf_exempt and every read reuses
the same domain views the internal table serves. The payloads are therefore
identical to what the web app receives, and there is one schema.
"""

from django.urls import path
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from .domains.accounts import devices
from .domains.accounts import views as account_views
from .domains.recipes import views as recipe_views
from .http import dispatch
from .http.auth import device_user


def device_get(view):
    """A read for the phone's user: method check outside, token check inside."""
    return require_GET(device_user(view))


def device_post(view):
    wrapped = csrf_exempt(require_POST(device_user(view)))
    # What test_tenant_isolation's route walk asks the route with.
    wrapped.post_only = True
    return wrapped


def anonymous_post(view):
    """The two steps that turn an emailed code into a token: no device yet."""
    wrapped = csrf_exempt(require_POST(view))
    wrapped.post_only = True
    wrapped.anonymous_capability = True
    return wrapped


urlpatterns = [
    path("auth/request-code/", anonymous_post(devices.request_code)),
    path("auth/verify-code/", anonymous_post(devices.redeem_code)),
    path("auth/register/", anonymous_post(devices.register)),
    path("auth/app-attest-challenge/", anonymous_post(devices.app_attest_challenge)),
    path("auth/sign-out/", device_post(devices.sign_out)),
    path("session/", device_get(account_views.internal_session)),
    path("devices/", device_get(devices.device_list)),
    path("recipes/", device_get(recipe_views.recipes)),
    path("recipes/<str:recipe_ref>/", device_get(recipe_views.recipe_detail)),
    path(
        "recipes/<str:recipe_ref>/nutrition/",
        device_get(recipe_views.recipe_nutrition),
    ),
    path("recipe-categories/", device_get(recipe_views.recipe_categories)),
    path("actions/<slug:action_name>/", device_post(dispatch.mobile_action)),
]
