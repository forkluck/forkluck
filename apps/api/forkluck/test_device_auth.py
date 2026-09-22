"""Phone sign-in: emailed code → device token → bearer-guarded reads.

Mirrors test_feedback_auth.py for the credential lifecycle and
test_auth_throttling.py for capturing the codes the mailer would send.
"""

import json
from datetime import timedelta
from unittest.mock import patch

from django.test import Client, TestCase, override_settings
from django.utils import timezone

from .domains.accounts import devices
from .domains.shared.billing import billing_json, trial_ends_at
from .http.auth import LAST_USED_GRANULARITY, device_token_digest
from .integrations.emails import EmailNotConfigured
from .models import DeviceToken, EmailVerificationCode, Recipe, User
from .testing import InternalApiTestCase, ShapeAssertions, internal_payload

ROOT = "/api/mobile/v1/"
CLOCK = "forkluck.domains.shared.billing.current_time"


@override_settings(ACS_CONNECTION_STRING="synthetic", STRIPE_BILLING_ENABLED=False)
class DeviceSignInTests(InternalApiTestCase, ShapeAssertions):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="phone@example.com",
            password="a-long-test-passphrase-2468",
            name="Phone Owner",
            email_verified_at=timezone.now(),
        )
        self.sent: list[tuple[str, str, str]] = []

    def fake_send(self, email, code, *, purpose):
        self.sent.append((email, code, purpose))

    def post(self, path, body, **headers):
        return Client().post(
            ROOT + path, json.dumps(body), "application/json", **headers
        )

    def get(self, path, token, **query):
        return Client().get(
            ROOT + path, query, HTTP_AUTHORIZATION=f"Bearer {token}"
        )

    def request_code(self, email="phone@example.com"):
        with patch("forkluck.verification.send_verification_code", self.fake_send):
            return self.post("auth/request-code/", {"email": email})

    def sign_in(self, name="iPhone 16 Pro"):
        self.assertEqual(self.request_code().status_code, 200)
        _, code, _ = self.sent[-1]
        response = self.post(
            "auth/verify-code/",
            {"email": "phone@example.com", "code": code, "deviceName": name},
        )
        self.assertEqual(response.status_code, 200)
        return response

    # -- request-code --------------------------------------------------------

    def test_known_and_unknown_addresses_answer_alike(self):
        known = self.request_code()
        unknown = self.request_code("nobody@example.com")
        self.assertEqual(known.status_code, 200)
        self.assertEqual(unknown.status_code, 200)
        self.assertEqual(known.json(), unknown.json())
        self.assertEqual([purpose for _, _, purpose in self.sent], ["device"])

    def test_invalid_email_is_refused(self):
        response = self.request_code("not-an-address")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.sent, [])

    def test_the_address_throttle_applies(self):
        for _ in range(3):
            self.assertEqual(self.request_code().status_code, 200)
        response = self.request_code()
        self.assertEqual(response.status_code, 400)
        self.assertIn("Too many codes", response.json()["error"])

    @override_settings(ACS_CONNECTION_STRING="", FORKLUCK_MAIL_BRIDGE_URL="", DEBUG=False)
    def test_unconfigured_mail_answers_500_before_the_lookup(self):
        response = self.post("auth/request-code/", {"email": "phone@example.com"})
        self.assertEqual(response.status_code, 500)

    def test_a_mailer_failure_is_a_500(self):
        def exploding(email, code, *, purpose):
            raise EmailNotConfigured("no")

        with patch("forkluck.verification.send_verification_code", exploding):
            response = self.post("auth/request-code/", {"email": "phone@example.com"})
        self.assertEqual(response.status_code, 500)

    # -- verify-code ---------------------------------------------------------

    def test_the_right_code_mints_a_token_shown_once(self):
        response = self.sign_in()
        body = response.json()
        self.assertTrue(body["token"].startswith("fdt_"))
        self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual(response.cookies, {})
        row = DeviceToken.objects.get()
        self.assertEqual(row.token_digest, device_token_digest(body["token"]))
        self.assertEqual(row.credential_hash, self.user.get_session_auth_hash())
        self.assertEqual(row.name, "iPhone 16 Pro")
        self.assertEqual(body["device"]["id"], str(row.id))
        self.assertShape(
            body,
            ["token", "device.id", "device.name", "device.createdAt", "device.lastUsedAt"],
        )

    def test_wrong_expired_and_replayed_codes_are_refused(self):
        self.request_code()
        _, code, _ = self.sent[-1]
        wrong = self.post(
            "auth/verify-code/", {"email": "phone@example.com", "code": "000000"}
        )
        self.assertEqual(wrong.status_code, 400)
        self.assertEqual(
            wrong.json(), {"error": "That code is wrong or expired. Request a new one."}
        )
        good = self.post(
            "auth/verify-code/", {"email": "phone@example.com", "code": code}
        )
        self.assertEqual(good.status_code, 200)
        replay = self.post(
            "auth/verify-code/", {"email": "phone@example.com", "code": code}
        )
        self.assertEqual(replay.status_code, 400)
        self.assertEqual(DeviceToken.objects.count(), 1)

        self.request_code()
        _, code, _ = self.sent[-1]
        EmailVerificationCode.objects.update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )
        expired = self.post(
            "auth/verify-code/", {"email": "phone@example.com", "code": code}
        )
        self.assertEqual(expired.status_code, 400)

    def test_an_unknown_address_with_any_code_is_refused_alike(self):
        response = self.post(
            "auth/verify-code/", {"email": "nobody@example.com", "code": "123456"}
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json(),
            {"error": "That code is wrong or expired. Request a new one."},
        )

    def test_typing_the_code_verifies_an_unverified_address(self):
        User.objects.filter(pk=self.user.pk).update(email_verified_at=None)
        self.sign_in()
        self.user.refresh_from_db()
        self.assertIsNotNone(self.user.email_verified_at)

    def test_device_name_is_optional_and_bounded(self):
        self.request_code()
        _, code, _ = self.sent[-1]
        too_long = self.post(
            "auth/verify-code/",
            {"email": "phone@example.com", "code": code, "deviceName": "x" * 101},
        )
        self.assertEqual(too_long.status_code, 400)
        unnamed = self.post(
            "auth/verify-code/", {"email": "phone@example.com", "code": code}
        )
        self.assertEqual(unnamed.status_code, 200)
        self.assertEqual(unnamed.json()["device"]["name"], "")

    # -- the guard -----------------------------------------------------------

    def test_a_token_reads_the_session_and_the_recipes(self):
        Recipe.objects.create(user=self.user, title="Phone loaf", code="P1")
        token = self.sign_in().json()["token"]
        session = self.get("session/", token)
        self.assertEqual(session.status_code, 200)
        self.assertEqual(session.json()["user"]["email"], "phone@example.com")
        self.assertEqual(session.cookies, {})
        recipes = self.get("recipes/", token)
        self.assertEqual(recipes.status_code, 200)
        self.assertEqual(
            [row["title"] for row in recipes.json()["items"]], ["Phone loaf"]
        )
        categories = self.get("recipe-categories/", token)
        self.assertEqual(categories.status_code, 200)

    def test_a_deleted_row_a_password_change_and_a_disabled_account_all_answer_401(self):
        token = self.sign_in().json()["token"]
        self.assertEqual(self.get("session/", token).status_code, 200)

        self.user.set_password("another-long-test-passphrase-1357")
        self.user.save()
        self.assertEqual(self.get("session/", token).status_code, 401)

        token = self.sign_in().json()["token"]
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        self.assertEqual(self.get("session/", token).status_code, 401)
        User.objects.filter(pk=self.user.pk).update(is_active=True)
        self.assertEqual(self.get("session/", token).status_code, 200)

        DeviceToken.objects.all().delete()
        self.assertEqual(self.get("session/", token).status_code, 401)

    def test_last_used_is_stamped_at_most_every_granularity(self):
        token = self.sign_in().json()["token"]
        row = DeviceToken.objects.get()
        self.assertIsNone(row.last_used_at)
        self.get("session/", token)
        row.refresh_from_db()
        first = row.last_used_at
        self.assertIsNotNone(first)

        recent = timezone.now() - timedelta(minutes=1)
        DeviceToken.objects.update(last_used_at=recent)
        self.get("session/", token)
        row.refresh_from_db()
        self.assertEqual(row.last_used_at, recent)

        stale = timezone.now() - LAST_USED_GRANULARITY - timedelta(minutes=5)
        DeviceToken.objects.update(last_used_at=stale)
        self.get("session/", token)
        row.refresh_from_db()
        self.assertGreater(row.last_used_at, stale)

    # -- sign-out and the web's list ----------------------------------------

    def test_sign_out_revokes_the_presenting_token(self):
        token = self.sign_in().json()["token"]
        response = self.post("auth/sign-out/", {}, HTTP_AUTHORIZATION=f"Bearer {token}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(DeviceToken.objects.count(), 0)
        again = self.post("auth/sign-out/", {}, HTTP_AUTHORIZATION=f"Bearer {token}")
        self.assertEqual(again.status_code, 401)

    def test_sign_out_is_open_after_the_trial(self):
        token = self.sign_in().json()["token"]
        after = trial_ends_at(self.user) + timedelta(days=1)
        with override_settings(STRIPE_BILLING_ENABLED=True), patch(
            CLOCK, return_value=after
        ):
            response = self.post(
                "auth/sign-out/", {}, HTTP_AUTHORIZATION=f"Bearer {token}"
            )
        self.assertEqual(response.status_code, 200)

    def test_devices_list_shape_and_stale_rows(self):
        self.sign_in("Kitchen iPad")
        self.sign_in("iPhone 16 Pro")
        payload = internal_payload(devices.device_list, self.user)
        self.assertShape(
            payload,
            ["items[].id", "items[].name", "items[].createdAt", "items[].lastUsedAt"],
        )
        self.assertEqual(
            [row["name"] for row in payload["items"]], ["iPhone 16 Pro", "Kitchen iPad"]
        )
        DeviceToken.objects.filter(name="Kitchen iPad").update(credential_hash="stale")
        payload = internal_payload(devices.device_list, self.user)
        self.assertEqual([row["name"] for row in payload["items"]], ["iPhone 16 Pro"])

    def test_the_web_revokes_a_device_by_id_within_its_own_account(self):
        body = self.sign_in().json()
        stranger = User.objects.create_user(
            email="other@example.com",
            password="a-long-test-passphrase-1357",
            name="Other",
        )
        self.client.force_login(stranger)
        foreign = self.post_internal("revoke-device", {"id": body["device"]["id"]})
        self.assertEqual(foreign.status_code, 400)
        self.assertEqual(foreign.json(), {"error": "Device not found"})
        self.assertEqual(DeviceToken.objects.count(), 1)

        self.client.force_login(self.user)
        own = self.post_internal("revoke-device", {"id": body["device"]["id"]})
        self.assertEqual(own.status_code, 200)
        self.assertEqual(DeviceToken.objects.count(), 0)
        self.assertEqual(self.get("session/", body["token"]).status_code, 401)

    def test_the_internal_devices_route_lists_for_the_session_user(self):
        self.sign_in()
        self.client.force_login(self.user)
        response = self.get_internal("devices/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["items"]), 1)


REVIEW = override_settings(
    FORKLUCK_APP_REVIEW_EMAIL="review@example.com",
    FORKLUCK_APP_REVIEW_CODE="424242",
)


@override_settings(ACS_CONNECTION_STRING="synthetic", STRIPE_BILLING_ENABLED=False)
class ReviewAccountTests(InternalApiTestCase):
    """The App Review address signs in with a fixed code and never expires."""

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="review@example.com",
            password="a-long-test-passphrase-2468",
            name="App Review",
            email_verified_at=timezone.now(),
        )
        self.sent: list[tuple[str, str, str]] = []

    def fake_send(self, email, code, *, purpose):
        self.sent.append((email, code, purpose))

    def post(self, path, body):
        return Client().post(ROOT + path, json.dumps(body), "application/json")

    def request_code(self):
        with patch("forkluck.verification.send_verification_code", self.fake_send):
            return self.post("auth/request-code/", {"email": "review@example.com"})

    def verify(self, code):
        return self.post(
            "auth/verify-code/",
            {"email": "review@example.com", "code": code, "deviceName": "Reviewer"},
        )

    @REVIEW
    def test_the_fixed_code_signs_in_without_any_mail(self):
        self.assertEqual(self.request_code().json(), {"ok": True})
        self.assertEqual(self.sent, [])
        response = self.verify("424242")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["token"].startswith("fdt_"))
        self.assertEqual(DeviceToken.objects.get().name, "Reviewer")

    @REVIEW
    def test_a_wrong_code_is_refused_and_guessing_is_throttled(self):
        for _ in range(10):
            self.assertEqual(self.verify("000000").status_code, 400)
        # The eleventh attempt is refused even with the right code.
        self.assertEqual(self.verify("424242").status_code, 400)
        self.assertEqual(DeviceToken.objects.count(), 0)

    @REVIEW
    def test_the_review_account_is_paid_with_no_trial_clock(self):
        with override_settings(STRIPE_BILLING_ENABLED=True):
            state = billing_json(self.user)
        self.assertEqual((state["plan"], state["trialDaysLeft"]), ("paid", None))

    @REVIEW
    def test_other_addresses_still_need_their_emailed_code(self):
        other = User.objects.create_user(
            email="phone@example.com",
            password="a-long-test-passphrase-1357",
            name="Phone Owner",
        )
        with patch("forkluck.verification.send_verification_code", self.fake_send):
            self.post("auth/request-code/", {"email": other.email})
        self.assertEqual(len(self.sent), 1)
        response = self.post(
            "auth/verify-code/", {"email": other.email, "code": "424242"}
        )
        self.assertEqual(response.status_code, 400)

    def test_without_the_settings_the_address_is_ordinary(self):
        self.assertEqual(self.request_code().status_code, 200)
        self.assertEqual([purpose for _, _, purpose in self.sent], ["device"])
        self.assertEqual(self.verify("424242").status_code, 400)
        with override_settings(STRIPE_BILLING_ENABLED=True):
            self.assertEqual(billing_json(self.user)["plan"], "trial")


class MailFallbackTests(TestCase):
    @override_settings(DEBUG=True, ACS_CONNECTION_STRING="", FORKLUCK_MAIL_BRIDGE_URL="")
    def test_a_development_server_logs_instead_of_sending(self):
        from .integrations.emails import send_email

        with self.assertLogs("forkluck.integrations.emails", level="WARNING") as logs:
            send_email("dev@example.com", "Subject", "Your code is: 123456")
        self.assertIn("123456", logs.output[0])

    @override_settings(DEBUG=False, ACS_CONNECTION_STRING="", FORKLUCK_MAIL_BRIDGE_URL="")
    def test_production_still_raises_when_unconfigured(self):
        from .integrations.emails import send_email

        with self.assertRaises(EmailNotConfigured):
            send_email("dev@example.com", "Subject", "text")
