"""Authenticated password-change boundaries and session lifecycle."""

import json
from datetime import timedelta

from django.conf import settings
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from .models import EmailVerificationCode, User


@override_settings(
    FORKLUCK_ALLOW_DEMO_ACCOUNT=False,
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
)
class ChangePasswordTests(TestCase):
    current_password = "a-long-test-passphrase-2468"
    new_password = "a-different-test-passphrase-9753"

    def setUp(self):
        self.user = User.objects.create_user(
            email="chef@example.com",
            name="Chef",
            password=self.current_password,
        )
        self.client = Client(enforce_csrf_checks=True)
        self.client.force_login(self.user)
        response = self.client.get("/api/auth/csrf")
        self.csrf = response.cookies[settings.CSRF_COOKIE_NAME].value

    def post(
        self, body: dict, *, client: Client | None = None, csrf: str | None = None
    ):
        return (client or self.client).post(
            "/api/auth/change-password",
            data=json.dumps(body),
            content_type="application/json",
            HTTP_X_CSRFTOKEN=self.csrf if csrf is None else csrf,
            HTTP_X_REAL_IP="203.0.113.10",
        )

    def valid_body(self, **overrides):
        return {
            "currentPassword": self.current_password,
            "newPassword": self.new_password,
            **overrides,
        }

    def test_requires_both_session_and_csrf(self):
        signed_out = Client(enforce_csrf_checks=True)
        token_response = signed_out.get("/api/auth/csrf")
        token = token_response.cookies[settings.CSRF_COOKIE_NAME].value

        self.assertEqual(
            self.post(self.valid_body(), client=signed_out, csrf=token).status_code,
            401,
        )
        without_csrf = self.client.post(
            "/api/auth/change-password",
            data=json.dumps(self.valid_body()),
            content_type="application/json",
        )
        self.assertEqual(without_csrf.status_code, 403)

    def test_wrong_current_and_invalid_new_passwords_change_nothing(self):
        wrong = self.post(self.valid_body(currentPassword="wrong-password"))
        weak = self.post(self.valid_body(newPassword="password"))
        reused = self.post(self.valid_body(newPassword=self.current_password))

        self.assertEqual(wrong.status_code, 400)
        self.assertEqual(wrong.json()["error"], "Current password is incorrect")
        self.assertEqual(weak.status_code, 400)
        self.assertEqual(reused.status_code, 400)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(self.current_password))

    def test_malformed_password_fields_change_nothing(self):
        for body in (
            {},
            {"currentPassword": 123, "newPassword": self.new_password},
            {"currentPassword": self.current_password, "newPassword": None},
            {
                "currentPassword": self.current_password,
                "newPassword": "x" * 1025,
            },
        ):
            with self.subTest(body=body):
                self.assertEqual(self.post(body).status_code, 400)

        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(self.current_password))

    def test_success_keeps_this_session_and_invalidates_others_and_reset_codes(self):
        other_session = Client()
        other_session.force_login(self.user)
        reset_code = EmailVerificationCode.objects.create(
            email=self.user.email,
            purpose=EmailVerificationCode.PURPOSE_PASSWORD_RESET,
            code_hash="0" * 64,
            expires_at=timezone.now() + timedelta(minutes=10),
        )

        response = self.post(self.valid_body())

        self.assertEqual(response.status_code, 200, response.content)
        self.user.refresh_from_db()
        reset_code.refresh_from_db()
        self.assertFalse(self.user.check_password(self.current_password))
        self.assertTrue(self.user.check_password(self.new_password))
        self.assertIsNotNone(reset_code.used_at)
        self.assertEqual(self.client.get("/api/auth/session").status_code, 200)
        self.assertEqual(other_session.get("/api/auth/session").status_code, 401)

    def test_wrong_current_password_is_rate_limited(self):
        for _ in range(10):
            self.assertEqual(
                self.post(
                    self.valid_body(currentPassword="wrong-password")
                ).status_code,
                400,
            )

        blocked = self.post(self.valid_body(currentPassword="wrong-password"))
        self.assertEqual(blocked.status_code, 429)
        self.assertEqual(blocked.json()["code"], "rate_limited")


@override_settings(
    FORKLUCK_ALLOW_DEMO_ACCOUNT=True,
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
)
class DemoChangePasswordTests(TestCase):
    def test_demo_password_cannot_change(self):
        user = User.objects.create_user(
            email="user@user.com", name="Demo", password="user"
        )
        client = Client(enforce_csrf_checks=True)
        client.force_login(user)
        response = client.get("/api/auth/csrf")
        token = response.cookies[settings.CSRF_COOKIE_NAME].value

        changed = client.post(
            "/api/auth/change-password",
            data=json.dumps(
                {"currentPassword": "user", "newPassword": "new-password-1234"}
            ),
            content_type="application/json",
            HTTP_X_CSRFTOKEN=token,
        )

        self.assertEqual(changed.status_code, 400)
        user.refresh_from_db()
        self.assertTrue(user.check_password("user"))
