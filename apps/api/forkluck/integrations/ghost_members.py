"""One-way mirror of app accounts into the Ghost newsletter.

App → Ghost only, and create-if-missing: an existing member is never
re-subscribed, because Ghost owns the unsubscribe — except set_newsletter,
which the account holder drives from Settings. Every function is a no-op when
the integration is unconfigured, and none of them ever raises — newsletter
membership must not affect a request.
"""

import base64
import hashlib
import hmac
import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request

from django.conf import settings

logger = logging.getLogger(__name__)

TIMEOUT = 10
# The settings screen waits on these two, so they give up sooner than the
# background syncs do.
SETTINGS_TIMEOUT = 5
TOKEN_TTL = 300


def _configured() -> tuple[str, str, str] | None:
    url = (settings.GHOST_ADMIN_URL or "").rstrip("/")
    key = settings.GHOST_ADMIN_API_KEY or ""
    if not url or ":" not in key:
        return None
    key_id, _, secret = key.partition(":")
    if not key_id or not secret:
        return None
    return url, key_id, secret


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _token(key_id: str, secret: str) -> str:
    """Sign a short-lived Admin API JWT (HS256) without a PyJWT dependency."""
    now = int(time.time())
    header = _b64(
        json.dumps(
            {"alg": "HS256", "typ": "JWT", "kid": key_id}, separators=(",", ":")
        ).encode()
    )
    payload = _b64(
        json.dumps(
            {"iat": now, "exp": now + TOKEN_TTL, "aud": "/admin/"},
            separators=(",", ":"),
        ).encode()
    )
    signing_input = f"{header}.{payload}".encode()
    signature = hmac.new(bytes.fromhex(secret), signing_input, hashlib.sha256).digest()
    return f"{header}.{payload}.{_b64(signature)}"


def is_configured() -> bool:
    """Whether Ghost credentials are present at all."""
    return _configured() is not None


def _call(
    method: str, path: str, body: dict | None = None, timeout: int = TIMEOUT
) -> dict | None:
    """Return the decoded response, or None when the call failed."""
    config = _configured()
    if config is None:
        return None
    url, key_id, secret = config
    request = urllib.request.Request(
        f"{url}/ghost/api/admin{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Ghost {_token(key_id, secret)}",
            "Accept-Version": "v5.0",
            "Content-Type": "application/json",
            "User-Agent": "forkluck-backend/1.0",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:500]
        logger.error("Ghost %s %s failed: %s %s", method, path, exc.code, detail)
        return None
    except (urllib.error.URLError, OSError) as exc:
        logger.error("Ghost unreachable for %s %s: %s", method, path, exc)
        return None
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except ValueError:
        logger.error("Ghost returned unreadable JSON for %s %s", method, path)
        return None


def _find(email: str, timeout: int = TIMEOUT) -> dict | None:
    # NQL string literals are single-quoted; escape the quote and the escape.
    escaped = email.replace("\\", "\\\\").replace("'", "\\'")
    query = urllib.parse.urlencode({"filter": f"email:'{escaped}'", "limit": 1})
    data = _call("GET", f"/members/?{query}", timeout=timeout)
    if not data:
        return None
    members = data.get("members") or []
    return members[0] if members else None


def _new_member(email: str, name: str | None, label: str) -> dict:
    # Ghost validates `name` as a string, so an unknown name is omitted, not null.
    member = {"email": email, "labels": [{"name": label}], "subscribed": True}
    if name:
        member["name"] = name
    return member


def upsert_member(email: str, name: str | None = None, label: str = "customer") -> bool:
    """Ensure Ghost has a labelled member for this address.

    Updating an existing member touches labels only: `newsletters` and
    subscription state stay exactly as Ghost holds them, so somebody who
    unsubscribed is never signed back up.
    """
    if _configured() is None:
        return False
    try:
        member = _find(email)
        if member is not None:
            labels = member.get("labels") or []
            if any(
                (item.get("name") if isinstance(item, dict) else item) == label
                for item in labels
            ):
                return True
            payload = {"labels": [*labels, {"name": label}]}
            return (
                _call("PUT", f"/members/{member['id']}/", {"members": [payload]})
                is not None
            )
        created = _call(
            "POST",
            "/members/",
            {"members": [_new_member(email, name, label)]},
        )
        return created is not None
    except Exception:
        logger.exception("Could not sync Ghost member")
        return False


def remove_member(email: str) -> bool:
    """Delete this address's Ghost member, if one exists."""
    if _configured() is None:
        return False
    try:
        member = _find(email)
        if member is None:
            return False
        return _call("DELETE", f"/members/{member['id']}/") is not None
    except Exception:
        logger.exception("Could not remove Ghost member")
        return False


def newsletter_status(email: str) -> bool | None:
    """Whether Ghost has this address on a newsletter, or None if it can't say.

    None covers unconfigured, unreachable, and no such member alike: all are
    cases where there is no state to show rather than a known "off".
    """
    if _configured() is None:
        return None
    try:
        member = _find(email, timeout=SETTINGS_TIMEOUT)
    except Exception:
        logger.exception("Could not read the Ghost newsletter status")
        return None
    if member is None:
        return None
    # Ghost 5 keeps subscriptions in `newsletters`; `subscribed` is legacy.
    return bool(member.get("newsletters"))


def _active_newsletter_ids() -> list[str] | None:
    query = urllib.parse.urlencode({"filter": "status:active", "limit": "all"})
    data = _call("GET", f"/newsletters/?{query}", timeout=SETTINGS_TIMEOUT)
    if not data:
        return None
    return [item["id"] for item in data.get("newsletters") or []]


def set_newsletter(email: str, enabled: bool, name: str | None = None) -> bool:
    """Subscribe or unsubscribe this address, as its owner asked.

    Unlike upsert_member this does re-subscribe somebody who had unsubscribed:
    the request came from the person who owns the address.
    """
    if _configured() is None:
        return False
    try:
        member = _find(email, timeout=SETTINGS_TIMEOUT)
        if member is None:
            # Nothing in Ghost is already unsubscribed.
            if not enabled:
                return True
            created = _call(
                "POST",
                "/members/",
                {"members": [_new_member(email, name, "customer")]},
                timeout=SETTINGS_TIMEOUT,
            )
            members = (created or {}).get("members") or []
            if not members:
                return False
            member = members[0]
        newsletters: list[dict[str, str]] = []
        if enabled:
            ids = _active_newsletter_ids()
            if ids is None:
                return False
            newsletters = [{"id": value} for value in ids]
        return (
            _call(
                "PUT",
                f"/members/{member['id']}/",
                {"members": [{"newsletters": newsletters}]},
                timeout=SETTINGS_TIMEOUT,
            )
            is not None
        )
    except Exception:
        logger.exception("Could not set the Ghost newsletter subscription")
        return False
