"""Google sign-in protocol, account identity and browser session boundaries."""

import base64
import http.client
import json
import time
import urllib.error
from unittest import mock
from urllib.parse import parse_qs, urlparse

from django.conf import settings
from django.core import signing
from django.db import IntegrityError
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from .domains.accounts import google
from .integrations import google_sign_in
from .models import AuthThrottle, BenchCostSettings, KitchenInvite, KitchenMembership, Recipe, User


def id_token(claims):
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    return f"eyJhbGciOiJub25lIn0.{payload}."


def response(body):
    handle = mock.MagicMock()
    handle.__enter__.return_value = handle
    handle.read.return_value = json.dumps(body).encode()
    return handle


@override_settings(
    GOOGLE_SIGN_IN_CLIENT_ID="synthetic-client",
    GOOGLE_SIGN_IN_CLIENT_SECRET="synthetic-secret",
    FORKLUCK_APP_ORIGIN="https://app.example.test",
    FORKLUCK_ALLOW_DEMO_ACCOUNT=False,
    FORKLUCK_REQUIRE_EMAIL_VERIFICATION=True,
    FORKLUCK_REGISTRATION_NOTIFICATION_EMAIL="",
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
)
class GoogleSignInTests(TestCase):
    def setUp(self):
        self.urlopen = self.enterContext(mock.patch("urllib.request.urlopen"))
        self.newsletter = self.enterContext(mock.patch("forkluck.domains.accounts.views.upsert_member"))

    def start(self, next_path="/recipes"):
        result = self.client.get("/api/auth/google/start", {"next": next_path})
        self.assertEqual(result.status_code, 302)
        self.state = parse_qs(urlparse(result.url).query)["state"][0]
        self.held = self.client.session[google.SESSION_KEY]
        return result

    def finish(self, claims=None, **query):
        identity = {
            "iss": "https://accounts.google.com", "aud": "synthetic-client",
            "exp": int(time.time()) + 3600, "nonce": self.held["oidc_nonce"],
            "sub": "google-123", "email": "Chef@Example.com",
            "email_verified": True, "name": "Chef Google",
            **(claims or {}),
        }
        self.urlopen.return_value = response({"id_token": id_token(identity)})
        return self.client.get("/api/auth/google/callback", {
            "state": self.state, "code": "synthetic-code", **query,
        })

    def assert_failure(self, result, code, next_path="/recipes"):
        self.assertEqual(result.status_code, 302)
        self.assertEqual(urlparse(result.url).path, "/login")
        expected = {"error": [code]}
        if next_path != "/":
            expected["next"] = [next_path]
        self.assertEqual(parse_qs(urlparse(result.url).query), expected)
        self.assertNotIn(google.SESSION_KEY, self.client.session)
        self.assertNotIn("_auth_user_id", self.client.session)
        self.assertIn("no-store", result["Cache-Control"])

    def test_start_parameters_and_pkce_are_bound_to_session(self):
        result = self.start()
        params = parse_qs(urlparse(result.url).query)
        self.assertEqual(urlparse(result.url).netloc, "accounts.google.com")
        self.assertEqual(params, {
            "client_id": ["synthetic-client"],
            "redirect_uri": ["https://app.example.test/api/auth/google/callback"],
            "response_type": ["code"], "scope": ["openid email profile"],
            "access_type": ["online"], "prompt": ["select_account"],
            "state": [self.state], "nonce": [self.held["oidc_nonce"]],
            "code_challenge": [google_sign_in.pkce_challenge(self.held["verifier"])],
            "code_challenge_method": ["S256"],
        })
        self.assertNotEqual(self.held["nonce"], self.held["oidc_nonce"])
        self.assertEqual(result["Referrer-Policy"], "no-referrer")
        self.assertIn("no-store", result["Cache-Control"])
        self.assertEqual(len(self.held["verifier"]), 43)
        self.assertNotIn("synthetic-secret", result.url)
        self.urlopen.assert_not_called()

    def test_new_user_is_verified_seeded_and_signed_in_without_password(self):
        self.start()
        with self.captureOnCommitCallbacks(execute=True):
            result = self.finish(next="/settings")
        self.assertEqual(result.url, "/recipes")
        user = User.objects.get(email="chef@example.com")
        self.assertEqual(user.google_subject, "google-123")
        self.assertEqual(user.name, "Chef Google")
        self.assertIsNotNone(user.email_verified_at)
        self.assertTrue(user.first_sign_in_notification_pending)
        self.assertFalse(user.has_usable_password())
        self.assertEqual(Recipe.objects.filter(user=user).count(), 1)
        self.assertTrue(BenchCostSettings.objects.filter(user=user).exists())
        self.assertEqual(self.client.session["_auth_user_id"], str(user.pk))
        self.assertNotIn(google.SESSION_KEY, self.client.session)
        self.assertEqual(result.cookies[settings.FORKLUCK_SIGNED_IN_COOKIE_NAME].value, "1")
        self.assertFalse(self.client.get("/api/auth/session").json()["user"]["hasPassword"])
        self.newsletter.assert_called_once_with("chef@example.com", "Chef Google")
        request = self.urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://oauth2.googleapis.com/token")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(self.urlopen.call_args.kwargs, {"timeout": 10})
        self.assertEqual(parse_qs(request.data.decode()), {
            "client_id": ["synthetic-client"], "client_secret": ["synthetic-secret"],
            "redirect_uri": ["https://app.example.test/api/auth/google/callback"],
            "grant_type": ["authorization_code"], "code": ["synthetic-code"],
            "code_verifier": [self.held["verifier"]],
        })
        # The password route reveals no special Google-only account state.
        result = self.client.post("/api/auth/login", json.dumps({
            "email": user.email, "password": "any-password",
        }), content_type="application/json")
        self.assertEqual(result.status_code, 401)
        self.assertEqual(result.json()["error"], "Email or password is incorrect")

    def test_existing_email_links_without_overwriting_name_or_password_and_claims_invite(self):
        owner = User.objects.create_user(email="owner@example.com", name="Owner")
        user = User.objects.create_user(email="chef@example.com", name="Chosen name", password="kept-password")
        KitchenInvite.objects.create(owner=owner, email="Chef@Example.com", role="viewer")
        self.start()
        self.assertEqual(self.finish().url, "/recipes")
        user.refresh_from_db()
        self.assertEqual(user.google_subject, "google-123")
        self.assertEqual(user.name, "Chosen name")
        self.assertTrue(user.check_password("kept-password"))
        self.assertIsNotNone(user.email_verified_at)
        self.assertTrue(KitchenMembership.objects.filter(owner=owner, member=user).exists())
        self.assertFalse(KitchenInvite.objects.exists())
        self.assertFalse(Recipe.objects.filter(user=user).exists())
        self.assertEqual(User.objects.count(), 2)

    def test_subject_wins_over_email_and_keeps_account_address(self):
        user = User.objects.create_user(email="old@example.com", name="Original", google_subject="google-123", email_verified_at=timezone.now())
        User.objects.create_user(email="chef@example.com", name="Other")
        self.start()
        with self.assertLogs("forkluck.domains.accounts.google", level="INFO"):
            self.finish()
        self.assertEqual(self.client.session["_auth_user_id"], str(user.pk))
        user.refresh_from_db()
        self.assertEqual(user.email, "old@example.com")
        self.assertEqual(User.objects.count(), 2)

    def test_email_match_with_other_subject_keeps_existing_link(self):
        user = User.objects.create_user(email="chef@example.com", name="Original", google_subject="older-subject")
        self.start()
        with self.assertLogs("forkluck.domains.accounts.google", level="INFO"):
            self.finish()
        user.refresh_from_db()
        self.assertEqual(user.google_subject, "older-subject")
        self.assertEqual(self.client.session["_auth_user_id"], str(user.pk))

    def test_name_falls_back_and_long_name_is_truncated(self):
        for name, expected in ((None, "chef"), ("", "chef"), ("x" * 200, "x" * 150)):
            with self.subTest(name=name):
                self.start()
                self.finish({"name": name})
                user = User.objects.get(email="chef@example.com")
                self.assertEqual(user.name, expected)
                user.delete()
                self.client.logout()

    def test_other_google_issuer_is_accepted(self):
        self.start()
        self.assertEqual(self.finish({"iss": "accounts.google.com"}).url, "/recipes")

    def test_unconfigured_routes_and_internal_flag(self):
        for enabled in (False, True):
            with self.subTest(enabled=enabled), override_settings(
                GOOGLE_SIGN_IN_CLIENT_ID="synthetic-client" if enabled else "",
                GOOGLE_SIGN_IN_CLIENT_SECRET="synthetic-secret" if enabled else "",
            ):
                result = self.client.get("/internal/v1/auth-methods/", HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET)
                self.assertEqual(result.json(), {"google": enabled})
                if not enabled:
                    self.assert_failure(self.client.get("/api/auth/google/start", {"next": "/recipes"}), "google-not-configured")
        self.assertEqual(self.client.get("/internal/v1/auth-methods/").status_code, 404)
        self.start()
        with override_settings(GOOGLE_SIGN_IN_CLIENT_ID="", GOOGLE_SIGN_IN_CLIENT_SECRET=""):
            self.assert_failure(self.finish(), "google-not-configured")
        self.urlopen.assert_not_called()

    def test_provider_error_retires_flow(self):
        for error, code in (("access_denied", "google-cancelled"), ("server_error", "google-failed")):
            with self.subTest(error=error):
                self.start()
                self.assert_failure(self.finish(error=error), code)
        self.urlopen.assert_not_called()

    def test_bad_missing_foreign_and_mismatched_state_retire_flow(self):
        for state in ("", "bad", signing.dumps({"n": "bad"}, salt="pos-oauth"), signing.dumps({"n": "wrong"}, salt=google.STATE_SALT), signing.dumps({"n": "é"}, salt=google.STATE_SALT)):
            with self.subTest(state=state):
                self.start()
                self.assert_failure(self.finish(state=state), "google-state")
        self.start()
        self.assert_failure(self.client.get("/api/auth/google/callback", {"code": "code"}), "google-state")
        self.urlopen.assert_not_called()

    def test_state_from_another_browser_is_refused(self):
        self.start()
        result = Client().get("/api/auth/google/callback", {"state": self.state, "code": "code"})
        self.assertEqual(result.url, "/login?error=google-state")
        self.urlopen.assert_not_called()

    def test_replay_and_second_start_retire_old_state(self):
        self.start()
        old_state = self.state
        self.start()
        self.assert_failure(self.finish(state=old_state), "google-state")
        self.start()
        self.finish()
        result = self.finish()
        self.assertEqual(result.url, "/login?error=google-state")
        self.assertEqual(self.urlopen.call_count, 1)

    def test_expired_state(self):
        self.start()
        with mock.patch("django.core.signing.time.time", return_value=time.time() + 601):
            self.assert_failure(self.finish(), "google-state")
        self.urlopen.assert_not_called()

    def test_exchange_failures_are_friendly_and_never_retried(self):
        for error in (urllib.error.HTTPError("https://oauth2.googleapis.com/token", 400, "bad", {}, None), urllib.error.URLError("offline"), TimeoutError("timeout"), http.client.IncompleteRead(b"partial")):
            with self.subTest(error=error):
                self.start()
                self.urlopen.reset_mock()
                self.urlopen.side_effect = error
                self.assert_failure(self.finish(), "google-failed")
                self.urlopen.assert_called_once()
        self.urlopen.side_effect = None

    def test_invalid_exchange_bodies_and_jwts(self):
        for body in (b"not json", b"[]", b"{}", b'{"id_token": null}', b'{"id_token": ""}', b'{"id_token": "bad"}', b'{"id_token": "a.@@@.c"}', json.dumps({"id_token": id_token([])}).encode()):
            with self.subTest(body=body):
                self.start()
                handle = response({})
                handle.read.return_value = body
                self.urlopen.return_value = handle
                result = self.client.get("/api/auth/google/callback", {"state": self.state, "code": "code"})
                self.assert_failure(result, "google-failed")
        self.assertFalse(User.objects.exists())

    def test_repeated_next_is_ambiguous_and_dropped(self):
        self.start(["/recipes", "/settings"])
        self.assertEqual(self.held["next"], "/")
        self.assert_failure(self.finish(error="access_denied"), "google-cancelled", "/")

    def test_missing_code_does_not_exchange(self):
        self.start()
        self.assert_failure(self.finish(code=""), "google-failed")
        self.urlopen.assert_not_called()

    def test_claim_failures_never_create_an_account(self):
        for field, values in {
            "iss": [None, "https://evil.example", []],
            "aud": [None, "other-client", ["synthetic-client"]],
            "exp": [None, 0, time.time() - 1, "9999999999", True, float("nan"), float("inf")],
            "nonce": [None, "other", "é", []],
            "sub": [None, "", " ", 123, "x" * 256],
            "email": [None, "", "invalid", 123, "x" * 255],
            "email_verified": [None, False, "true", 1],
        }.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    AuthThrottle.objects.all().delete()
                    self.start()
                    self.assert_failure(self.finish({field: value}), "google-unverified-email" if field == "email_verified" else "google-failed")
                    self.assertFalse(User.objects.exists())
        self.newsletter.assert_not_called()

    def test_inactive_accounts_are_not_linked_or_activated(self):
        for subject in (None, "google-123"):
            with self.subTest(subject=subject):
                user = User.objects.create_user(email="chef@example.com", name="Inactive", is_active=False, google_subject=subject)
                self.start()
                self.assert_failure(self.finish(), "google-inactive")
                user.refresh_from_db()
                self.assertIsNone(user.email_verified_at)
                self.assertEqual(user.google_subject, subject)
                user.delete()

    def test_demo_account_is_refused_unless_enabled(self):
        self.start()
        self.assert_failure(self.finish({"email": "user@user.com"}), "google-failed")
        self.assertFalse(User.objects.exists())
        with override_settings(FORKLUCK_ALLOW_DEMO_ACCOUNT=True):
            self.start()
            self.assertEqual(self.finish({"email": "user@user.com"}).url, "/recipes")

    def test_both_routes_are_throttled_and_callback_retires_state(self):
        for scope, limit, route in (("google-start:ip", 30, "start"), ("google-callback:ip", 60, "callback")):
            with self.subTest(scope=scope):
                AuthThrottle.objects.all().delete()
                self.start()
                # Fill the actual IP bucket to its boundary, keeping the test fast.
                if route == "callback":
                    self.client.get("/api/auth/google/callback")
                    self.start()
                AuthThrottle.objects.filter(scope=scope).update(count=limit)
                result = self.client.get(f"/api/auth/google/{route}", {"next": "/recipes", "state": self.state, "code": "code"})
                if route == "start":
                    self.assertIn("google-rate-limited", result.url)
                else:
                    self.assert_failure(result, "google-rate-limited")
        self.urlopen.assert_not_called()

    def test_safe_next_parity_and_callback_query_is_ignored(self):
        cases = [
            ("/recipes?view=all#row", "/recipes?view=all#row"),
            ("/api/auth/google/start?next=%2Frecipes", "/api/auth/google/start?next=%2Frecipes"),
            ("/api/auth/feedback/authorize?state=x", "/api/auth/feedback/authorize?state=x"),
            ("//evil.example", "/"), ("https://evil.example", "/"),
            ("/\\evil.example", "/"), ("/has space", "/"),
            ("/has\nnewline", "/"), ("/has\x7fdelete", "/"),
            ("/" + "x" * 8192, "/"),
            ("/" + "🍞" * 4096, "/"),
            ("/" + "x" * 8191, "/" + "x" * 8191),
        ]
        for raw, expected in cases:
            with self.subTest(raw=raw[:50]):
                self.start(raw)
                self.assertEqual(self.held["next"], expected)
                result = self.finish(error="access_denied", next="//evil.example")
                self.assert_failure(result, "google-cancelled", expected)
        for raw in (None, 1, [], {}):
            self.assertEqual(google.safe_next(raw), "/")

    @override_settings(FORKLUCK_REGISTRATION_NOTIFICATION_EMAIL="owner@example.com")
    @mock.patch("forkluck.domains.accounts.views.send_new_user_notification")
    def test_owner_notification_fires_once(self, notify):
        self.start()
        self.finish()
        self.start()
        self.finish()
        notify.assert_called_once()
        self.assertFalse(User.objects.get(email="chef@example.com").first_sign_in_notification_pending)

    def test_switching_accounts_flushes_old_session_after_consuming_state(self):
        old_user = User.objects.create_user(email="old@example.com", name="Old")
        self.client.force_login(old_user)
        session = self.client.session
        session["private-old-state"] = "old-account"
        session.save()
        old_key = session.session_key
        self.start()
        self.assertEqual(self.finish().url, "/recipes")
        self.assertNotEqual(self.client.session.session_key, old_key)
        self.assertNotIn("private-old-state", self.client.session)
        self.assertNotIn(google.SESSION_KEY, self.client.session)
        self.assertNotEqual(self.client.session["_auth_user_id"], str(old_user.pk))

    def test_unique_insert_race_resolves_the_winning_row(self):
        user = User.objects.create_user(email="chef@example.com", name="Winner", google_subject="google-123")
        real_filter = User.objects.filter
        with mock.patch.object(User.objects, "select_for_update") as locked:
            locked.return_value.filter.side_effect = [User.objects.none(), User.objects.none(), real_filter(pk=user.pk)]
            with mock.patch.object(User.objects, "create_user", side_effect=IntegrityError("race")):
                result = google.resolve_user({"sub": "google-123", "email": user.email, "name": "Ignored"})
        self.assertEqual(result.pk, user.pk)
        self.assertEqual(User.objects.count(), 1)

    def test_post_is_not_allowed(self):
        for route in ("start", "callback"):
            self.assertEqual(self.client.post(f"/api/auth/google/{route}").status_code, 405)
