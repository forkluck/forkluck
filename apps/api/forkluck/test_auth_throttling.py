"""Verification-code atomicity and sign-in throttling.

Issuance used to count rows and then insert, with no lock in between, so
concurrent requests could each pass the same limit check. The row was created
before the email was sent, so a failed send left a live code nobody held while
still consuming the address's quota. Verification read a row and saved it
without a lock, so two submissions of one correct code could both succeed —
for a password reset, two password changes from one single-use code. Neither
sign-in path counted attempts at all.
"""

import json
from datetime import timedelta
from unittest.mock import patch

from config.settings import signed_in_cookie_domain
from django.conf import settings
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from . import throttling
from .integrations.emails import EmailNotConfigured
from .models import AuthThrottle, EmailVerificationCode, User
from .domains.accounts.views import MAX_REGISTRATIONS_PER_IP
from .verification import (
    CODE_TTL,
    MAX_ACTIVE_CODES,
    MAX_CODES_PER_IP,
    MAX_SIGN_IN_ATTEMPTS,
    MAX_SIGN_IN_ATTEMPTS_PER_IP,
    SIGN_IN_WINDOW,
    check_sign_in_allowed,
    issue_code,
    verify_code,
)


SENT: list[tuple[str, str, str]] = []


def fake_send(to: str, code: str, *, purpose: str) -> None:
    SENT.append((to, code, purpose))


class IssueCodeTests(TestCase):
    def setUp(self):
        SENT.clear()

    def test_a_new_code_retires_the_previous_one(self):
        with patch("forkluck.verification.send_verification_code", fake_send):
            issue_code("chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP)
            first = SENT[-1][1]
            issue_code("chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP)
            second = SENT[-1][1]

        self.assertNotEqual(first, second)
        self.assertFalse(
            verify_code(
                "chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP, first
            ),
            "issuing a new code must retire the old one",
        )
        self.assertTrue(
            verify_code(
                "chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP, second
            )
        )

    def test_a_failed_send_leaves_no_usable_code(self):
        def exploding_send(to, code, *, purpose):
            SENT.append((to, code, purpose))
            raise ValueError("The verification email could not be sent")

        with patch("forkluck.verification.send_verification_code", exploding_send):
            with self.assertRaises(ValueError):
                issue_code("chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP)

        undelivered = SENT[-1][1]
        self.assertFalse(
            EmailVerificationCode.objects.filter(email="chef@example.com").exists(),
            "an undelivered code must not stay in the database",
        )
        self.assertFalse(
            verify_code(
                "chef@example.com",
                EmailVerificationCode.PURPOSE_SIGNUP,
                undelivered,
            )
        )

    def test_a_failed_send_still_consumes_quota(self):
        # Otherwise a caller that can force send failures gets an unlimited
        # retry loop against the email provider.
        def exploding_send(to, code, *, purpose):
            raise ValueError("nope")

        with patch("forkluck.verification.send_verification_code", exploding_send):
            for _ in range(MAX_ACTIVE_CODES):
                with self.assertRaises(ValueError):
                    issue_code("chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP)

        with patch("forkluck.verification.send_verification_code", fake_send):
            with self.assertRaises(ValueError) as caught:
                issue_code("chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP)
        self.assertIn("Too many codes", str(caught.exception))

    def test_issuance_limit_is_per_address_and_purpose(self):
        with patch("forkluck.verification.send_verification_code", fake_send):
            for _ in range(MAX_ACTIVE_CODES):
                issue_code("chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP)
            with self.assertRaises(ValueError):
                issue_code("chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP)

            # A different purpose and a different address are unaffected.
            issue_code(
                "chef@example.com", EmailVerificationCode.PURPOSE_PASSWORD_RESET
            )
            issue_code("other@example.com", EmailVerificationCode.PURPOSE_SIGNUP)

    def test_the_limit_counter_is_one_row_updated_under_a_lock(self):
        # The regression was count-then-insert: two callers reading the same
        # count. Pin that issuance now goes through a single counter row.
        with patch("forkluck.verification.send_verification_code", fake_send):
            issue_code("chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP)
            issue_code("chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP)

        row = AuthThrottle.objects.get(scope="code:signup")
        self.assertEqual(row.count, 2)

    def test_the_address_is_not_stored_in_the_clear_on_the_counter(self):
        with patch("forkluck.verification.send_verification_code", fake_send):
            issue_code("chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP)

        self.assertNotIn(
            "chef@example.com",
            "".join(AuthThrottle.objects.values_list("key", flat=True)),
        )

    def test_one_client_ip_cannot_spray_unlimited_addresses(self):
        with patch("forkluck.verification.send_verification_code", fake_send):
            with self.assertRaises(ValueError) as caught:
                for index in range(200):
                    issue_code(
                        f"chef{index}@example.com",
                        EmailVerificationCode.PURPOSE_SIGNUP,
                        client_ip="203.0.113.9",
                    )
        self.assertIn("Too many codes", str(caught.exception))
        # A different client is unaffected by that budget.
        with patch("forkluck.verification.send_verification_code", fake_send):
            issue_code(
                "fresh@example.com",
                EmailVerificationCode.PURPOSE_SIGNUP,
                client_ip="198.51.100.4",
            )

    def test_rejected_client_bucket_does_not_spend_the_address_bucket(self):
        blocked_ip = "203.0.113.20"
        for _ in range(MAX_CODES_PER_IP):
            throttling.hit(
                "code:ip",
                blocked_ip,
                limit=MAX_CODES_PER_IP,
                window=CODE_TTL,
                message="blocked",
            )

        with self.assertRaises(ValueError):
            issue_code(
                "victim@example.com",
                EmailVerificationCode.PURPOSE_SIGNUP,
                client_ip=blocked_ip,
            )

        self.assertFalse(
            AuthThrottle.objects.filter(scope="code:signup").exists()
        )


class RegistrationThrottlingTests(TestCase):
    """Signup is counted before the account exists.

    `register` creates the user *and* seeds a whole workspace, and with email
    verification off — the default — nothing further down the path counts at
    all, so an uncounted signup is an unbounded write amplifier.
    """

    def register(self, email: str, ip: str = "203.0.113.9"):
        return Client().post(
            "/api/auth/register",
            data=json.dumps(
                {
                    "name": "Chef",
                    "email": email,
                    "password": "a-long-test-passphrase-2468",
                }
            ),
            content_type="application/json",
            HTTP_X_REAL_IP=ip,
        )

    def test_one_client_ip_cannot_create_unlimited_workspaces(self):
        for index in range(MAX_REGISTRATIONS_PER_IP):
            self.assertEqual(self.register(f"chef{index}@example.com").status_code, 201)

        blocked = self.register("chef-over@example.com")
        self.assertEqual(blocked.status_code, 429)
        self.assertEqual(blocked.json()["code"], "rate_limited")

    def test_a_refused_signup_creates_no_account_at_all(self):
        for index in range(MAX_REGISTRATIONS_PER_IP):
            self.register(f"chef{index}@example.com")

        self.register("chef-over@example.com")

        self.assertFalse(User.objects.filter(email="chef-over@example.com").exists())

    def test_a_different_client_keeps_its_own_budget(self):
        for index in range(MAX_REGISTRATIONS_PER_IP):
            self.register(f"chef{index}@example.com")

        self.assertEqual(
            self.register("elsewhere@example.com", ip="198.51.100.7").status_code,
            201,
        )


class VerifyCodeTests(TestCase):
    def setUp(self):
        SENT.clear()

    def issue(self, purpose=EmailVerificationCode.PURPOSE_SIGNUP) -> str:
        with patch("forkluck.verification.send_verification_code", fake_send):
            issue_code("chef@example.com", purpose)
        return SENT[-1][1]

    def test_a_correct_code_works_exactly_once(self):
        code = self.issue()

        self.assertTrue(
            verify_code("chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP, code)
        )
        self.assertFalse(
            verify_code("chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP, code),
            "a single-use code must not verify twice",
        )

    def test_a_used_code_is_marked_used_not_merely_ignored(self):
        code = self.issue()
        verify_code("chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP, code)

        row = EmailVerificationCode.objects.get(email="chef@example.com")
        self.assertIsNotNone(row.used_at)

    def test_wrong_codes_burn_attempts_until_the_code_dies(self):
        self.issue()
        for _ in range(EmailVerificationCode.MAX_ATTEMPTS):
            self.assertFalse(
                verify_code(
                    "chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP, "000000"
                )
            )

        row = EmailVerificationCode.objects.get(email="chef@example.com")
        self.assertEqual(row.attempts, EmailVerificationCode.MAX_ATTEMPTS)

    def test_expired_codes_do_not_verify(self):
        code = self.issue()
        EmailVerificationCode.objects.filter(email="chef@example.com").update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )

        self.assertFalse(
            verify_code("chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP, code)
        )

    def test_a_code_is_bound_to_its_purpose(self):
        code = self.issue(EmailVerificationCode.PURPOSE_PASSWORD_RESET)

        self.assertFalse(
            verify_code("chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP, code)
        )
        self.assertTrue(
            verify_code(
                "chef@example.com", EmailVerificationCode.PURPOSE_PASSWORD_RESET, code
            )
        )

    def test_malformed_input_never_reaches_the_database(self):
        self.issue()
        for candidate in ("", "abc", "12345", "1234567", "12 45 6"):
            self.assertFalse(
                verify_code(
                    "chef@example.com",
                    EmailVerificationCode.PURPOSE_SIGNUP,
                    candidate,
                )
            )
        row = EmailVerificationCode.objects.get(email="chef@example.com")
        self.assertEqual(row.attempts, 0, "rejected shapes must not burn attempts")


class PasswordResetSingleUseTests(TestCase):
    """One reset code must produce at most one password change."""

    def setUp(self):
        SENT.clear()
        self.user = User.objects.create_user(
            email="chef@example.com",
            name="Chef",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()

    def post(self, path: str, body: dict, **extra):
        return self.client.post(
            path, data=json.dumps(body), content_type="application/json", **extra
        )

    def test_a_reset_code_cannot_change_the_password_twice(self):
        with patch("forkluck.verification.send_verification_code", fake_send):
            issue_code(
                "chef@example.com", EmailVerificationCode.PURPOSE_PASSWORD_RESET
            )
        code = SENT[-1][1]

        first = self.post(
            "/api/auth/reset-password",
            {
                "email": "chef@example.com",
                "code": code,
                "password": "first-new-passphrase-1234",
            },
        )
        second = self.post(
            "/api/auth/reset-password",
            {
                "email": "chef@example.com",
                "code": code,
                "password": "second-new-passphrase-5678",
            },
        )

        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(second.status_code, 400, second.content)

        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password("first-new-passphrase-1234"))
        self.assertFalse(self.user.check_password("second-new-passphrase-5678"))


# MD5 hashing keeps these cases about the limiter rather than about PBKDF2:
# they deliberately make hundreds of sign-in attempts.
@override_settings(
    FORKLUCK_ALLOW_DEMO_ACCOUNT=False,
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
)
class SignInThrottlingTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email="chef@example.com",
            name="Chef",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()

    def sign_in(self, password: str, *, email="chef@example.com", ip="203.0.113.5"):
        return self.client.post(
            "/api/auth/login",
            data=json.dumps({"email": email, "password": password}),
            content_type="application/json",
            HTTP_X_REAL_IP=ip,
        )

    def test_repeated_wrong_passwords_are_eventually_refused(self):
        for _ in range(MAX_SIGN_IN_ATTEMPTS):
            self.assertEqual(self.sign_in("wrong-passphrase").status_code, 401)

        blocked = self.sign_in("wrong-passphrase")
        self.assertEqual(blocked.status_code, 429)
        self.assertEqual(blocked.json()["code"], "rate_limited")

    def test_the_correct_password_is_refused_too_once_throttled(self):
        # Otherwise the limiter is trivially bypassed by the attacker's very
        # next guess being right.
        for _ in range(MAX_SIGN_IN_ATTEMPTS):
            self.sign_in("wrong-passphrase")

        blocked = self.sign_in("a-long-test-passphrase-2468")
        self.assertEqual(blocked.status_code, 429)

    def test_a_successful_sign_in_clears_the_address_budget(self):
        for _ in range(MAX_SIGN_IN_ATTEMPTS - 1):
            self.sign_in("wrong-passphrase")

        good = self.sign_in("a-long-test-passphrase-2468")
        self.assertEqual(good.status_code, 200, good.content)

        # Budget refunded: a fresh run of failures is allowed again.
        for _ in range(MAX_SIGN_IN_ATTEMPTS - 1):
            self.assertEqual(self.sign_in("wrong-passphrase").status_code, 401)

    def test_a_successful_sign_in_does_not_refund_the_client_budget(self):
        # An attacker who lands one account must not thereby reset the budget
        # they are spending against every other account.
        self.sign_in("wrong-passphrase")
        before = AuthThrottle.objects.get(scope="signin:ip").count

        self.sign_in("a-long-test-passphrase-2468")

        after = AuthThrottle.objects.get(scope="signin:ip").count
        self.assertGreater(after, before)

    def test_one_client_cannot_spread_attempts_across_addresses(self):
        # Every address carries its own budget, so without the client bucket a
        # single attacker could guess forever by rotating the address.
        statuses = [
            self.sign_in(
                "wrong-passphrase", email=f"chef{index}@example.com"
            ).status_code
            for index in range(MAX_SIGN_IN_ATTEMPTS_PER_IP + 5)
        ]

        self.assertIn(429, statuses, "the client budget must run out")
        self.assertEqual(
            statuses.index(429),
            MAX_SIGN_IN_ATTEMPTS_PER_IP,
            "and must run out exactly at the client limit",
        )

    def test_a_different_client_keeps_its_own_budget(self):
        for _ in range(MAX_SIGN_IN_ATTEMPTS):
            self.sign_in("wrong-passphrase")
        self.assertEqual(self.sign_in("wrong-passphrase").status_code, 429)

        # Same address, different client: the address budget is exhausted, so
        # this is still refused. The point is that it is refused for the
        # address, not because the second client inherited the first's count.
        other_address = self.sign_in(
            "wrong-passphrase", email="other@example.com", ip="198.51.100.7"
        )
        self.assertEqual(other_address.status_code, 401)

    def test_rejected_client_bucket_does_not_spend_the_address_bucket(self):
        blocked_ip = "203.0.113.21"
        for _ in range(MAX_SIGN_IN_ATTEMPTS_PER_IP):
            throttling.hit(
                "signin:ip",
                blocked_ip,
                limit=MAX_SIGN_IN_ATTEMPTS_PER_IP,
                window=SIGN_IN_WINDOW,
                message="blocked",
            )

        with self.assertRaises(ValueError):
            check_sign_in_allowed("victim@example.com", blocked_ip)

        self.assertFalse(
            AuthThrottle.objects.filter(scope="signin:email").exists()
        )


class ClientIpTests(TestCase):
    def test_x_real_ip_is_preferred_over_remote_addr(self):
        # nginx overwrites X-Real-IP with the true peer for the locations that
        # proxy to Django, so it is the trustworthy one.
        request = type(
            "R",
            (),
            {"META": {"HTTP_X_REAL_IP": "203.0.113.5", "REMOTE_ADDR": "127.0.0.1"}},
        )()
        self.assertEqual(throttling.client_ip(request), "203.0.113.5")

    def test_x_forwarded_for_is_ignored(self):
        # nginx *appends* to it, so its prefix is client-controlled and a
        # caller could otherwise rotate their own throttle key at will.
        request = type(
            "R",
            (),
            {
                "META": {
                    "HTTP_X_FORWARDED_FOR": "1.2.3.4, 203.0.113.5",
                    "REMOTE_ADDR": "127.0.0.1",
                }
            },
        )()
        self.assertEqual(throttling.client_ip(request), "127.0.0.1")

    def test_a_missing_address_still_yields_a_stable_key(self):
        request = type("R", (), {"META": {}})()
        self.assertEqual(throttling.client_ip(request), "unknown")


class ThrottleWindowTests(TestCase):
    def test_the_window_resets_once_it_has_elapsed(self):
        for _ in range(3):
            throttling.hit(
                "test", "subject", limit=3, window=timedelta(minutes=5), message="no"
            )
        with self.assertRaises(throttling.Throttled):
            throttling.hit(
                "test", "subject", limit=3, window=timedelta(minutes=5), message="no"
            )

        AuthThrottle.objects.filter(scope="test").update(
            window_start=timezone.now() - timedelta(minutes=6)
        )
        throttling.hit(
            "test", "subject", limit=3, window=timedelta(minutes=5), message="no"
        )
        self.assertEqual(AuthThrottle.objects.get(scope="test").count, 1)

    def test_keys_are_normalized_so_case_cannot_split_a_budget(self):
        throttling.hit(
            "test", "Chef@Example.com", limit=5, window=CODE_TTL, message="no"
        )
        throttling.hit(
            "test", "chef@example.com", limit=5, window=CODE_TTL, message="no"
        )

        self.assertEqual(AuthThrottle.objects.filter(scope="test").count(), 1)
        self.assertEqual(AuthThrottle.objects.get(scope="test").count, 2)

    def test_sweep_drops_only_long_dead_counters(self):
        throttling.hit("test", "fresh", limit=5, window=CODE_TTL, message="no")
        throttling.hit("test", "stale", limit=5, window=CODE_TTL, message="no")
        AuthThrottle.objects.filter(key=throttling._bucket_key("stale")).update(
            window_start=timezone.now() - timedelta(days=2)
        )

        throttling.sweep()

        remaining = set(AuthThrottle.objects.values_list("key", flat=True))
        self.assertEqual(remaining, {throttling._bucket_key("fresh")})


class EmailNotConfiguredTests(TestCase):
    def test_the_row_is_removed_when_email_is_not_configured_at_all(self):
        def unconfigured(to, code, *, purpose):
            raise EmailNotConfigured("ACS_CONNECTION_STRING is not set")

        with patch("forkluck.verification.send_verification_code", unconfigured):
            with self.assertRaises(EmailNotConfigured):
                issue_code("chef@example.com", EmailVerificationCode.PURPOSE_SIGNUP)

        self.assertFalse(EmailVerificationCode.objects.exists())


class SignedInCookieDomainTests(TestCase):
    """The indicator cookie must reach forkluck.com without leaking wider."""

    def test_a_subdomain_origin_yields_the_parent_domain(self):
        self.assertEqual(
            signed_in_cookie_domain("https://app.forkluck.com"), ".forkluck.com"
        )

    def test_a_bare_domain_stays_host_only(self):
        self.assertIsNone(signed_in_cookie_domain("https://forkluck.com"))

    def test_localhost_stays_host_only(self):
        self.assertIsNone(signed_in_cookie_domain("http://localhost:3000"))

    def test_an_ip_address_stays_host_only(self):
        self.assertIsNone(signed_in_cookie_domain("http://127.0.0.1:3000"))

    def test_an_explicit_override_wins(self):
        with override_settings(FORKLUCK_SIGNED_IN_COOKIE_DOMAIN=".example.test"):
            self.assertEqual(
                settings.FORKLUCK_SIGNED_IN_COOKIE_DOMAIN, ".example.test"
            )


class SignedInCookieTests(TestCase):
    """The marketing site reads this cookie to swap Sign in for Log out."""

    def setUp(self):
        self.user = User.objects.create_user(
            email="chef@example.com",
            name="Chef",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()

    def sign_in(self):
        return self.client.post(
            "/api/auth/login",
            data=json.dumps(
                {
                    "email": "chef@example.com",
                    "password": "a-long-test-passphrase-2468",
                }
            ),
            content_type="application/json",
        )

    def test_signing_in_sets_a_script_readable_indicator(self):
        response = self.sign_in()
        self.assertEqual(response.status_code, 200, response.content)

        cookie = response.cookies["forkluck_signed_in"]
        self.assertEqual(cookie.value, "1")
        self.assertFalse(cookie["httponly"])
        self.assertEqual(cookie["samesite"], "Lax")
        self.assertEqual(cookie["path"], "/")
        self.assertEqual(bool(cookie["secure"]), settings.SESSION_COOKIE_SECURE)
        self.assertEqual(cookie["max-age"], settings.SESSION_COOKIE_AGE)
        self.assertEqual(
            cookie["domain"], settings.FORKLUCK_SIGNED_IN_COOKIE_DOMAIN or ""
        )

    def test_signing_out_clears_it(self):
        self.sign_in()

        response = self.client.post("/api/auth/logout")
        self.assertEqual(response.status_code, 200, response.content)

        cookie = response.cookies["forkluck_signed_in"]
        self.assertEqual(cookie.value, "")
        self.assertEqual(cookie["max-age"], 0)
