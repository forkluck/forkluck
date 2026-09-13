"""Cloudflare Turnstile siteverify over stdlib urllib (house style).

The signup form hands register a single-use token from the browser widget;
register sends it here with the visitor's IP. Unset keys switch the check off
entirely, which is the self-hosted default.
"""

import json
import logging
import urllib.error
import urllib.parse
import urllib.request

from django.conf import settings

logger = logging.getLogger(__name__)

SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
REQUEST_TIMEOUT_S = 10
# Tokens are opaque and short; anything larger is not one.
MAX_TOKEN_LENGTH = 2048


class TurnstileUnavailable(Exception):
    """Cloudflare could not answer, so the caller fails closed."""


def configured() -> bool:
    return bool(settings.TURNSTILE_SITE_KEY and settings.TURNSTILE_SECRET_KEY)


def verify(token: str, remote_ip: str) -> bool:
    """Whether Cloudflare accepts this token for this visitor.

    False is a verdict: the token is invalid, expired or already spent.
    TurnstileUnavailable is not: the check could not run.
    """
    params = {"secret": settings.TURNSTILE_SECRET_KEY, "response": token}
    if remote_ip and remote_ip != "unknown":
        params["remoteip"] = remote_ip
    request = urllib.request.Request(
        SITEVERIFY_URL,
        data=urllib.parse.urlencode(params).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_S) as response:
            body = json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        logger.warning("Turnstile siteverify failed: status=%s", exc.code)
        raise TurnstileUnavailable("Turnstile answered an error") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        logger.warning("Turnstile siteverify was unreachable")
        raise TurnstileUnavailable("Turnstile could not be reached") from exc
    except json.JSONDecodeError as exc:
        logger.warning("Turnstile returned unreadable JSON")
        raise TurnstileUnavailable("Turnstile returned an unreadable response") from exc
    if not isinstance(body, dict):
        raise TurnstileUnavailable("Turnstile returned an unreadable response")
    codes = [str(code)[:80] for code in body.get("error-codes") or []]
    if "internal-error" in codes:
        logger.warning("Turnstile siteverify reported an internal error")
        raise TurnstileUnavailable("Turnstile could not verify right now")
    if not body.get("success"):
        logger.info("Turnstile rejected a token: codes=%s", ",".join(codes) or "none")
        return False
    return True
