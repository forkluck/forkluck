from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, override_settings

from .integrations import emails


@override_settings(FORKLUCK_EMAIL_FROM="sender@example.test", ACS_CONNECTION_STRING="synthetic-acs-connection")
class EmailDeliveryTests(SimpleTestCase):
    def test_sends_through_acs(self):
        client = MagicMock()
        with patch.object(emails, "_client", client):
            emails.send_email("recipient@example.test", "Subject", "Body")
        client.begin_send.assert_called_once()

    @override_settings(ACS_CONNECTION_STRING="")
    def test_unconfigured_installations_never_send(self):
        with self.assertRaises(emails.EmailNotConfigured):
            emails.send_email("recipient@example.test", "Subject", "Body")
