"""Shared machinery for the backend test suite.

`InternalApiTestCase` exists because every internal route is guarded by the
internal secret, so a test client request that omits the header is answered 404
rather than reaching the view — plumbing that had been hand-copied into
twenty-one test classes under three different names. The rest is the
key-path vocabulary the contract pins are written in.
"""

import json
import re
from functools import cache

from django.conf import settings
from django.test import Client, RequestFactory, TestCase

from .paths import ROOT as REPO_ROOT, WEB_ROOT  # noqa: F401

# Timestamps apps/web/lib/backend/types.ts deliberately declares as `string`: the
# frontend parses them where it needs an instant rather than carrying a Date.
STRING_DATETIME_KEYS = {
    "availableAt",
    "backfilledAt",
    "connectedAt",
    "finishedAt",
    "heartbeatAt",
    "lastSeenAt",
    "lastSyncedAt",
    "modifiedTime",
    "polledAt",
    "queuedAt",
    "registeredAt",
    "seenAt",
    "squareSalesSyncedAt",
    "squareSyncedAt",
    "startedAt",
}

_ISO_DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")

CONTRACT_MESSAGE = (
    "Contract break: this JSON shape is consumed by apps/web/lib/backend/types.ts and "
    "documented in docs/CONTRACT.md — update all three together."
)


def key_paths(value: object, prefix: str = "") -> list[str]:
    """Flatten a JSON payload into sorted, structural key paths."""
    if isinstance(value, dict) and value:
        found: list[str] = []
        for key in value:
            child = f"{prefix}.{key}" if prefix else str(key)
            found.extend(key_paths(value[key], child))
        return sorted(found)
    if isinstance(value, list) and value:
        return sorted(key_paths(value[0], f"{prefix}[]"))
    return [prefix]


@cache
def revived_keys() -> frozenset[str]:
    """The keys apps/web/lib/backend/client.ts turns back into Date objects."""
    source = (WEB_ROOT / "lib" / "backend" / "client.ts").read_text()
    body = source.split("function reviveDates", 1)[1].split("return value", 1)[0]
    return frozenset(re.findall(r'key === "([A-Za-z]+)"', body))


def datetime_keys(value: object) -> set[str]:
    """Every key in a payload whose value looks like an ISO datetime."""
    if isinstance(value, dict):
        found: set[str] = set()
        for key, child in value.items():
            if isinstance(child, str) and _ISO_DATETIME.match(child):
                found.add(str(key))
            else:
                found |= datetime_keys(child)
        return found
    if isinstance(value, list):
        found = set()
        for child in value:
            found |= datetime_keys(child)
        return found
    return set()


class ShapeAssertions:
    """One assertion for both halves of a serializer's contract."""

    def assertShape(self, payload, expected_paths) -> None:
        self.assertEqual(key_paths(payload), sorted(expected_paths), CONTRACT_MESSAGE)
        # A timestamp under a key the reviver does not list arrives at the
        # frontend as a string, so the payload's own values decide whether the
        # two lists still agree.
        self.assertEqual(
            datetime_keys(payload) - revived_keys() - STRING_DATETIME_KEYS,
            set(),
            "This timestamp key is missing from the reviver in "
            f"apps/web/lib/backend/client.ts. {CONTRACT_MESSAGE}",
        )


def internal_payload(view, user, *, query: dict | None = None, **kwargs) -> dict:
    """Call an internal read view directly and return the JSON it built.

    Bypassing the HTTP stack keeps session and secret handling out of query
    counts and key-path pins, which are about the payload, not the route.
    """
    request = RequestFactory().get("/", query or {})
    request.user = user
    response = view(request, **kwargs)
    if response.status_code != 200:
        raise AssertionError(f"{view.__name__} answered {response.status_code}")
    return json.loads(response.content)


class InternalApiTestCase(TestCase):
    def post_internal(self, action: str, body: dict, *, client: Client | None = None):
        return (client or self.client).post(
            f"/internal/v1/actions/{action}/",
            data=json.dumps(body),
            content_type="application/json",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )

    def post_system(self, path: str, body: dict):
        """A system route: the internal secret alone, and deliberately no
        session — these views must never reach for `request.user`."""
        return Client().post(
            f"/internal/v1/{path}",
            data=json.dumps(body),
            content_type="application/json",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )

    def get_system(self, path: str):
        return Client().get(
            f"/internal/v1/{path}",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )

    def get_internal(
        self,
        path: str,
        data: dict[str, str] | None = None,
        *,
        client: Client | None = None,
    ):
        # Both spellings are in use across the suite: a bare route name and a
        # full path.
        if not path.startswith("/"):
            path = f"/internal/v1/{path}"
        return (client or self.client).get(
            path,
            data=data,
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )
