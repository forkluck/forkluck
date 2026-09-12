"""Boolean feature gates on the cost-bearing actions.

Every flag is True on the trial, so each case runs twice: once as it ships,
and once with the trial catalog flipped to prove the gate is wired to the
entitlement rather than to a hard-coded plan test.
"""

from datetime import timedelta
from unittest.mock import patch

from django.test import Client, override_settings

from .domains.shared.billing import TRIAL_ENTITLEMENTS, trial_ends_at
from .models import User
from .testing import InternalApiTestCase

CLOCK = "forkluck.domains.shared.billing.current_time"

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

    def test_the_trial_reaches_every_gated_action_today(self):
        for key, slug, body in GATED:
            with self.subTest(action=slug):
                response = self.post_internal(slug, body)
                self.assertNotEqual(
                    response.json().get("code"), "upgrade_required", key
                )

    def test_a_withheld_flag_turns_its_actions_into_the_upgrade_funnel(self):
        for key, slug, body in GATED:
            with self.subTest(action=slug), patch.dict(TRIAL_ENTITLEMENTS, {key: False}):
                response = self.post_internal(slug, body)
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json()["code"], "upgrade_required")

    def test_an_expired_account_is_refused_before_any_gate(self):
        after = trial_ends_at(self.user) + timedelta(days=1)
        for _key, slug, body in GATED:
            with self.subTest(action=slug), patch(CLOCK, return_value=after):
                response = self.post_internal(slug, body)
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json()["code"], "subscription_required")

    def test_disconnect_stays_open_so_a_downgraded_user_can_leave(self):
        with patch.dict(TRIAL_ENTITLEMENTS, {"connectors": False}):
            response = self.post_internal(
                "disconnect-connector", {"connectionId": "not-a-uuid"}
            )
        self.assertEqual(response.status_code, 400)
