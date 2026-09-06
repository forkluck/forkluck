"""Stripe billing state machine, identity, retry, and lifecycle coverage."""

import hashlib
import hmac
import json
import time
from datetime import timedelta
from unittest.mock import patch

from django.contrib import admin
from django.db import connection
from django.test import RequestFactory
from django.test import Client, override_settings
from django.utils import timezone

from .demo_data import DEMO_EMAIL
from .admin import ForkluckUserAdmin
from .domains.accounts.billing import delete_user_with_billing
from .domains.accounts.billing_configuration import (
    BillingNotReady,
    LiveStripeConfiguration,
    persist_configuration,
)
from .domains.accounts.billing_reconciliation import (
    BillingIdentityConflict,
    derive_entitlement,
    get_billing_account,
    reconcile_billing_account,
)
from .domains.shared.billing import (
    FREE_ENTITLEMENTS,
    PAID_ENTITLEMENTS,
    PLAN_ENTITLEMENTS,
    EntitlementError,
    billing_json,
    require_entitlement,
    write_blocked,
)
from .integrations.stripe import StripeError, verify_webhook
from .models import (
    BillingAccount,
    StripeBillingConfiguration,
    StripeCheckoutAttempt,
    StripeCustomer,
    StripeRetiredCustomer,
    StripeSubscription,
    StripeWebhookEvent,
    User,
)
from .testing import InternalApiTestCase

PASSWORD = "a-long-test-passphrase-2468"
PRODUCT_ID = "prod_forkluck"
PRICE_ID = "price_forkluck"

BILLING_ON = override_settings(
    STRIPE_SECRET_KEY="sk_test_forkluck",
    STRIPE_WEBHOOK_SECRET="whsec_test",
    STRIPE_PRICE_ID=PRICE_ID,
    STRIPE_PRODUCT_ID=PRODUCT_ID,
    STRIPE_WEBHOOK_ENDPOINT_ID="we_forkluck",
    STRIPE_BILLING_ENABLED=True,
)


def signed(payload: bytes, *, timestamp: int | None = None, secret: str = "whsec_test"):
    stamp = int(time.time()) if timestamp is None else timestamp
    digest = hmac.new(
        secret.encode(), f"{stamp}.".encode() + payload, hashlib.sha256
    ).hexdigest()
    return f"t={stamp},v1={digest}"


def make_user(email: str) -> User:
    return User.objects.create_user(email=email, name="Chef", password=PASSWORD)


def provider_customer(
    user: User,
    customer_id: str = "cus_1",
    *,
    customer_ref: str = "",
    created: int = 1_700_000_000,
) -> dict:
    metadata = {"forkluck_user_id": str(user.id)}
    if customer_ref:
        metadata["forkluck_customer_ref"] = customer_ref
    return {
        "id": customer_id,
        "metadata": metadata,
        "livemode": False,
        "created": created,
    }


def provider_subscription(
    subscription_id: str = "sub_1",
    customer_id: str = "cus_1",
    *,
    status: str = "active",
    product_id: str = PRODUCT_ID,
    price_id: str = PRICE_ID,
    created: int = 1_700_000_100,
    attempt_id: str = "",
) -> dict:
    value = {
        "id": subscription_id,
        "customer": customer_id,
        "status": status,
        "trial_end": 1_900_000_000 if status == "trialing" else None,
        "cancel_at_period_end": False,
        "livemode": False,
        "created": created,
        "items": {
            "data": [
                {
                    "current_period_end": 1_900_000_100,
                    "price": {"id": price_id, "product": product_id},
                }
            ]
        },
    }
    if attempt_id:
        value["metadata"] = {"forkluck_checkout_attempt_id": attempt_id}
    return value


def attest_configuration(*, verified: bool = True) -> None:
    persist_configuration(
        LiveStripeConfiguration(
            stripe_account_id="acct_forkluck",
            price_id=PRICE_ID,
            product_id=PRODUCT_ID,
            webhook_endpoint_id="we_forkluck",
            livemode=False,
        ),
        webhook_secret_verified=verified,
    )


@override_settings(STRIPE_WEBHOOK_SECRET="whsec_test")
class VerifyWebhookTests(InternalApiTestCase):
    def test_correct_wrong_stale_and_malformed_signatures(self):
        payload = json.dumps({"type": "invoice.paid"}).encode()
        self.assertEqual(
            verify_webhook(payload, signed(payload)), {"type": "invoice.paid"}
        )
        with self.assertRaises(StripeError):
            verify_webhook(payload, signed(payload, secret="whsec_other"))
        with self.assertRaises(StripeError):
            verify_webhook(payload, signed(payload, timestamp=int(time.time()) - 600))
        with self.assertRaises(StripeError):
            verify_webhook(b"[]", signed(b"[]"))
        for header in ("t=nonsense,v1=abc", "garbage", ""):
            with self.assertRaises(StripeError):
                verify_webhook(b"{}", header)


@BILLING_ON
class BillingReadModelTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = make_user("read@example.com")

    def test_missing_account_and_every_stored_status_have_one_query_semantics(self):
        with self.assertNumQueries(1, msg="billing gate stays one account lookup"):
            self.assertEqual(
                billing_json(self.user),
                {
                    "status": "none",
                    "trialDaysLeft": None,
                    "locked": False,
                    "plan": "free",
                    "entitlements": FREE_ENTITLEMENTS,
                },
            )
        account = BillingAccount.objects.create(user=self.user)
        for status, plan, locked in (
            ("trialing", "paid", False),
            ("active", "paid", False),
            ("past_due", "paid", False),
            ("canceled", "free", False),
            ("unpaid", "free", False),
            ("incomplete", "free", False),
            ("paused", "free", False),
            ("deleting", "free", True),
        ):
            account.status = status
            account.locked = locked
            account.trial_end = (
                timezone.now() + timedelta(days=3, hours=12)
                if status == "trialing"
                else None
            )
            account.save(update_fields=["status", "locked", "trial_end"])
            with self.assertNumQueries(1, msg="billing gate never walks customers"):
                state = billing_json(self.user)
            self.assertEqual(state["status"], status)
            self.assertEqual(state["locked"], locked)
            self.assertEqual(state["plan"], plan)
            self.assertEqual(state["entitlements"], PLAN_ENTITLEMENTS[plan])
            with self.assertNumQueries(1, msg="write gate stays one account lookup"):
                self.assertEqual(write_blocked(self.user), locked)
        account.status = "trialing"
        account.locked = False
        account.trial_end = timezone.now() + timedelta(days=3, hours=12)
        account.save(update_fields=["status", "locked", "trial_end"])
        self.assertEqual(billing_json(self.user)["trialDaysLeft"], 4)

    @override_settings(FORKLUCK_ALLOW_DEMO_ACCOUNT=True)
    def test_demo_staff_and_disabled_exemptions_do_not_query_account_state(self):
        demo = make_user(DEMO_EMAIL)
        staff = make_user("staff@example.com")
        staff.is_staff = True
        staff.save(update_fields=["is_staff"])
        disabled = {
            "status": "disabled",
            "trialDaysLeft": None,
            "locked": False,
            "plan": "paid",
            "entitlements": PAID_ENTITLEMENTS,
        }
        with self.assertNumQueries(0, msg="demo exemption precedes account lookup"):
            self.assertEqual(billing_json(demo), disabled)
        with self.assertNumQueries(0, msg="staff exemption precedes account lookup"):
            self.assertEqual(billing_json(staff), disabled)

    def test_free_plan_withholds_only_primo_and_caps_recipes(self):
        self.assertEqual(FREE_ENTITLEMENTS["maxRecipes"], 10)
        self.assertIsNone(PAID_ENTITLEMENTS["maxRecipes"])
        self.assertFalse(FREE_ENTITLEMENTS["primo"])
        withheld = {"maxRecipes", "primo"}
        self.assertEqual(
            {key: value for key, value in FREE_ENTITLEMENTS.items() if key not in withheld},
            {key: value for key, value in PAID_ENTITLEMENTS.items() if key not in withheld},
        )
        self.assertTrue(all(PAID_ENTITLEMENTS[key] for key in withheld - {"maxRecipes"}))

    def test_require_entitlement_refuses_only_what_the_plan_withholds(self):
        require_entitlement(self.user, "posSync")
        with self.assertRaises(EntitlementError) as raised:
            require_entitlement(self.user, "primo")
        self.assertEqual(raised.exception.code, "upgrade_required")
        self.assertEqual(
            str(raised.exception),
            "This feature isn't available on the Free plan. Upgrade to use it.",
        )


@BILLING_ON
class ReconciliationTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = make_user("reconcile@example.com")
        self.account = get_billing_account(self.user)

    @patch("forkluck.integrations.stripe.list_subscriptions")
    @patch("forkluck.integrations.stripe.search_customers")
    def test_all_customers_and_subscriptions_commit_one_derived_entitlement(
        self, search_customers, list_subscriptions
    ):
        customers = [
            provider_customer(self.user, "cus_1", created=10),
            provider_customer(self.user, "cus_2", created=20),
        ]
        StripeCustomer.objects.create(
            account=self.account,
            stripe_customer_id="cus_1",
            creation_idempotency_key="known-1",
        )
        StripeCustomer.objects.create(
            account=self.account,
            stripe_customer_id="cus_2",
            creation_idempotency_key="known-2",
        )
        search_customers.return_value = customers
        list_subscriptions.side_effect = lambda customer_id: {
            "cus_1": [
                provider_subscription("sub_old", "cus_1", status="canceled", created=30)
            ],
            "cus_2": [
                provider_subscription("sub_live", "cus_2", status="active", created=40)
            ],
        }[customer_id]

        self.assertTrue(reconcile_billing_account(self.account))

        self.account.refresh_from_db()
        self.assertEqual(self.account.status, "active")
        self.assertFalse(self.account.locked)
        self.assertEqual(self.account.stripe_customers.count(), 2)
        self.assertEqual(StripeSubscription.objects.count(), 2)
        self.assertEqual(
            StripeSubscription.objects.get(
                stripe_subscription_id="sub_live"
            ).current_period_end.timestamp(),
            1_900_000_100,
        )
        self.assertEqual(
            self.account.stripe_customers.get(is_primary=True).stripe_customer_id,
            "cus_1",
        )

    @patch("forkluck.integrations.stripe.list_subscriptions")
    @patch("forkluck.integrations.stripe.search_customers")
    def test_subscription_missing_from_complete_snapshot_cannot_keep_access_open(
        self, search_customers, list_subscriptions
    ):
        StripeCustomer.objects.create(
            account=self.account,
            stripe_customer_id="cus_1",
            creation_idempotency_key="known-1",
        )
        search_customers.return_value = [provider_customer(self.user)]
        list_subscriptions.side_effect = [
            [provider_subscription(status="active")],
            [],
        ]

        self.assertTrue(reconcile_billing_account(self.account))
        self.assertTrue(reconcile_billing_account(self.account))

        self.account.refresh_from_db()
        subscription = StripeSubscription.objects.get(
            stripe_subscription_id="sub_1"
        )
        self.assertEqual(subscription.status, "missing")
        self.assertFalse(subscription.provider_present)
        self.assertEqual(self.account.status, "none")
        self.assertFalse(self.account.locked)

    @patch("forkluck.integrations.stripe.list_subscriptions")
    @patch("forkluck.integrations.stripe.search_customers")
    def test_subscription_metadata_recovers_a_checkout_after_lost_responses(
        self, search_customers, list_subscriptions
    ):
        customer = StripeCustomer.objects.create(
            account=self.account,
            stripe_customer_id="cus_recovered",
            creation_idempotency_key="known-recovered",
            is_primary=True,
        )
        attempt = StripeCheckoutAttempt.objects.create(
            account=self.account,
            customer=customer,
            status=StripeCheckoutAttempt.Status.PENDING,
            with_trial=True,
        )
        search_customers.return_value = [
            provider_customer(self.user, "cus_recovered")
        ]
        list_subscriptions.return_value = [
            provider_subscription(
                "sub_recovered",
                "cus_recovered",
                status="canceled",
                attempt_id=str(attempt.id),
            )
        ]

        self.assertTrue(reconcile_billing_account(self.account))

        attempt.refresh_from_db()
        self.assertEqual(attempt.status, StripeCheckoutAttempt.Status.COMPLETED)
        self.assertEqual(attempt.stripe_subscription_id, "sub_recovered")

    def test_precedence_is_active_then_trialing_then_past_due_then_newest_lapsed(self):
        customer = StripeCustomer.objects.create(
            account=self.account,
            stripe_customer_id="cus_1",
            creation_idempotency_key="customer-1",
        )
        rows = [
            StripeSubscription.objects.create(
                customer=customer,
                stripe_subscription_id=f"sub_{status}",
                status=status,
                product_id=PRODUCT_ID,
                provider_created_at=timezone.now() + timedelta(seconds=index),
            )
            for index, status in enumerate(("canceled", "past_due", "trialing", "active"))
        ]
        for statuses, expected, locked in (
            (rows, "active", False),
            (rows[:-1], "trialing", False),
            (rows[:-2], "past_due", False),
            ([rows[0]], "canceled", False),
            ([], "none", False),
        ):
            status, _, derived_locked = derive_entitlement(
                statuses, BillingAccount.DeletionState.ACTIVE
            )
            self.assertEqual((status, derived_locked), (expected, locked))
        self.assertEqual(
            derive_entitlement(rows, BillingAccount.DeletionState.DELETING),
            ("deleting", None, True),
        )

    @patch("forkluck.integrations.stripe.retrieve_customer")
    def test_one_provider_customer_cannot_be_adopted_by_two_users(self, retrieve):
        other = make_user("other-reconcile@example.com")
        other_account = get_billing_account(other)
        StripeCustomer.objects.create(
            account=self.account,
            stripe_customer_id="cus_1",
            creation_idempotency_key="owned",
        )
        retrieve.return_value = provider_customer(other, "cus_1")
        from .domains.accounts.billing_reconciliation import (
            account_for_provider_customer,
        )

        resolved = account_for_provider_customer("cus_1")
        self.assertEqual(resolved, self.account)
        self.assertNotEqual(resolved, other_account)

    def test_retired_customer_cannot_be_rebound(self):
        StripeRetiredCustomer.objects.create(stripe_customer_id="cus_retired")
        from .domains.accounts.billing_reconciliation import assert_customer_not_retired

        with self.assertRaises(BillingIdentityConflict):
            assert_customer_not_retired("cus_retired")

    @patch("forkluck.integrations.stripe.retrieve_customer")
    def test_user_id_metadata_alone_cannot_create_a_customer_binding(self, retrieve):
        retrieve.return_value = provider_customer(self.user, "cus_unreserved")
        from .domains.accounts.billing_reconciliation import (
            account_for_provider_customer,
        )

        with self.assertRaises(BillingIdentityConflict):
            account_for_provider_customer("cus_unreserved")


@BILLING_ON
class BillingActionTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.client = Client()
        self.user = make_user("actions@example.com")
        self.client.force_login(self.user)
        attest_configuration()

    @patch("forkluck.integrations.stripe.create_checkout_session")
    @patch("forkluck.integrations.stripe.create_customer")
    @patch("forkluck.integrations.stripe.search_customers")
    def test_repeated_checkout_reuses_customer_attempt_session_and_idempotency(
        self, search_customers, create_customer, create_session
    ):
        search_customers.side_effect = [[], [provider_customer(self.user)]]
        create_customer.return_value = provider_customer(self.user)
        create_session.return_value = {
            "id": "cs_1",
            "url": "https://checkout.stripe.com/c/1",
            "status": "open",
        }
        with patch("forkluck.integrations.stripe.list_subscriptions", return_value=[]):
            first = self.post_internal("create-stripe-checkout", {})
            second = self.post_internal("create-stripe-checkout", {})

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(StripeCustomer.objects.count(), 1)
        self.assertEqual(StripeCheckoutAttempt.objects.count(), 1)
        create_customer.assert_called_once()
        self.assertEqual(create_session.call_count, 2)
        first_key = create_session.call_args_list[0].kwargs["idempotency_key"]
        second_key = create_session.call_args_list[1].kwargs["idempotency_key"]
        self.assertEqual(first_key, second_key)

    @patch("forkluck.integrations.stripe.create_checkout_session")
    @patch("forkluck.integrations.stripe.create_customer")
    @patch("forkluck.integrations.stripe.retrieve_customer")
    @patch("forkluck.integrations.stripe.list_subscriptions", return_value=[])
    @patch("forkluck.integrations.stripe.search_customers", return_value=[])
    def test_provider_timeout_retries_the_same_checkout_command(
        self,
        search_customers,
        list_subscriptions,
        retrieve_customer,
        create_customer,
        create_session,
    ):
        create_customer.return_value = provider_customer(self.user)
        retrieve_customer.return_value = provider_customer(self.user)
        create_session.side_effect = [
            StripeError("Stripe could not be reached"),
            {"id": "cs_1", "url": "https://checkout.stripe.com/c/1", "status": "open"},
        ]
        first = self.post_internal("create-stripe-checkout", {})
        second = self.post_internal("create-stripe-checkout", {})

        self.assertEqual(first.status_code, 503)
        self.assertEqual(first.json()["code"], "billing_not_ready")
        self.assertEqual(second.status_code, 200)
        self.assertEqual(StripeCheckoutAttempt.objects.count(), 1)
        self.assertEqual(
            create_session.call_args_list[0].kwargs["idempotency_key"],
            create_session.call_args_list[1].kwargs["idempotency_key"],
        )

    @patch("forkluck.integrations.stripe.create_checkout_session")
    @patch("forkluck.integrations.stripe.create_customer")
    @patch("forkluck.integrations.stripe.search_customers", return_value=[])
    def test_completed_checkout_is_not_replaced_while_entitlement_is_pending(
        self, search_customers, create_customer, create_session
    ):
        create_customer.return_value = provider_customer(self.user)
        create_session.return_value = {"id": "cs_1", "status": "complete"}
        with patch("forkluck.integrations.stripe.list_subscriptions", return_value=[]):
            response = self.post_internal("create-stripe-checkout", {})

        self.assertEqual(response.status_code, 400)
        self.assertIn("still being confirmed", response.json()["error"])
        self.assertEqual(create_session.call_count, 1)
        self.assertEqual(StripeCheckoutAttempt.objects.count(), 1)

    @patch("forkluck.integrations.stripe.create_checkout_session")
    @patch("forkluck.integrations.stripe.list_subscriptions", return_value=[])
    @patch("forkluck.integrations.stripe.search_customers")
    def test_return_page_completion_stays_fenced_until_subscription_appears(
        self, search_customers, list_subscriptions, create_session
    ):
        account = get_billing_account(self.user)
        customer = StripeCustomer.objects.create(
            account=account,
            stripe_customer_id="cus_complete",
            creation_idempotency_key="customer-complete",
            is_primary=True,
        )
        StripeCheckoutAttempt.objects.create(
            account=account,
            customer=customer,
            stripe_checkout_session_id="cs_complete",
            stripe_subscription_id="sub_lapsed",
            status=StripeCheckoutAttempt.Status.COMPLETED,
        )
        search_customers.return_value = [
            provider_customer(self.user, "cus_complete")
        ]

        response = self.post_internal("create-stripe-checkout", {})

        self.assertEqual(response.status_code, 400)
        self.assertIn("still being confirmed", response.json()["error"])
        self.assertEqual(StripeCheckoutAttempt.objects.count(), 1)
        create_session.assert_not_called()

        list_subscriptions.return_value = [
            provider_subscription(
                "sub_lapsed", "cus_complete", status="canceled"
            )
        ]
        create_session.return_value = {
            "id": "cs_retry",
            "url": "https://checkout.stripe.com/c/retry",
            "status": "open",
        }
        retry = self.post_internal("create-stripe-checkout", {})

        self.assertEqual(retry.status_code, 200)
        self.assertEqual(StripeCheckoutAttempt.objects.count(), 2)
        self.assertFalse(StripeCheckoutAttempt.objects.latest("created_at").with_trial)

    @patch("forkluck.integrations.stripe.create_checkout_session")
    @patch("forkluck.integrations.stripe.list_subscriptions")
    @patch("forkluck.integrations.stripe.search_customers")
    def test_free_account_upgrades_but_a_paid_one_is_refused(
        self, search_customers, list_subscriptions, create_session
    ):
        account = get_billing_account(self.user)
        StripeCustomer.objects.create(
            account=account,
            stripe_customer_id="cus_1",
            creation_idempotency_key="known-1",
            is_primary=True,
        )
        search_customers.return_value = [provider_customer(self.user)]
        list_subscriptions.return_value = [provider_subscription(status="canceled")]
        create_session.return_value = {
            "id": "cs_free",
            "url": "https://checkout.stripe.com/c/free",
            "status": "open",
        }

        response = self.post_internal("create-stripe-checkout", {})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["url"], "https://checkout.stripe.com/c/free")
        account.refresh_from_db()
        self.assertFalse(account.locked)
        self.assertFalse(StripeCheckoutAttempt.objects.get().with_trial)

        list_subscriptions.return_value = [provider_subscription(status="active")]
        refused = self.post_internal("create-stripe-checkout", {})

        self.assertEqual(refused.status_code, 400)
        self.assertIn("already have an active subscription", refused.json()["error"])

    @patch("forkluck.integrations.stripe.create_checkout_session")
    @patch("forkluck.integrations.stripe.list_subscriptions", return_value=[])
    @patch("forkluck.integrations.stripe.search_customers")
    def test_a_reserved_trial_attempt_is_expired_and_replaced(
        self, search_customers, list_subscriptions, create_session
    ):
        account = get_billing_account(self.user)
        customer = StripeCustomer.objects.create(
            account=account,
            stripe_customer_id="cus_1",
            creation_idempotency_key="known-1",
            is_primary=True,
        )
        legacy = StripeCheckoutAttempt.objects.create(
            account=account,
            customer=customer,
            stripe_checkout_session_id="cs_legacy",
            status=StripeCheckoutAttempt.Status.OPEN,
            with_trial=True,
        )
        search_customers.return_value = [provider_customer(self.user)]
        create_session.return_value = {
            "id": "cs_new",
            "url": "https://checkout.stripe.com/c/new",
            "status": "open",
        }

        response = self.post_internal("create-stripe-checkout", {})

        self.assertEqual(response.status_code, 200)
        legacy.refresh_from_db()
        self.assertEqual(legacy.status, StripeCheckoutAttempt.Status.EXPIRED)
        fresh = StripeCheckoutAttempt.objects.exclude(pk=legacy.pk).get()
        self.assertFalse(fresh.with_trial)
        self.assertEqual(fresh.stripe_checkout_session_id, "cs_new")

    def test_deleting_account_cannot_reserve_another_checkout(self):
        account = get_billing_account(self.user)
        account.deletion_state = BillingAccount.DeletionState.DELETING
        account.save(update_fields=["deletion_state"])

        response = self.post_internal("create-stripe-checkout", {})

        self.assertEqual(response.status_code, 400)
        self.assertIn("being deleted", response.json()["error"])
        self.assertFalse(StripeCheckoutAttempt.objects.exists())

    def test_checkout_fails_closed_without_current_local_attestation(self):
        StripeBillingConfiguration.objects.all().delete()
        response = self.post_internal("create-stripe-checkout", {})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], "billing_not_ready")

    @patch("forkluck.integrations.stripe.retrieve_checkout_session")
    def test_sync_requires_both_user_and_customer_ownership(self, retrieve_session):
        account = get_billing_account(self.user)
        StripeCustomer.objects.create(
            account=account,
            stripe_customer_id="cus_1",
            creation_idempotency_key="customer-1",
        )
        other = make_user("other-checkout@example.com")
        StripeCustomer.objects.create(
            account=get_billing_account(other),
            stripe_customer_id="cus_other",
            creation_idempotency_key="customer-other",
        )
        retrieve_session.side_effect = [
            {
                "id": "cs_wrong_user",
                "client_reference_id": "someone-else",
                "customer": "cus_1",
            },
            {
                "id": "cs_wrong_customer",
                "client_reference_id": str(self.user.pk),
                "customer": "cus_other",
            },
        ]
        wrong_user = self.post_internal(
            "sync-stripe-subscription", {"checkoutSessionId": "cs_1"}
        )
        wrong_customer = self.post_internal(
            "sync-stripe-subscription", {"checkoutSessionId": "cs_2"}
        )
        self.assertEqual(wrong_user.status_code, 400)
        self.assertEqual(wrong_customer.status_code, 400)

    @patch("forkluck.integrations.stripe.search_customers")
    @patch("forkluck.integrations.stripe.list_subscriptions", return_value=[])
    @patch("forkluck.integrations.stripe.retrieve_checkout_session")
    def test_sync_cannot_complete_an_owned_checkout_that_is_still_open(
        self, retrieve_session, list_subscriptions, search_customers
    ):
        account = get_billing_account(self.user)
        customer = StripeCustomer.objects.create(
            account=account,
            stripe_customer_id="cus_open",
            creation_idempotency_key="customer-open",
            is_primary=True,
        )
        attempt = StripeCheckoutAttempt.objects.create(
            account=account,
            customer=customer,
            stripe_checkout_session_id="cs_open",
            status=StripeCheckoutAttempt.Status.OPEN,
        )
        retrieve_session.return_value = {
            "id": "cs_open",
            "status": "open",
            "client_reference_id": str(self.user.id),
            "customer": "cus_open",
        }
        search_customers.return_value = [provider_customer(self.user, "cus_open")]

        response = self.post_internal(
            "sync-stripe-subscription", {"checkoutSessionId": "cs_open"}
        )

        self.assertEqual(response.status_code, 200)
        attempt.refresh_from_db()
        self.assertEqual(attempt.status, StripeCheckoutAttempt.Status.OPEN)

        retrieve_session.return_value = {
            "id": "cs_open",
            "status": "complete",
            "client_reference_id": str(self.user.id),
            "customer": "cus_open",
            "subscription": {"id": "sub_open"},
        }
        list_subscriptions.return_value = [
            provider_subscription("sub_open", "cus_open", status="active")
        ]
        completed = self.post_internal(
            "sync-stripe-subscription", {"checkoutSessionId": "cs_open"}
        )

        self.assertEqual(completed.status_code, 200)
        attempt.refresh_from_db()
        self.assertEqual(attempt.status, StripeCheckoutAttempt.Status.COMPLETED)
        self.assertEqual(attempt.stripe_subscription_id, "sub_open")

    @patch("forkluck.integrations.stripe.create_portal_session")
    @patch("forkluck.integrations.stripe.list_subscriptions")
    @patch("forkluck.integrations.stripe.search_customers")
    def test_multiple_customers_require_an_owned_explicit_portal_choice(
        self, search_customers, list_subscriptions, create_portal
    ):
        account = get_billing_account(self.user)
        first = StripeCustomer.objects.create(
            account=account,
            stripe_customer_id="cus_1",
            creation_idempotency_key="customer-1",
            is_primary=True,
        )
        second = StripeCustomer.objects.create(
            account=account,
            stripe_customer_id="cus_2",
            creation_idempotency_key="customer-2",
        )
        search_customers.return_value = [
            provider_customer(self.user, "cus_1"),
            provider_customer(self.user, "cus_2"),
        ]
        list_subscriptions.side_effect = lambda customer_id: [
            provider_subscription(f"sub_{customer_id}", customer_id)
        ]
        create_portal.return_value = {"url": "https://billing.stripe.com/p/2"}

        choices = self.post_internal("create-billing-portal", {})
        invalid = self.post_internal(
            "create-billing-portal", {"customerId": str(self.user.id)}
        )
        selected = self.post_internal(
            "create-billing-portal", {"customerId": str(second.id)}
        )

        self.assertEqual(choices.status_code, 200)
        self.assertEqual(len(choices.json()["customers"]), 2)
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(selected.json(), {"url": "https://billing.stripe.com/p/2"})
        create_portal.assert_called_once_with("cus_2", "http://localhost:3000/settings")
        self.assertNotEqual(first.pk, second.pk)


@BILLING_ON
class StripeWebhookViewTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = make_user("hook@example.com")
        self.account = get_billing_account(self.user)
        self.customer = StripeCustomer.objects.create(
            account=self.account,
            stripe_customer_id="cus_1",
            creation_idempotency_key="customer-1",
            is_primary=True,
        )
        attest_configuration(verified=False)

    def post_event(self, event: dict, *, header: str | None = None):
        payload = json.dumps(event).encode()
        return self.client.post(
            "/api/billing/stripe-webhook",
            data=payload,
            content_type="application/json",
            HTTP_STRIPE_SIGNATURE=signed(payload) if header is None else header,
        )

    @patch("forkluck.integrations.stripe.list_subscriptions")
    @patch("forkluck.integrations.stripe.search_customers")
    def test_duplicate_and_out_of_order_events_reconcile_once_from_full_snapshot(
        self, search_customers, list_subscriptions
    ):
        search_customers.return_value = [provider_customer(self.user)]
        list_subscriptions.return_value = [provider_subscription(status="active")]
        event = {
            "id": "evt_1",
            "type": "customer.subscription.updated",
            "livemode": False,
            "data": {"object": {"id": "sub_1", "customer": "cus_1", "status": "canceled"}},
        }
        first = self.post_event(event)
        second = self.post_event(event)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(list_subscriptions.call_count, 1)
        self.account.refresh_from_db()
        self.assertEqual(self.account.status, "active")
        self.assertEqual(StripeWebhookEvent.objects.count(), 1)

    @patch("forkluck.integrations.stripe.retrieve_customer")
    def test_unknown_customer_retries_but_retired_customer_is_acknowledged(
        self, retrieve_customer
    ):
        unknown = make_user("deleted-standin@example.com")
        unknown_id = unknown.id
        unknown.delete()
        retrieve_customer.return_value = provider_customer(
            self.user, "cus_unknown"
        )
        retrieve_customer.return_value["metadata"]["forkluck_user_id"] = str(unknown_id)
        event = {
            "id": "evt_unknown",
            "type": "customer.subscription.updated",
            "livemode": False,
            "data": {"object": {"id": "sub_x", "customer": "cus_unknown"}},
        }
        self.assertEqual(self.post_event(event).status_code, 503)
        StripeRetiredCustomer.objects.create(stripe_customer_id="cus_retired")
        event["id"] = "evt_retired"
        event["data"]["object"]["customer"] = "cus_retired"
        self.assertEqual(self.post_event(event).status_code, 200)

    def test_active_processing_lease_returns_retry_and_expired_lease_is_reclaimed(self):
        event = {
            "id": "evt_lease",
            "type": "invoice.paid",
            "livemode": False,
            "data": {"object": {}},
        }
        row = StripeWebhookEvent.objects.create(
            event_id="evt_lease",
            event_type="invoice.paid",
            status=StripeWebhookEvent.Status.PROCESSING,
            processing_started_at=timezone.now(),
        )
        self.assertEqual(self.post_event(event).status_code, 503)
        row.processing_started_at = timezone.now() - timedelta(minutes=6)
        row.save(update_fields=["processing_started_at"])
        self.assertEqual(self.post_event(event).status_code, 200)
        row.refresh_from_db()
        self.assertEqual(row.status, StripeWebhookEvent.Status.PROCESSED)

    def test_bad_signature_and_mutated_duplicate_identity_are_rejected(self):
        event = {
            "id": "evt_same",
            "type": "invoice.paid",
            "livemode": False,
            "data": {"object": {}},
        }
        self.assertEqual(
            self.post_event(event, header="t=1,v1=deadbeef").status_code, 400
        )
        self.assertEqual(self.post_event(event).status_code, 200)
        event["type"] = "invoice.failed"
        self.assertEqual(self.post_event(event).status_code, 400)

    def test_signed_event_from_the_wrong_mode_is_retried_without_reconciliation(self):
        event = {
            "id": "evt_wrong_mode",
            "type": "customer.subscription.updated",
            "livemode": True,
            "data": {"object": {"id": "sub_1", "customer": "cus_1"}},
        }

        response = self.post_event(event)

        self.assertEqual(response.status_code, 503)
        row = StripeWebhookEvent.objects.get(event_id="evt_wrong_mode")
        self.assertEqual(row.status, StripeWebhookEvent.Status.PENDING)
        self.assertEqual(row.last_error, "billing_configuration_mismatch")


@BILLING_ON
class BillingDeletionTests(InternalApiTestCase):
    @patch("forkluck.integrations.stripe.cancel_subscription")
    @patch("forkluck.integrations.stripe.list_subscriptions")
    @patch("forkluck.integrations.stripe.search_customers")
    def test_deletion_cancels_every_subscription_and_tombstones_customer(
        self, search_customers, list_subscriptions, cancel_subscription
    ):
        user = make_user("delete@example.com")
        account = get_billing_account(user)
        StripeCustomer.objects.create(
            account=account,
            stripe_customer_id="cus_1",
            creation_idempotency_key="customer-1",
            is_primary=True,
        )
        search_customers.return_value = [provider_customer(user)]
        list_subscriptions.return_value = [
            provider_subscription("sub_1", status="active"),
            provider_subscription("sub_2", status="past_due"),
        ]

        delete_user_with_billing(user)

        self.assertFalse(User.objects.filter(email="delete@example.com").exists())
        self.assertTrue(StripeRetiredCustomer.objects.filter(pk="cus_1").exists())
        self.assertEqual(
            {call.args[0] for call in cancel_subscription.call_args_list},
            {"sub_1", "sub_2"},
        )

    @patch("forkluck.domains.accounts.billing.remove_member")
    @patch("forkluck.integrations.stripe.cancel_subscription")
    @patch("forkluck.integrations.stripe.list_subscriptions")
    @patch("forkluck.integrations.stripe.search_customers")
    def test_deleting_a_user_removes_their_newsletter_member(
        self, search_customers, list_subscriptions, cancel_subscription, remove_member
    ):
        user = make_user("newsletter-delete@example.com")
        account = get_billing_account(user)
        StripeCustomer.objects.create(
            account=account,
            stripe_customer_id="cus_news",
            creation_idempotency_key="customer-news",
            is_primary=True,
        )
        search_customers.return_value = [provider_customer(user, "cus_news")]
        list_subscriptions.return_value = []

        with self.captureOnCommitCallbacks(execute=True):
            delete_user_with_billing(user)

        remove_member.assert_called_once_with("newsletter-delete@example.com")

    @patch("forkluck.integrations.stripe.cancel_subscription")
    @patch("forkluck.integrations.stripe.list_subscriptions")
    @patch("forkluck.integrations.stripe.search_customers")
    def test_provider_failure_keeps_user_and_deleting_state_for_retry(
        self, search_customers, list_subscriptions, cancel_subscription
    ):
        user = make_user("delete-retry@example.com")
        account = get_billing_account(user)
        StripeCustomer.objects.create(
            account=account,
            stripe_customer_id="cus_1",
            creation_idempotency_key="customer-1",
        )
        search_customers.return_value = [provider_customer(user)]
        list_subscriptions.return_value = [provider_subscription(status="active")]
        cancel_subscription.side_effect = StripeError("Stripe could not be reached")

        with self.assertRaises(StripeError):
            delete_user_with_billing(user)

        self.assertTrue(User.objects.filter(pk=user.pk).exists())
        account.refresh_from_db()
        self.assertEqual(account.deletion_state, BillingAccount.DeletionState.DELETING)

    @patch("forkluck.integrations.stripe.cancel_subscription")
    @patch("forkluck.integrations.stripe.list_subscriptions", return_value=[])
    @patch("forkluck.integrations.stripe.search_customers")
    def test_deletion_waits_for_a_completed_checkout_subscription_to_appear(
        self, search_customers, list_subscriptions, cancel_subscription
    ):
        user = make_user("delete-propagating@example.com")
        account = get_billing_account(user)
        customer = StripeCustomer.objects.create(
            account=account,
            stripe_customer_id="cus_propagating",
            creation_idempotency_key="customer-propagating",
            is_primary=True,
        )
        StripeCheckoutAttempt.objects.create(
            account=account,
            customer=customer,
            stripe_checkout_session_id="cs_propagating",
            stripe_subscription_id="sub_propagating",
            status=StripeCheckoutAttempt.Status.COMPLETED,
        )
        search_customers.return_value = [
            provider_customer(user, "cus_propagating")
        ]

        with self.assertRaises(BillingNotReady):
            delete_user_with_billing(user)

        self.assertTrue(User.objects.filter(pk=user.pk).exists())
        account.refresh_from_db()
        self.assertEqual(account.deletion_state, BillingAccount.DeletionState.DELETING)
        cancel_subscription.assert_not_called()

    @override_settings(STRIPE_BILLING_ENABLED=False)
    def test_disabling_config_cannot_delete_a_user_with_provider_identity(self):
        user = make_user("delete-disabled@example.com")
        account = get_billing_account(user)
        StripeCustomer.objects.create(
            account=account,
            stripe_customer_id="cus_disabled",
            creation_idempotency_key="customer-disabled",
        )

        with self.assertRaises(BillingNotReady):
            delete_user_with_billing(user)

        self.assertTrue(User.objects.filter(pk=user.pk).exists())

    def test_admin_delete_view_does_not_wrap_provider_effects_in_a_transaction(self):
        user_admin = ForkluckUserAdmin(User, admin.site)
        request = RequestFactory().post("/mommy/forkluck/user/1/delete/")
        initial_depth = len(connection.atomic_blocks)
        with patch.object(
            user_admin,
            "_delete_view",
            side_effect=lambda *args: len(connection.atomic_blocks),
        ):
            self.assertEqual(user_admin.delete_view(request, "1"), initial_depth)


class DispatchGateTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.client = Client()
        self.user = make_user("gate@example.com")
        self.client.force_login(self.user)

    @BILLING_ON
    def test_lapsed_subscription_writes_on_free_but_a_deleting_account_cannot(self):
        account = BillingAccount.objects.create(user=self.user, status="canceled")
        self.assertEqual(
            self.post_internal("update-account", {"name": "New Name"}).status_code, 200
        )
        account.status = "deleting"
        account.locked = True
        account.save(update_fields=["status", "locked"])
        blocked = self.post_internal("update-account", {"name": "Newer Name"})
        self.assertEqual(blocked.status_code, 403)
        self.assertEqual(blocked.json()["code"], "subscription_required")

    def test_gate_is_inert_when_billing_is_disabled(self):
        response = self.post_internal("update-account", {"name": "New Name"})
        self.assertEqual(response.status_code, 200)
