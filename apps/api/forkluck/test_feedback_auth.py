import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import patch
from unittest import skipUnless
from urllib.parse import parse_qs, urlencode, urlparse

from django.db import close_old_connections, connection
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from .domains.accounts.billing import delete_user_with_billing
from .integrations.feedback import remove_feedback_user
from .models import FeedbackGrant, User


@override_settings(
    FORKLUCK_FEEDBACK_ORIGIN="https://feedback.example.test",
    FORKLUCK_FEEDBACK_CLIENT_SECRET="synthetic-feedback-client-secret-123456",
    FORKLUCK_FEEDBACK_API_KEY="synthetic-api-key",
    STRIPE_BILLING_ENABLED=False,
)
class FeedbackAuthTests(TestCase):
    root = "/api/auth/feedback/"
    callback = "https://feedback.example.test/oauth/_forkluck/callback"
    secret = "synthetic-feedback-client-secret-123456"

    def setUp(self):
        self.user = User.objects.create_user(
            email="feedback@example.test", name="Feedback Tester",
            password="synthetic-password-123", email_verified_at=timezone.now(),
        )
        self.client.force_login(self.user)

    def authorize(self, **changes):
        params = {
            "client_id": "forkluck-feedback", "response_type": "code",
            "redirect_uri": self.callback, "scope": "profile", "state": "browser-state",
        }
        params.update(changes)
        return self.client.get(self.root + "authorize", params)

    def code(self):
        response = self.authorize()
        self.assertEqual(response.status_code, 302)
        self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual(response["Referrer-Policy"], "no-referrer")
        query = parse_qs(urlparse(response["Location"]).query)
        self.assertEqual(query["state"], ["browser-state"])
        return query["code"][0]

    def exchange(self, code, basic=False, **changes):
        fields = {
            "grant_type": "authorization_code", "code": code,
            "redirect_uri": self.callback,
        }
        headers = {}
        if basic:
            encoded = base64.b64encode(f"forkluck-feedback:{self.secret}".encode()).decode()
            headers["HTTP_AUTHORIZATION"] = "Basic " + encoded
        else:
            fields.update(client_id="forkluck-feedback", client_secret=self.secret)
        fields.update(changes)
        # No browser session or CSRF token is needed for the confidential client.
        return Client(enforce_csrf_checks=True).post(
            self.root + "token", urlencode(fields),
            content_type="application/x-www-form-urlencoded", **headers,
        )

    def profile(self, token):
        return Client().get(self.root + "profile", HTTP_AUTHORIZATION="Bearer " + token)

    def test_existing_user_and_both_client_auth_methods(self):
        for basic in (False, True):
            with self.subTest(basic=basic):
                code = self.code()
                response = self.exchange(code, basic=basic)
                self.assertEqual(response.status_code, 200)
                self.assertIn("no-store", response["Cache-Control"])
                token = response.json()["access_token"]
                stored = FeedbackGrant.objects.latest("expires_at")
                self.assertNotEqual(stored.code_digest, code)
                self.assertNotEqual(stored.access_digest, token)
                profile = self.profile(token)
                self.assertEqual(profile.json(), {
                    "id": str(self.user.pk), "name": self.user.name, "email": self.user.email,
                })
                self.assertEqual(User.objects.count(), 1)

    def test_signed_out_and_unverified_visitors_resume_at_authorize(self):
        self.client.logout()
        response = self.authorize()
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response["Location"].startswith("/login?next="))
        next_url = parse_qs(urlparse(response["Location"]).query)["next"][0]
        self.assertTrue(next_url.startswith(self.root + "authorize?"))
        self.user.email_verified_at = None
        self.user.save()
        self.client.force_login(self.user)
        self.assertTrue(self.authorize()["Location"].startswith("/login?"))
        self.assertEqual(FeedbackGrant.objects.count(), 0)

    def test_invalid_callbacks_clients_scopes_and_syntax_never_redirect(self):
        for changes in (
            {"redirect_uri": "https://evil.test/oauth/_forkluck/callback"},
            {"redirect_uri": self.callback + "?next=https://evil.test"},
            {"redirect_uri": self.callback + "/"},
            {"redirect_uri": self.callback.replace("https", "http")},
            {"client_id": "unknown"}, {"response_type": "token"},
            {"scope": "profile recipes"}, {"scope": ""}, {"state": ""},
            {"state": "x" * 2049}, {"code_challenge": "unsupported"},
            {"client_id": ["unknown", "forkluck-feedback"]},
        ):
            with self.subTest(changes=changes):
                response = self.authorize(**changes)
                self.assertEqual(response.status_code, 400)
                self.assertNotIn("Location", response)
        self.assertEqual(FeedbackGrant.objects.count(), 0)

    def test_wrong_client_wrong_callback_and_expired_code(self):
        code = self.code()
        for changes in ({"client_secret": "wrong"}, {"client_id": "foreign"}, {"client_secret": "é"}):
            self.assertEqual(self.exchange(code, **changes).status_code, 401)
        self.assertEqual(self.exchange(code, redirect_uri=self.callback + "/").status_code, 400)
        FeedbackGrant.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.exchange(code).json()["error"], "invalid_grant")

    def test_replay_revokes_previously_issued_token(self):
        code = self.code()
        token = self.exchange(code).json()["access_token"]
        self.assertEqual(self.exchange(code).json()["error"], "invalid_grant")
        self.assertEqual(self.profile(token).status_code, 401)

    def test_password_change_disabling_and_deletion_revoke_profile_access(self):
        for mutation in ("password", "inactive", "unverified", "delete"):
            with self.subTest(mutation=mutation):
                self.user.refresh_from_db()
                self.user.is_active = True
                self.user.email_verified_at = timezone.now()
                self.user.save()
                self.client.force_login(self.user)
                token = self.exchange(self.code()).json()["access_token"]
                if mutation == "password":
                    self.user.set_password("another-synthetic-password")
                    self.user.save()
                elif mutation == "inactive":
                    self.user.is_active = False
                    self.user.save()
                elif mutation == "unverified":
                    self.user.email_verified_at = None
                    self.user.save()
                else:
                    self.user.delete()
                self.assertEqual(self.profile(token).status_code, 401)
        self.assertEqual(FeedbackGrant.objects.count(), 0)

    def test_expired_tokens_and_query_tokens_are_rejected(self):
        token = self.exchange(self.code()).json()["access_token"]
        FeedbackGrant.objects.update(access_expires_at=timezone.now())
        self.assertEqual(self.profile(token).status_code, 401)
        self.assertEqual(self.client.get(self.root + "profile", {"access_token": token}).status_code, 401)

    def test_account_change_before_redemption_is_rejected(self):
        code = self.code()
        self.user.set_password("new-synthetic-password")
        self.user.save()
        self.assertEqual(self.exchange(code).json()["error"], "invalid_grant")

    def test_authorization_is_rate_limited(self):
        for _ in range(30):
            self.assertEqual(self.authorize().status_code, 302)
        self.assertEqual(self.authorize().status_code, 429)

    def test_wrong_method_duplicate_fields_and_malformed_credentials(self):
        self.assertEqual(self.client.post(self.root + "authorize").status_code, 405)
        self.assertEqual(self.client.get(self.root + "token").status_code, 405)
        code = self.code()
        self.assertEqual(self.exchange(code, grant_type="password").status_code, 400)
        self.assertEqual(self.exchange(code, basic=True, client_secret=self.secret).status_code, 401)
        response = self.client.post(self.root + "token", "code=a&code=b",
                                    content_type="application/x-www-form-urlencoded")
        self.assertEqual(response.status_code, 400)
        for value in ("Basic !!!", "Basic dXNlcg==", "Bearer token"):
            response = self.client.post(self.root + "token", "grant_type=authorization_code",
                content_type="application/x-www-form-urlencoded", HTTP_AUTHORIZATION=value)
            self.assertEqual(response.status_code, 401)

    @override_settings(FORKLUCK_FEEDBACK_CLIENT_SECRET="")
    def test_optional_integration_disabled(self):
        self.assertEqual(self.authorize().status_code, 404)
        self.assertEqual(self.exchange("x" * 43).status_code, 404)
        self.assertEqual(self.profile("x" * 43).status_code, 404)

    def test_deletion_stops_if_feedback_cannot_be_erased(self):
        with patch("forkluck.domains.accounts.billing.remove_feedback_user", side_effect=ValueError("retry")):
            with self.assertRaisesMessage(ValueError, "retry"):
                delete_user_with_billing(self.user)
        self.assertTrue(User.objects.filter(pk=self.user.pk).exists())
        with patch("forkluck.domains.accounts.billing.remove_feedback_user") as remove:
            user_id = self.user.pk
            delete_user_with_billing(self.user)
            remove.assert_called_once_with(user_id)
        self.assertFalse(User.objects.filter(pk=user_id).exists())

    def test_remote_deletion_uses_provider_identity_and_sanitizes_errors(self):
        with patch("forkluck.integrations.feedback.urlopen") as send:
            send.return_value.__enter__.return_value.status = 200
            remove_feedback_user(self.user.pk)
            request = send.call_args.args[0]
            self.assertEqual(request.method, "DELETE")
            self.assertEqual(request.full_url,
                f"https://feedback.example.test/api/v1/users/by-provider/_forkluck/{self.user.pk}")
        with patch("forkluck.integrations.feedback.urlopen", side_effect=OSError("private details")):
            with self.assertRaisesMessage(ValueError, "Feedback account removal failed") as caught:
                remove_feedback_user(self.user.pk)
            self.assertNotIn("private details", str(caught.exception))


@skipUnless(connection.vendor == "postgresql", "PostgreSQL row-lock boundary")
@override_settings(
    FORKLUCK_FEEDBACK_ORIGIN="https://feedback.example.test",
    FORKLUCK_FEEDBACK_CLIENT_SECRET="synthetic-feedback-client-secret-123456",
)
class FeedbackRedemptionConcurrencyTests(TransactionTestCase):
    def test_two_connections_cannot_redeem_the_same_code(self):
        user = User.objects.create_user(email="concurrent@example.test", name="Cook",
                                       email_verified_at=timezone.now())
        client = Client()
        client.force_login(user)
        callback = "https://feedback.example.test/oauth/_forkluck/callback"
        response = client.get("/api/auth/feedback/authorize", {
            "client_id": "forkluck-feedback", "response_type": "code",
            "redirect_uri": callback, "scope": "profile", "state": "state",
        })
        code = parse_qs(urlparse(response["Location"]).query)["code"][0]

        def exchange(_):
            close_old_connections()
            try:
                return Client().post("/api/auth/feedback/token", urlencode({
                    "client_id": "forkluck-feedback",
                    "client_secret": "synthetic-feedback-client-secret-123456",
                    "grant_type": "authorization_code", "code": code,
                    "redirect_uri": callback,
                }), content_type="application/x-www-form-urlencoded").status_code
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(exchange, range(2)))
        self.assertEqual(sorted(statuses), [200, 400])
        self.assertFalse(FeedbackGrant.objects.exists(), "replay also revokes the issued token")
