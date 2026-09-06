"""Browser callback bridge for hosted supplier connector authorization.

The callback never exchanges a code itself: it validates the browser session
and scalar query values, then hands the code to the authenticated Next app.
The subsequent internal action performs the user-bound one-time exchange.
"""

from urllib.parse import urlencode

from django.http import HttpRequest, HttpResponseRedirect
from django.views.decorators.http import require_GET


def _redirect(params: dict[str, str]) -> HttpResponseRedirect:
    query = urlencode(params)
    return HttpResponseRedirect(f"/integrations/suppliers/connections?{query}" if query else "/integrations/suppliers/connections")


def _scalar(request: HttpRequest, key: str, maximum: int) -> str | None:
    values = request.GET.getlist(key)
    if len(values) != 1:
        return None
    value = values[0]
    if not value or len(value) > maximum or any(character.isspace() for character in value):
        return None
    return value


@require_GET
def connector_callback(request: HttpRequest) -> HttpResponseRedirect:
    if not request.user.is_authenticated:
        return _redirect({"connector_error": "authentication"})
    state = _scalar(request, "state", 128)
    code = _scalar(request, "code", 512)
    if state is None or code is None:
        return _redirect({"connector_error": "invalid_callback"})
    # urlencode performs the only serialization step; neither value is logged
    # or embedded in HTML, and settings reads the values only client-side.
    return _redirect({"state": state, "code": code})
