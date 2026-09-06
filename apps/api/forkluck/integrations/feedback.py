"""Erase a linked Fider identity before deleting its owning Forkluck account."""

from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from django.conf import settings


def remove_feedback_user(user_id):
    if not settings.FORKLUCK_FEEDBACK_CLIENT_SECRET:
        return
    if not settings.FORKLUCK_FEEDBACK_API_KEY:
        raise ValueError("Feedback account removal is not configured. Please contact support.")
    url = settings.FORKLUCK_FEEDBACK_ORIGIN + "/api/v1/users/by-provider/_forkluck/" + quote(str(user_id), safe="")
    request = Request(url, method="DELETE", headers={
        "Authorization": "Bearer " + settings.FORKLUCK_FEEDBACK_API_KEY,
        "Accept": "application/json",
    })
    try:
        with urlopen(request, timeout=10) as response:
            if response.status != 200:
                raise ValueError("Feedback account removal failed. Please try again.")
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        # Never include the API key, provider body, or account data in errors.
        raise ValueError("Feedback account removal failed. Please try again.") from exc
