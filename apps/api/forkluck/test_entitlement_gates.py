"""Boolean feature gates on the cost-bearing actions.

Every flag is True on Free at launch, so each case runs twice: once as it
ships, and once with the Free catalog flipped to prove the gate is wired to
the entitlement rather than to a hard-coded plan test.
"""

from unittest.mock import patch

from django.test import Client, override_settings

from .domains.shared.billing import FREE_ENTITLEMENTS
from .models import User
from .testing import InternalApiTestCase

# One representative action per gated key; each body fails validation just
# past the gate, so a pass shows up as a 400 rather than a network call.
GATED = [
    ("usdaSearch", "search-nutrition-foods", {"query": "a"}),
    ("catalogSearch", "search-catalog-prices", {"query": "a"}),
    ("catalogSearch", "search-master-prices", {"query": "a"}),
    ("posSync", "enqueue-pos-sync", {"provider": "square"}),
    ("posSync", "retry-pos-sync", {"id": "not-a-uuid"}),
    ("connectors", "connect-connector", {"providerKey": "nowhere"}),
    (
        "connectors",
        "complete-connector-authorization",
        {"state": "st_1", "code": "code_1"},
    ),
    ("connectors", "enqueue-connector-sync", {"connectionId": "not-a-uuid"}),
]


@override_settings(
    STRIPE_SECRET_KEY="sk_test_forkluck",
    STRIPE_WEBHOOK_SECRET="whsec_test",
    STRIPE_PRICE_ID="price_forkluck",
    STRIPE_PRODUCT_ID="prod_forkluck",
    STRIPE_WEBHOOK_ENDPOINT_ID="we_forkluck",
    STRIPE_BILLING_ENABLED=True,
)
class EntitlementGateTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.client = Client()
        self.user = User.objects.create_user(
            email="gates@example.com", name="Chef", password="a-long-test-passphrase-2468"
        )
        self.client.force_login(self.user)

    def test_free_plan_reaches_every_gated_action_today(self):
        for key, slug, body in GATED:
            with self.subTest(action=slug):
                response = self.post_internal(slug, body)
                self.assertNotEqual(
                    response.json().get("code"), "upgrade_required", key
                )

    def test_a_withheld_flag_turns_its_actions_into_the_upgrade_funnel(self):
        for key, slug, body in GATED:
            with self.subTest(action=slug), patch.dict(FREE_ENTITLEMENTS, {key: False}):
                response = self.post_internal(slug, body)
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json()["code"], "upgrade_required")

    def test_disconnect_stays_open_so_a_downgraded_user_can_leave(self):
        with patch.dict(FREE_ENTITLEMENTS, {"connectors": False}):
            response = self.post_internal(
                "disconnect-connector", {"connectionId": "not-a-uuid"}
            )
        self.assertEqual(response.status_code, 400)
