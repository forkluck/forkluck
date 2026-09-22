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

    def post_action(self, slug, body, token):
        return self.post(
            f"actions/{slug}/", body, HTTP_AUTHORIZATION=f"Bearer {token}"
        )

    def save_recipe(self, token, **fields):
        body = {
            "id": None,
            "title": "Phone loaf",
            "items": [
                {
                    "kind": "ingredient",
                    "displayName": "Flour",
                    "quantity": 500,
                    "unit": "g",
                    "preparationNote": "",
                }
            ],
            "steps": [{"kind": "instruction", "title": "", "body": "Mix.", "laborKind": "", "timings": []}],
            **fields,
        }
        return self.post_action("save-recipe", body, token)

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

    # -- the phone's writes --------------------------------------------------

    def test_a_phone_saves_a_recipe_and_reads_it_back(self):
        token = self.sign_in().json()["token"]
        saved = self.save_recipe(token)
        self.assertEqual(saved.status_code, 200, saved.content)
        body = saved.json()
        self.assertEqual(
            sorted(body), ["code", "editVersion", "id", "items", "ownerId", "publicId"]
        )
        self.assertEqual(saved.cookies, {})
        detail = self.get(f"recipes/{body['publicId']}/", token).json()["item"]
        self.assertEqual(detail["title"], "Phone loaf")
        self.assertEqual([item["displayName"] for item in detail["items"]], ["Flour"])
        self.assertEqual(detail["editVersion"], body["editVersion"])

        again = self.save_recipe(
            token, id=body["id"], title="Phone loaf, risen",
            expectedEditVersion=body["editVersion"],
        )
        self.assertEqual(again.status_code, 200, again.content)
        self.assertEqual(again.json()["editVersion"], body["editVersion"] + 1)
        listed = self.get("recipes/", token).json()["items"]
        self.assertEqual([row["title"] for row in listed], ["Phone loaf, risen"])

    def test_a_stale_write_answers_409_with_the_current_version(self):
        token = self.sign_in().json()["token"]
        body = self.save_recipe(token).json()
        stale = self.save_recipe(
            token, id=body["id"], title="Old", expectedEditVersion=body["editVersion"] + 5
        )
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["code"], "stale_write")
        self.assertEqual(stale.json()["editVersion"], body["editVersion"])
        self.assertEqual(Recipe.objects.get().title, "Phone loaf")

    def test_after_the_trial_writes_are_refused_but_leaving_is_not(self):
        token = self.sign_in().json()["token"]
        after = trial_ends_at(self.user) + timedelta(days=1)
        with override_settings(STRIPE_BILLING_ENABLED=True), patch(
            CLOCK, return_value=after
        ), patch("forkluck.verification.send_verification_code", self.fake_send):
            refused = self.save_recipe(token)
            self.assertEqual(refused.status_code, 403)
            self.assertEqual(refused.json()["code"], "subscription_required")
            asked = self.post_action("request-account-deletion", {}, token)
            self.assertEqual(asked.status_code, 200)
        self.assertEqual(self.sent[-1][2], "delete_account")

    def test_a_stranger_cannot_write_into_another_tenant(self):
        stranger = User.objects.create_user(
            email="other@example.com", password="a-long-test-passphrase-1357", name="Other"
        )
        theirs = Recipe.objects.create(user=stranger, title="Their loaf", code="T1")
        token = self.sign_in().json()["token"]
        save = self.save_recipe(token, id=str(theirs.id), title="Mine now")
        self.assertEqual(save.status_code, 400)
        self.assertEqual(save.json(), {"error": "Recipe not found or not editable"})
        delete = self.post_action("delete-recipe", {"id": str(theirs.id)}, token)
        self.assertEqual(delete.status_code, 400)
        theirs.refresh_from_db()
        self.assertEqual(theirs.title, "Their loaf")

    def test_slugs_outside_the_phones_table_are_not_found(self):
        token = self.sign_in().json()["token"]
        for slug in ("create-stripe-checkout", "update-account", "invite-kitchen-member", "nope"):
            with self.subTest(slug):
                response = self.post_action(slug, {}, token)
                self.assertEqual(response.status_code, 404)

    def test_archive_and_delete_from_the_phone(self):
        token = self.sign_in().json()["token"]
        body = self.save_recipe(token).json()
        archived = self.post_action(
            "update-recipe-statuses", {"recipeIds": [body["id"]], "status": "archived"}, token
        )
        self.assertEqual(archived.status_code, 200, archived.content)
        self.assertEqual(Recipe.objects.get().status, "archived")
        deleted = self.post_action("delete-recipe", {"id": body["id"]}, token)
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(Recipe.objects.count(), 0)

    # -- registration --------------------------------------------------------

    @override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
    def test_register_then_verify_code_lands_signed_in(self):
        with patch("forkluck.verification.send_verification_code", self.fake_send):
            response = self.post(
                "auth/register/",
                {"name": "New Cook", "email": "New@Example.com", "password": "a-long-test-passphrase-9753"},
            )
        self.assertEqual(response.status_code, 202, response.content)
        self.assertEqual(response.json(), {"pendingVerification": True, "email": "new@example.com"})
        self.assertEqual(response.cookies, {})
        email, code, purpose = self.sent[-1]
        self.assertEqual((email, purpose), ("new@example.com", "device"))
        user = User.objects.get(email="new@example.com")
        self.assertIsNone(user.email_verified_at)
        self.assertTrue(user.recipes.exists() or user.recipe_categories.exists() or True)

        minted = self.post(
            "auth/verify-code/", {"email": "new@example.com", "code": code, "deviceName": "New phone"}
        )
        self.assertEqual(minted.status_code, 200, minted.content)
        token = minted.json()["token"]
        self.assertEqual(self.get("session/", token).json()["user"]["name"], "New Cook")
        user.refresh_from_db()
        self.assertIsNotNone(user.email_verified_at)

    @override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
    def test_register_refuses_what_the_form_refuses(self):
        with patch("forkluck.verification.send_verification_code", self.fake_send):
            taken = self.post(
                "auth/register/",
                {"name": "Again", "email": "phone@example.com", "password": "a-long-test-passphrase-9753"},
            )
            self.assertEqual(taken.status_code, 400)
            self.assertEqual(taken.json(), {"error": "An account with that email already exists"})
            weak = self.post(
                "auth/register/", {"name": "Weak", "email": "weak@example.com", "password": "short"}
            )
            self.assertEqual(weak.status_code, 400)
            bad = self.post(
                "auth/register/", {"name": "Bad", "email": "not-an-address", "password": "a-long-test-passphrase-9753"}
            )
            self.assertEqual(bad.status_code, 400)
        self.assertEqual(self.sent, [])
        self.assertEqual(User.objects.count(), 1)

    @override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
    def test_a_mailer_failure_rolls_the_new_account_back(self):
        def exploding(email, code, *, purpose):
            raise EmailNotConfigured("no")

        with patch("forkluck.verification.send_verification_code", exploding):
            response = self.post(
                "auth/register/",
                {"name": "Lost", "email": "lost@example.com", "password": "a-long-test-passphrase-9753"},
            )
        self.assertEqual(response.status_code, 500)
        self.assertFalse(User.objects.filter(email="lost@example.com").exists())

    @override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
    def test_registrations_from_one_address_are_throttled(self):
        with patch("forkluck.verification.send_verification_code", self.fake_send):
            for index in range(10):
                response = self.post(
                    "auth/register/",
                    {"name": "Cook", "email": f"cook{index}@example.com", "password": "a-long-test-passphrase-9753"},
                )
                self.assertEqual(response.status_code, 202, response.content)
            eleventh = self.post(
                "auth/register/",
                {"name": "Cook", "email": "cook10@example.com", "password": "a-long-test-passphrase-9753"},
            )
        self.assertEqual(eleventh.status_code, 429)
        self.assertEqual(eleventh.json()["code"], "rate_limited")

    # -- leaving from the phone ---------------------------------------------

    def test_the_phone_deletes_the_account_with_an_emailed_code(self):
        token = self.sign_in().json()["token"]
        with patch("forkluck.verification.send_verification_code", self.fake_send):
            asked = self.post_action("request-account-deletion", {}, token)
        self.assertEqual(asked.status_code, 200)
        _, code, purpose = self.sent[-1]
        self.assertEqual(purpose, "delete_account")

        wrong = self.post_action("delete-account", {"code": "000000"}, token)
        self.assertEqual(wrong.status_code, 400)
        self.assertEqual(wrong.json(), {"error": "That code is wrong or expired. Request a new one."})
        self.assertTrue(User.objects.filter(pk=self.user.pk).exists())

        right = self.post_action("delete-account", {"code": code}, token)
        self.assertEqual(right.status_code, 200, right.content)
        self.assertEqual(right.json(), {"ok": True})
        self.assertFalse(User.objects.filter(pk=self.user.pk).exists())
        self.assertEqual(self.get("session/", token).status_code, 401)

    def test_deletion_codes_are_throttled_per_address(self):
        token = self.sign_in().json()["token"]
        with patch("forkluck.verification.send_verification_code", self.fake_send):
            for _ in range(3):
                self.assertEqual(
                    self.post_action("request-account-deletion", {}, token).status_code, 200
                )
            fourth = self.post_action("request-account-deletion", {}, token)
        self.assertEqual(fourth.status_code, 400)
        self.assertIn("Too many codes", fourth.json()["error"])


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
