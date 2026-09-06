from copy import deepcopy
from uuid import uuid4

from django.contrib import admin
from django.test import override_settings

from .admin import ReceiptFeedbackAdmin
from .domains.invoices.actions import action_save_receipt_feedback
from .domains.workspace.actions import action_delete_kitchen_data
from .models import Ingredient, Invoice, ReceiptFeedback, User
from .testing import InternalApiTestCase


class ReceiptFeedbackTests(InternalApiTestCase):
    def setUp(self):
        self.user = User.objects.create_user(email="receipt-feedback@example.com")
        self.client.force_login(self.user)
        self.body = {
            "id": str(uuid4()),
            "rating": "down",
            "note": "The quantity belonged to the following item.",
            "fileName": "sample-receipt.pdf",
            "supplierName": "Example Market",
            "model": "sample-reader",
            "extraction": {"lines": [{"description": "PEARS", "quantity": "4"}]},
            "original": {"Lines": [{"Item": "PEARS", "Quantity": "4"}]},
            "corrected": {"Lines": [{"Item": "PEARS", "Quantity": ""}]},
        }

    def send(self, **changes):
        return self.post_internal("save-receipt-feedback", {**self.body, **changes})

    def test_both_ratings_and_legacy_reads_work_without_importing(self):
        for rating in ("up", "down"):
            response = self.send(id=str(uuid4()), rating=rating, note="", extraction=None)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {"ok": True})
        self.assertEqual(ReceiptFeedback.objects.count(), 2)
        self.assertFalse(Invoice.objects.exists())
        self.assertFalse(Ingredient.objects.exists())

    def test_original_read_and_draft_text_survive_updates_and_retries(self):
        self.assertEqual(self.send().status_code, 200)
        row = ReceiptFeedback.objects.get()
        row.reviewed = True
        row.save(update_fields=["reviewed"])
        self.send()
        row.refresh_from_db()
        self.assertTrue(row.reviewed)
        self.send(
            rating="up", note="Fixed now", original={"tampered": True},
            extraction={"tampered": True}, corrected={"Quantity": "1."},
        )
        row.refresh_from_db()
        self.assertEqual(ReceiptFeedback.objects.count(), 1)
        self.assertEqual(row.original, self.body["original"])
        self.assertEqual(row.extraction, self.body["extraction"])
        self.assertEqual(row.corrected, {"Quantity": "1."})
        self.assertEqual(row.rating, "up")
        self.assertFalse(row.reviewed)

    def test_submission_id_and_body_owner_cannot_modify_another_users_feedback(self):
        self.send()
        other = User.objects.create_user(email="other-feedback@example.com")
        self.client.force_login(other)
        self.send(userId=str(self.user.id), rating="up")
        self.assertEqual(ReceiptFeedback.objects.get(user=self.user).rating, "down")
        self.assertEqual(ReceiptFeedback.objects.get(user=other).rating, "up")

    def test_invalid_reports_are_atomic(self):
        cases = (
            {"id": "not-a-uuid"}, {"rating": "bad"}, {"note": "x" * 2001},
            {"fileName": ""}, {"model": ""}, {"original": None},
            {"corrected": []}, {"extraction": []},
            *({field: {"huge": "x" * 65536}} for field in ("original", "corrected", "extraction")),
        )
        for invalid in cases:
            with self.subTest(invalid=list(invalid)):
                self.assertEqual(self.send(**invalid).status_code, 400)
                self.assertFalse(ReceiptFeedback.objects.exists())

    def test_authentication_and_internal_secret_are_required(self):
        self.client.logout()
        self.assertEqual(self.send().status_code, 401)
        response = self.client.post(
            "/internal/v1/actions/save-receipt-feedback/", self.body, content_type="application/json"
        )
        self.assertEqual(response.status_code, 404)
        self.assertFalse(ReceiptFeedback.objects.exists())

    def test_account_and_kitchen_deletion_remove_private_snapshots(self):
        self.send()
        action_delete_kitchen_data(self.user, {})
        self.assertFalse(ReceiptFeedback.objects.exists())
        action_save_receipt_feedback(self.user, self.body)
        self.user.delete()
        self.assertFalse(ReceiptFeedback.objects.exists())

    def test_staff_comparison_names_changes_and_escapes_user_text(self):
        self.send()
        row = ReceiptFeedback.objects.get()
        viewer = ReceiptFeedbackAdmin(ReceiptFeedback, admin.site)
        markup = str(viewer.changes(row))
        self.assertIn("Lines 1 / Quantity", markup)
        self.assertIn("At submission", markup)
        row.corrected = {"<script>Field</script>": "<img src=x onerror=alert(1)>"}
        markup = str(viewer.changes(row))
        self.assertNotIn("<script>", markup)
        self.assertNotIn("<img", markup)
        row.corrected = deepcopy(row.original)
        self.assertIn("No edits", viewer.changes(row))

    @override_settings(FORKLUCK_ADMIN_CODE_LOGIN=True)
    def test_feedback_console_requires_existing_admin_gate(self):
        self.send()
        row = ReceiptFeedback.objects.get()
        for path in ("/mommy/forkluck/receiptfeedback/", f"/mommy/forkluck/receiptfeedback/{row.pk}/change/"):
            self.assertEqual(self.client.get(path).status_code, 302)
