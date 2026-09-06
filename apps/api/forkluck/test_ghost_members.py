"""Ghost newsletter sync: token shape, upsert/remove, and friendly failure."""

import base64
import json
import time
import urllib.error
from unittest import mock

from django.test import SimpleTestCase, override_settings

from .integrations.ghost_members import (
    _new_member,
    newsletter_status,
    remove_member,
    set_newsletter,
    upsert_member,
)

SECRET = "ab" * 32
CONFIGURED = override_settings(
    GHOST_ADMIN_URL="https://forkluck.com",
    GHOST_ADMIN_API_KEY=f"64f0a1b2c3d4e5f6a7b8c9d0:{SECRET}",
)


def _response(payload):
    body = b"" if payload is None else json.dumps(payload).encode()
    handle = mock.MagicMock()
    handle.read.return_value = body
    handle.__enter__.return_value = handle
    return handle


def _sent(urlopen):
    """The urllib Request objects passed to urlopen, in order."""
    return [call.args[0] for call in urlopen.call_args_list]


def _body(request):
    return json.loads(request.data.decode())


def _segment(token, index):
    part = token.split(".")[index]
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))


@CONFIGURED
class GhostTokenTests(SimpleTestCase):
    @mock.patch("urllib.request.urlopen")
    def test_admin_token_carries_kid_audience_and_five_minute_expiry(self, urlopen):
        urlopen.return_value = _response({"members": []})
        before = int(time.time())

        upsert_member("chef@example.com")

        request = _sent(urlopen)[0]
        scheme, token = request.headers["Authorization"].split(" ", 1)
        self.assertEqual(scheme, "Ghost")
        header = _segment(token, 0)
        payload = _segment(token, 1)
        self.assertEqual(header["alg"], "HS256")
        self.assertEqual(header["typ"], "JWT")
        self.assertEqual(header["kid"], "64f0a1b2c3d4e5f6a7b8c9d0")
        self.assertEqual(payload["aud"], "/admin/")
        self.assertEqual(payload["exp"] - payload["iat"], 300)
        self.assertGreaterEqual(payload["iat"], before)
        self.assertEqual(request.headers["Accept-version"], "v5.0")


@CONFIGURED
class UpsertMemberTests(SimpleTestCase):
    @mock.patch("urllib.request.urlopen")
    def test_creates_a_subscribed_member_when_none_matches(self, urlopen):
        urlopen.side_effect = [
            _response({"members": []}),
            _response({"members": [{"id": "1"}]}),
        ]

        self.assertIs(upsert_member("chef@example.com", "Chef Ana"), True)

        find, create = _sent(urlopen)
        self.assertEqual(find.get_method(), "GET")
        self.assertIn("email%3A%27chef%40example.com%27", find.full_url)
        self.assertIn("limit=1", find.full_url)
        self.assertEqual(create.get_method(), "POST")
        self.assertEqual(
            _body(create)["members"][0],
            {
                "email": "chef@example.com",
                "name": "Chef Ana",
                "labels": [{"name": "customer"}],
                "subscribed": True,
            },
        )

    @mock.patch("urllib.request.urlopen")
    def test_adds_the_label_to_an_existing_member_without_touching_newsletters(
        self, urlopen
    ):
        urlopen.side_effect = [
            _response({"members": [{"id": "m1", "labels": [{"name": "beta"}]}]}),
            _response({"members": [{"id": "m1"}]}),
        ]

        self.assertIs(upsert_member("chef@example.com", "Chef Ana"), True)

        update = _sent(urlopen)[1]
        self.assertEqual(update.get_method(), "PUT")
        self.assertTrue(update.full_url.endswith("/members/m1/"))
        member = _body(update)["members"][0]
        self.assertEqual(member["labels"], [{"name": "beta"}, {"name": "customer"}])
        # Subscription state belongs to Ghost: never re-subscribe by accident.
        self.assertNotIn("newsletters", member)
        self.assertNotIn("subscribed", member)
        self.assertNotIn("email", member)

    @mock.patch("urllib.request.urlopen")
    def test_an_already_labelled_member_needs_no_write(self, urlopen):
        urlopen.return_value = _response(
            {"members": [{"id": "m1", "labels": [{"name": "customer"}]}]}
        )

        self.assertIs(upsert_member("chef@example.com"), True)

        self.assertEqual(len(_sent(urlopen)), 1)

    @mock.patch("urllib.request.urlopen")
    def test_a_network_error_returns_false_without_raising(self, urlopen):
        urlopen.side_effect = urllib.error.URLError("no route")

        with self.assertLogs("forkluck.integrations.ghost_members", "ERROR"):
            self.assertIs(upsert_member("chef@example.com"), False)


@CONFIGURED
class RemoveMemberTests(SimpleTestCase):
    @mock.patch("urllib.request.urlopen")
    def test_deletes_the_matching_member(self, urlopen):
        urlopen.side_effect = [
            _response({"members": [{"id": "m1"}]}),
            _response(None),
        ]

        self.assertIs(remove_member("chef@example.com"), True)

        delete = _sent(urlopen)[1]
        self.assertEqual(delete.get_method(), "DELETE")
        self.assertTrue(delete.full_url.endswith("/members/m1/"))

    @mock.patch("urllib.request.urlopen")
    def test_an_unknown_address_is_not_an_error(self, urlopen):
        urlopen.return_value = _response({"members": []})

        self.assertIs(remove_member("nobody@example.com"), False)
        self.assertEqual(len(_sent(urlopen)), 1)


@CONFIGURED
class NewsletterStatusTests(SimpleTestCase):
    @mock.patch("urllib.request.urlopen")
    def test_a_member_on_a_newsletter_is_subscribed(self, urlopen):
        urlopen.return_value = _response(
            {"members": [{"id": "m1", "newsletters": [{"id": "n1"}]}]}
        )

        self.assertIs(newsletter_status("chef@example.com"), True)

    @mock.patch("urllib.request.urlopen")
    def test_a_member_on_no_newsletter_is_not_subscribed(self, urlopen):
        urlopen.return_value = _response({"members": [{"id": "m1", "newsletters": []}]})

        self.assertIs(newsletter_status("chef@example.com"), False)

    @mock.patch("urllib.request.urlopen")
    def test_an_unknown_address_has_no_answer(self, urlopen):
        urlopen.return_value = _response({"members": []})

        self.assertIsNone(newsletter_status("nobody@example.com"))


@CONFIGURED
class SetNewsletterTests(SimpleTestCase):
    @mock.patch("urllib.request.urlopen")
    def test_enabling_creates_the_member_then_puts_every_active_newsletter(
        self, urlopen
    ):
        urlopen.side_effect = [
            _response({"members": []}),
            _response({"members": [{"id": "m1"}]}),
            _response({"newsletters": [{"id": "n1"}, {"id": "n2"}]}),
            _response({"members": [{"id": "m1"}]}),
        ]

        self.assertIs(set_newsletter("chef@example.com", True, "Chef Ana"), True)

        find, create, newsletters, update = _sent(urlopen)
        self.assertEqual(find.get_method(), "GET")
        self.assertEqual(create.get_method(), "POST")
        self.assertIn("filter=status%3Aactive", newsletters.full_url)
        self.assertIn("limit=all", newsletters.full_url)
        self.assertEqual(update.get_method(), "PUT")
        self.assertTrue(update.full_url.endswith("/members/m1/"))
        self.assertEqual(
            _body(update)["members"][0],
            {"newsletters": [{"id": "n1"}, {"id": "n2"}]},
        )

    @mock.patch("urllib.request.urlopen")
    def test_disabling_puts_an_empty_newsletter_list(self, urlopen):
        urlopen.side_effect = [
            _response({"members": [{"id": "m1", "newsletters": [{"id": "n1"}]}]}),
            _response({"members": [{"id": "m1"}]}),
        ]

        self.assertIs(set_newsletter("chef@example.com", False), True)

        find, update = _sent(urlopen)
        self.assertEqual(find.get_method(), "GET")
        self.assertEqual(update.get_method(), "PUT")
        self.assertEqual(_body(update)["members"][0], {"newsletters": []})

    @mock.patch("urllib.request.urlopen")
    def test_disabling_an_unknown_address_writes_nothing(self, urlopen):
        urlopen.return_value = _response({"members": []})

        self.assertIs(set_newsletter("nobody@example.com", False), True)
        self.assertEqual(len(_sent(urlopen)), 1)


@override_settings(GHOST_ADMIN_URL="", GHOST_ADMIN_API_KEY="")
class UnconfiguredTests(SimpleTestCase):
    @mock.patch("urllib.request.urlopen")
    def test_every_function_is_a_silent_no_op(self, urlopen):
        self.assertIs(upsert_member("chef@example.com"), False)
        self.assertIs(remove_member("chef@example.com"), False)
        self.assertIsNone(newsletter_status("chef@example.com"))
        self.assertIs(set_newsletter("chef@example.com", True), False)
        urlopen.assert_not_called()


@CONFIGURED
class MemberPayloadTests(SimpleTestCase):
    def test_an_unknown_name_is_omitted_rather_than_sent_as_null(self):
        self.assertNotIn("name", _new_member("a@b.co", None, "subscriber"))
        self.assertEqual(_new_member("a@b.co", "Ana", "customer")["name"], "Ana")
