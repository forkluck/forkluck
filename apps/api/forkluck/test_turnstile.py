"""Cloudflare Turnstile on sign-up: the siteverify client and the register gate."""

import json
import urllib.error
from unittest import mock
from urllib.parse import parse_qs

from django.conf import settings
from django.test import Client, TestCase, override_settings

from .integrations import turnstile
from .integrations.turnstile import TurnstileUnavailable
from .models import User

TURNSTILE_ON = override_settings(
    TURNSTILE_SITE_KEY="synthetic-site-key",
    TURNSTILE_SECRET_KEY="synthetic-secret",
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
)
PASSWORD = "a-long-test-passphrase-2468"
FAILED = "We couldn't confirm you're a person. Reload the page and try again."
UNAVAILABLE = "Sign-up is temporarily unavailable. Try again shortly."


def response(body):
    handle = mock.MagicMock()
    handle.__enter__.return_value = handle
    handle.read.return_value = json.dumps(body).encode()
    return handle


@TURNSTILE_ON
class SiteverifyClientTests(TestCase):
    def setUp(self):
        self.urlopen = self.enterContext(mock.patch("urllib.request.urlopen"))

    def posted(self) -> dict:
        request = self.urlopen.call_args.args[0]
        self.assertEqual(request.full_url, turnstile.SITEVERIFY_URL)
        self.assertEqual(request.get_method(), "POST")
        return {key: value[0] for key, value in parse_qs(request.data.decode()).items()}

    def test_unset_keys_mean_the_check_is_off(self):
        with override_settings(TURNSTILE_SITE_KEY="", TURNSTILE_SECRET_KEY=""):
            self.assertFalse(turnstile.configured())
        self.assertTrue(turnstile.configured())

    def test_a_good_token_posts_the_secret_the_token_and_the_visitor(self):
        self.urlopen.return_value = response({"success": True, "hostname": "app.forkluck.com"})
        self.assertTrue(turnstile.verify("tok_1", "203.0.113.9"))
        self.assertEqual(
            self.posted(),
            {"secret": "synthetic-secret", "response": "tok_1", "remoteip": "203.0.113.9"},
        )
        self.assertEqual(self.urlopen.call_args.kwargs["timeout"], turnstile.REQUEST_TIMEOUT_S)

    def test_an_unknown_visitor_address_is_left_out(self):
        self.urlopen.return_value = response({"success": True})
        turnstile.verify("tok_1", "unknown")
        self.assertNotIn("remoteip", self.posted())

    def test_a_rejected_or_spent_token_is_a_verdict_not_an_outage(self):
        for codes in (["invalid-input-response"], ["timeout-or-duplicate"], []):
            with self.subTest(codes=codes):
                self.urlopen.return_value = response({"success": False, "error-codes": codes})
                self.assertFalse(turnstile.verify("tok_1", "203.0.113.9"))

    def test_the_check_fails_closed_when_cloudflare_cannot_answer(self):
        outages = (
            ("internal-error", response({"success": False, "error-codes": ["internal-error"]})),
            ("not an object", response(["nope"])),
            ("unreachable", urllib.error.URLError("down")),
            ("timeout", TimeoutError()),
            ("5xx", urllib.error.HTTPError(turnstile.SITEVERIFY_URL, 502, "Bad Gateway", {}, None)),
            ("not json", json.JSONDecodeError("bad", "", 0)),
        )
        for name, outcome in outages:
            with self.subTest(outage=name):
                if isinstance(outcome, Exception):
                    self.urlopen.side_effect = outcome
                else:
                    self.urlopen.side_effect = None
                    self.urlopen.return_value = outcome
                with self.assertRaises(TurnstileUnavailable):
                    turnstile.verify("tok_1", "203.0.113.9")


class RegisterGateTests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.verify = self.enterContext(
            mock.patch("forkluck.integrations.turnstile.verify", return_value=True)
        )

    def register(self, ip="203.0.113.9", **extra):
        token = self.client.get("/api/auth/csrf").cookies[settings.CSRF_COOKIE_NAME].value
        body = {"name": "Chef", "email": "chef@example.com", "password": PASSWORD, **extra}
        return self.client.post(
            "/api/auth/register",
            data=json.dumps(body),
            content_type="application/json",
            HTTP_X_CSRFTOKEN=token,
            HTTP_X_REAL_IP=ip,
        )

    def test_unset_keys_ignore_the_field_and_never_call_cloudflare(self):
        self.assertEqual(self.register(turnstileToken="anything").status_code, 201)
        self.verify.assert_not_called()

    @TURNSTILE_ON
    def test_a_missing_or_malformed_token_is_refused_before_any_row_is_written(self):
        for extra in ({}, {"turnstileToken": ""}, {"turnstileToken": 42}, {"turnstileToken": "x" * 2049}):
            with self.subTest(extra=extra):
                refused = self.register(**extra)
                self.assertEqual(refused.status_code, 400)
                self.assertEqual(refused.json(), {"error": FAILED, "code": "verification_failed"})
        self.verify.assert_not_called()
        self.assertFalse(User.objects.exists())

    @TURNSTILE_ON
    def test_a_rejected_token_is_refused_and_writes_nothing(self):
        self.verify.return_value = False
        refused = self.register(turnstileToken="tok_bad")
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(refused.json()["code"], "verification_failed")
        self.assertFalse(User.objects.exists())

    @TURNSTILE_ON
    def test_an_outage_fails_closed_with_a_retry_later_sentence(self):
        self.verify.side_effect = TurnstileUnavailable("down")
        refused = self.register(turnstileToken="tok_1")
        self.assertEqual(refused.status_code, 503)
        self.assertEqual(refused.json(), {"error": UNAVAILABLE, "code": "verification_unavailable"})
        self.assertFalse(User.objects.exists())

    @TURNSTILE_ON
    def test_field_errors_come_first_so_they_do_not_spend_the_token(self):
        refused = self.register(turnstileToken="tok_1", password="short")
        self.assertEqual(refused.status_code, 400)
        self.assertNotIn("code", refused.json())
        self.verify.assert_not_called()

    @TURNSTILE_ON
    def test_a_good_token_creates_the_account_and_names_the_visitor(self):
        created = self.register(turnstileToken="  tok_1  ", ip="198.51.100.7")
        self.assertEqual(created.status_code, 201)
        self.verify.assert_called_once_with("tok_1", "198.51.100.7")
        self.assertTrue(User.objects.filter(email="chef@example.com").exists())

    @TURNSTILE_ON
    @override_settings(FORKLUCK_REQUIRE_EMAIL_VERIFICATION=True)
    def test_the_verification_email_branch_is_gated_the_same_way(self):
        with mock.patch("forkluck.verification.send_verification_code"):
            self.assertEqual(self.register().status_code, 400)
            self.assertFalse(User.objects.exists())
            self.assertEqual(self.register(turnstileToken="tok_1").status_code, 202)

    @TURNSTILE_ON
    def test_auth_methods_hands_the_public_site_key_to_the_signup_page(self):
        result = self.client.get(
            "/internal/v1/auth-methods/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )
        self.assertEqual(result.json(), {"google": False, "turnstileSiteKey": "synthetic-site-key"})
