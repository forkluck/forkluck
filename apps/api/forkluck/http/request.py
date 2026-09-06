"""Request and response primitives for the HTTP edge.

A leaf module: it knows about Django requests and responses and nothing
about domains, so both the URL layer and domain views can depend on it.
"""

import json
from typing import Any

from django.core.exceptions import RequestDataTooBig
from django.http import HttpRequest, JsonResponse

JsonObject = dict[str, Any]


def error(message: str, status: int = 400, code: str | None = None) -> JsonResponse:
    """A JSON error body.

    ``code`` is a stable machine-readable tag for errors the frontend needs to
    branch on; it is omitted entirely when absent so the common shape stays
    exactly ``{"error": ...}``.
    """
    payload: JsonObject = {"error": message}
    if code is not None:
        payload["code"] = code
    return JsonResponse(payload, status=status)


def read_json(request: HttpRequest) -> JsonObject:
    try:
        body = json.loads(request.body or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError("Invalid JSON body") from exc
    except RequestDataTooBig as exc:
        # Django would otherwise answer an HTML 400, breaking the invariant
        # that every error body is `{"error": ...}`. Reading `request.body` is
        # what raises it, and this is the only place we read it.
        raise ValueError(
            "That import is too large to send in one request. Export a "
            "smaller date range."
        ) from exc
    if not isinstance(body, dict):
        raise ValueError("JSON body must be an object")
    return body
