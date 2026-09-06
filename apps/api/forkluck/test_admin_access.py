"""Every staff-console route requires the admin-purpose email proof."""

from datetime import timedelta
from unittest import mock

from django.conf import settings
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from .models import EmailVerificationCode, User
from .verification import ADMIN_VERIFIED_SESSION_KEY, issue_code


@override_settings(
    FORKLUCK_ADMIN_CODE_LOGIN=True,
    FORKLUCK_REQUIRE_EMAIL_VERIFICATION=True,
    FORKLUCK_REGISTRATION_NOTIFICATION_EMAIL="",
)
class AdminAccessTests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.password = "a-long-admin-test-passphrase-1357"
        self.staff = User.objects.create_superuser(
            email="admin-access@example.com",
            name="Admin",
            password=self.password,
            email_verified_at=timezone.now(),
        )
        sender = mock.patch("forkluck.verification.send_verification_code")
        self.send_code = sender.start()
        self.addCleanup(sender.stop)
        newsletter = mock.patch("forkluck.domains.accounts.views.sync_newsletter_member")
        newsletter.start()
        self.addCleanup(newsletter.stop)

    def post(self, path, data, *, form=False):
        self.client.get("/api/auth/csrf")
        return self.client.post(
            path,
            data,
            **({} if form else {"content_type": "application/json"}),
            HTTP_X_CSRFTOKEN=self.client.cookies[settings.CSRF_COOKIE_NAME].value,
        )

    def assert_admin_denied(self):
        for path in ("/mommy/", "/mommy/forkluck/user/"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 302)
                self.assertTrue(response.url.startswith("/mommy/login/"))

    def begin_admin_login(self):
        response = self.post(
            "/mommy/login/",
            {"stage": "password", "email": self.staff.email, "password": self.password},
            form=True,
        )
        self.assertContains(response, "6-digit code")
        return self.send_code.call_args.args[1]

    def finish_admin_login(self):
        code = self.begin_admin_login()
        response = self.post(
            "/mommy/login/", {"stage": "code", "code": code}, form=True
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.client.get("/mommy/").status_code, 200)
        self.assertEqual(self.client.get("/mommy/forkluck/user/").status_code, 200)

    def test_public_password_login_requires_additional_admin_code(self):
        response = self.post(
            "/api/auth/login", {"email": self.staff.email, "password": self.password}
        )
        self.assertEqual(response.status_code, 200)
        self.send_code.assert_not_called()
        self.assert_admin_denied()
        self.finish_admin_login()

    def test_public_signup_verification_does_not_grant_admin_access(self):
        self.staff.email_verified_at = None
        self.staff.save(update_fields=["email_verified_at"])
        issue_code(self.staff.email, EmailVerificationCode.PURPOSE_SIGNUP)
        code = self.send_code.call_args.args[1]
        response = self.post(
            "/api/auth/verify-email", {"email": self.staff.email, "code": code}
        )
        self.assertEqual(response.status_code, 200)
        self.assert_admin_denied()
        self.finish_admin_login()

    def test_existing_staff_session_and_wrong_or_expired_codes_are_denied(self):
        self.client.force_login(self.staff)
        self.assert_admin_denied()
        code = self.begin_admin_login()
        wrong = "000000" if code != "000000" else "111111"
        response = self.post(
            "/mommy/login/", {"stage": "code", "code": wrong}, form=True
        )
        self.assertContains(response, "wrong or expired")
        self.assert_admin_denied()
        EmailVerificationCode.objects.filter(
            email=self.staff.email, purpose=EmailVerificationCode.PURPOSE_ADMIN
        ).update(expires_at=timezone.now() - timedelta(seconds=1))
        response = self.post(
            "/mommy/login/", {"stage": "code", "code": code}, form=True
        )
        self.assertContains(response, "wrong or expired")
        self.assert_admin_denied()

    def test_logout_removes_admin_proof(self):
        self.finish_admin_login()
        self.assertEqual(self.post("/api/auth/logout", {}).status_code, 200)
        self.assertNotIn(ADMIN_VERIFIED_SESSION_KEY, self.client.session)
        self.assertEqual(
            self.post(
                "/api/auth/login", {"email": self.staff.email, "password": self.password}
            ).status_code,
            200,
        )
        self.assert_admin_denied()

    def test_proof_is_bound_to_the_staff_account(self):
        self.finish_admin_login()
        other = User.objects.create_superuser(
            email="other-admin@example.com",
            name="Other",
            password=self.password,
            email_verified_at=timezone.now(),
        )
        self.assertEqual(
            self.post(
                "/api/auth/login", {"email": other.email, "password": self.password}
            ).status_code,
            200,
        )
        self.assert_admin_denied()
        # Even a session carrying an old account's marker grants nothing.
        session = self.client.session
        session[ADMIN_VERIFIED_SESSION_KEY] = str(self.staff.pk)
        session.save()
        self.assert_admin_denied()

    @override_settings(FORKLUCK_ADMIN_CODE_LOGIN=False)
    def test_disabled_code_login_preserves_password_only_staff_access(self):
        response = self.post(
            "/api/auth/login", {"email": self.staff.email, "password": self.password}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/mommy/").status_code, 200)
        self.assertEqual(self.client.get("/mommy/forkluck/user/").status_code, 200)
        self.send_code.assert_not_called()
