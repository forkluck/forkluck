from io import BytesIO
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs

from django.test import SimpleTestCase, override_settings

from .integrations import emails


@override_settings(
    FORKLUCK_MAIL_BRIDGE_URL="http://127.0.0.1:3003/v3/example.test/messages",
    FORKLUCK_MAIL_BRIDGE_API_KEY="synthetic-bridge-key",
    FORKLUCK_EMAIL_FROM="sender@example.test",
    ACS_CONNECTION_STRING="synthetic-unused-acs-connection",
)
class EmailRoutingTests(SimpleTestCase):
    def response(self, body=b'{"id":"synthetic-message-id"}'):
        response = MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.read.side_effect = BytesIO(body).read
        return response

    def test_bridge_takes_precedence_and_preserves_plain_text(self):
        with patch.object(emails, "urlopen", return_value=self.response()) as send, \
             patch.object(emails.EmailClient, "from_connection_string") as acs:
            emails.send_email("recipient@example.test", "Café & recipes", "A private link\nhttps://example.test/a?k=synthetic")
        request = send.call_args.args[0]
        self.assertEqual(send.call_args.kwargs["timeout"], 10)
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.full_url, "http://127.0.0.1:3003/v3/example.test/messages")
        self.assertTrue(request.get_header("Authorization").startswith("Basic "))
        self.assertEqual(parse_qs(request.data.decode()), {
            "from": ["sender@example.test"], "to": ["recipient@example.test"],
            "subject": ["Café & recipes"], "text": ["A private link\nhttps://example.test/a?k=synthetic"],
            "o:tag": ["source:forkluck-app"],
        })
        acs.assert_not_called()

    def test_failed_or_ambiguous_delivery_does_not_send_a_duplicate_via_acs(self):
        failures = [
            URLError("private failure details"), TimeoutError("private timeout"),
            *[HTTPError("http://127.0.0.1/", code, "private response", {}, None) for code in (400, 401, 429, 500)],
        ]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__), \
                 patch.object(emails, "urlopen", side_effect=failure), \
                 patch.object(emails.EmailClient, "from_connection_string") as acs:
                with self.assertRaisesMessage(ValueError, "The verification email could not be sent"):
                    emails.send_verification_code("recipient@example.test", "123456", purpose="signup")
                acs.assert_not_called()
        for body in (b"not json", b"{}", b"[]", b'{"id":""}'):
            with self.subTest(body=body), patch.object(emails, "urlopen", return_value=self.response(body)):
                with self.assertRaisesMessage(ValueError, "The verification email could not be sent"):
                    emails.send_email("recipient@example.test", "Subject", "Body")

    @override_settings(FORKLUCK_MAIL_BRIDGE_URL="", FORKLUCK_MAIL_BRIDGE_API_KEY="")
    def test_existing_direct_acs_installations_keep_working(self):
        client = MagicMock()
        with patch.object(emails, "_client", client), patch.object(emails, "urlopen") as bridge:
            emails.send_email("recipient@example.test", "Subject", "Body")
        client.begin_send.assert_called_once()
        bridge.assert_not_called()

    @override_settings(FORKLUCK_MAIL_BRIDGE_URL="", FORKLUCK_MAIL_BRIDGE_API_KEY="", ACS_CONNECTION_STRING="")
    def test_unconfigured_installations_never_send(self):
        with self.assertRaises(emails.EmailNotConfigured):
            emails.send_email("recipient@example.test", "Subject", "Body")
