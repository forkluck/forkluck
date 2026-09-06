from datetime import timedelta

from django.utils import timezone

from .domains.primo.views import conversation_list
from .models import PrimoConversation, PrimoMessage, User
from .testing import InternalApiTestCase, internal_payload


class PrimoConversationTests(InternalApiTestCase):
    @classmethod
    def setUpTestData(cls) -> None:
        cls.user = User.objects.create_user(
            email="primo@example.com",
            name="Primo Chef",
            password="a-long-test-passphrase-2468",
        )
        cls.other = User.objects.create_user(
            email="other-primo@example.com",
            name="Other Chef",
            password="another-long-passphrase-2468",
        )

    def setUp(self) -> None:
        self.client.force_login(self.user)

    def save(self, conversation_id, messages, **extra):
        return self.post_internal(
            "primo-save-turn",
            {"conversationId": str(conversation_id), "messages": messages, **extra},
        )

    def message(self, message_id="user-1", text="Hello"):
        return {
            "id": message_id,
            "role": "user",
            "parts": [{"type": "text", "text": text}],
            "text": text,
            "status": "complete",
            "metadata": {"mentions": []},
            "parentMessageId": "",
        }

    def test_list_is_scoped_ordered_and_query_count_pinned(self):
        same_time = timezone.now()
        older = PrimoConversation.objects.create(
            user=self.user, title="Older", last_message_at=same_time - timedelta(days=1)
        )
        tied_low = PrimoConversation.objects.create(
            id="00000000-0000-0000-0000-000000000001",
            user=self.user,
            title="Tie low",
            last_message_at=same_time,
        )
        tied_high = PrimoConversation.objects.create(
            id="00000000-0000-0000-0000-000000000002",
            user=self.user,
            title="Tie high",
            last_message_at=same_time,
        )
        PrimoConversation.objects.create(
            user=self.other, title="Private", last_message_at=timezone.now()
        )
        with self.assertNumQueries(
            2,
            msg="The conversation list must stay a count plus one narrow page query.",
        ):
            payload = internal_payload(conversation_list, self.user)
        self.assertEqual(
            [row["id"] for row in payload["items"]],
            [str(tied_high.id), str(tied_low.id), str(older.id)],
        )

    def test_detail_hides_another_users_conversation(self):
        foreign = PrimoConversation.objects.create(user=self.other)
        response = self.get_internal(f"primo/conversations/{foreign.id}/")
        self.assertEqual(response.status_code, 404)

    def test_save_creates_then_upserts_without_duplicate_messages(self):
        conversation = PrimoConversation(user=self.user)
        first = self.save(conversation.id, [self.message()], title="Mooncakes")
        self.assertEqual(first.status_code, 200)
        replay = self.save(
            conversation.id,
            [self.message(text="Updated")],
            title="A replacement title is ignored",
        )
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(PrimoMessage.objects.count(), 1)
        saved = PrimoMessage.objects.get()
        self.assertEqual(saved.text, "Updated")
        self.assertEqual(saved.conversation.title, "Mooncakes")

    def test_exact_save_replay_is_a_no_op(self):
        conversation = PrimoConversation(user=self.user)
        payload = self.message()
        self.save(conversation.id, [payload])
        conversation = PrimoConversation.objects.get(id=conversation.id)
        last_message_at = conversation.last_message_at
        message_updated_at = conversation.messages.get().updated_at
        self.save(conversation.id, [payload])
        conversation.refresh_from_db()
        self.assertEqual(conversation.last_message_at, last_message_at)
        self.assertEqual(conversation.messages.get().updated_at, message_updated_at)

    def test_foreign_id_is_refused(self):
        foreign = PrimoConversation.objects.create(user=self.other)
        response = self.save(foreign.id, [self.message()])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"error": "Conversation not found"})

    def test_archive_preserves_sort_timestamps(self):
        conversation = PrimoConversation.objects.create(
            user=self.user, last_message_at=timezone.now() - timedelta(hours=1)
        )
        updated_at = conversation.updated_at
        last_message_at = conversation.last_message_at
        response = self.post_internal(
            "primo-archive-conversation",
            {"conversationId": str(conversation.id), "archived": True},
        )
        self.assertEqual(response.status_code, 200)
        conversation.refresh_from_db()
        self.assertTrue(conversation.is_archived)
        self.assertEqual(conversation.updated_at, updated_at)
        self.assertEqual(conversation.last_message_at, last_message_at)

    def test_rename_trims_and_caps(self):
        conversation = PrimoConversation.objects.create(user=self.user)
        response = self.post_internal(
            "primo-rename-conversation",
            {"conversationId": str(conversation.id), "title": "  Prep list  "},
        )
        self.assertEqual(response.status_code, 200)
        conversation.refresh_from_db()
        self.assertEqual(conversation.title, "Prep list")
        too_long = self.post_internal(
            "primo-rename-conversation",
            {"conversationId": str(conversation.id), "title": "x" * 201},
        )
        self.assertEqual(too_long.status_code, 400)

    def test_delete_cascades_messages(self):
        conversation = PrimoConversation.objects.create(user=self.user)
        PrimoMessage.objects.create(
            conversation=conversation,
            user=self.user,
            message_id="message-1",
            role="user",
            parts=[],
        )
        response = self.post_internal(
            "primo-delete-conversation", {"conversationId": str(conversation.id)}
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(PrimoConversation.objects.filter(id=conversation.id).exists())
        self.assertFalse(PrimoMessage.objects.exists())

    def test_detail_orders_messages_by_creation_then_id(self):
        conversation = PrimoConversation.objects.create(user=self.user)
        when = timezone.now()
        first = PrimoMessage.objects.create(
            id="00000000-0000-0000-0000-000000000001",
            conversation=conversation,
            user=self.user,
            message_id="first",
            role="user",
            parts=[],
        )
        second = PrimoMessage.objects.create(
            id="00000000-0000-0000-0000-000000000002",
            conversation=conversation,
            user=self.user,
            message_id="second",
            role="assistant",
            parts=[],
        )
        PrimoMessage.objects.filter(id__in=[first.id, second.id]).update(created_at=when)
        response = self.get_internal(f"primo/conversations/{conversation.id}/")
        self.assertEqual(
            [row["id"] for row in response.json()["item"]["messages"]],
            ["first", "second"],
        )

    def attachment(self, conversation_id, **extra):
        from uuid import uuid4
        return self.post_internal("primo-attachment", {
            "operation": "create", "conversationId": str(conversation_id),
            "key": f"{self.user.id}/{uuid4()}.txt", "name": "Recipe.txt",
            "mediaType": "text/plain", "size": 100, "content": "200 g flour", **extra,
        }).json()["item"]

    def test_attachment_binding_is_scoped_and_survives_reload(self):
        conversation = PrimoConversation.objects.create(user=self.user)
        attachment = self.attachment(conversation.id)
        message = self.message("user-file", "Read this")
        message["metadata"] = {"attachmentIds": [attachment["id"]]}
        self.assertEqual(self.save(conversation.id, [message]).status_code, 200)
        payload = self.get_internal(f"primo/conversations/{conversation.id}/").json()
        self.assertEqual(payload["item"]["messages"][0]["metadata"]["attachments"], [attachment])
        # Retrying the same turn is idempotent; reusing the file in a different
        # message is rejected rather than silently transferring ownership.
        self.assertEqual(self.save(conversation.id, [message]).status_code, 200)
        message["id"] = "different-message"
        self.assertEqual(self.save(conversation.id, [message]).status_code, 400)
        self.assertEqual(PrimoMessage.objects.filter(conversation=conversation).count(), 1)
        self.client.force_login(self.other)
        self.assertEqual(self.post_internal("primo-attachment", {"operation": "read", "id": attachment["id"], "conversationId": str(conversation.id)}).status_code, 400)

    def test_unprepared_expired_removed_and_foreign_files_cannot_send(self):
        from .models import PrimoAttachment
        for state in ("preparing", "expired", "deleted", "foreign", "other-conversation"):
            with self.subTest(state=state):
                conversation = PrimoConversation.objects.create(user=self.user)
                attachment = self.attachment(conversation.id)
                row = PrimoAttachment.objects.get(id=attachment["id"])
                if state == "preparing":
                    row.content = ""
                elif state == "expired":
                    row.expires_at = timezone.now() - timedelta(seconds=1)
                elif state == "deleted":
                    row.deleted = True
                elif state == "foreign":
                    row.user = self.other
                else:
                    row.conversation_id = PrimoConversation.objects.create(user=self.user).id
                row.save()
                message = self.message("user-file", "Read this")
                message["metadata"] = {"attachmentIds": [attachment["id"]]}
                self.assertEqual(self.save(conversation.id, [message]).status_code, 400)
                self.assertFalse(PrimoMessage.objects.filter(conversation=conversation).exists())

    def test_delete_revokes_files_and_cleanup_is_acknowledged_separately(self):
        from .models import PrimoAttachment
        conversation = PrimoConversation.objects.create(user=self.user)
        attachment = self.attachment(conversation.id)
        self.post_internal("primo-delete-conversation", {"conversationId": str(conversation.id)})
        self.assertEqual(self.post_internal("primo-attachment", {"operation": "read", "id": attachment["id"], "conversationId": str(conversation.id)}).status_code, 400)
        for _ in range(2):
            cleanup = self.post_internal("primo-attachment", {"operation": "cleanup"}).json()
            self.assertEqual(cleanup["items"][0]["id"], attachment["id"])
        self.post_internal("primo-attachment", {"operation": "ack-delete", "id": attachment["id"]})
        self.assertFalse(PrimoAttachment.objects.filter(id=attachment["id"]).exists())

    def test_feedback_is_owned_and_not_overwritten_by_transcript_updates(self):
        conversation = PrimoConversation.objects.create(user=self.user)
        message = {**self.message("assistant-feedback", "A response"), "role": "assistant"}
        self.save(conversation.id, [message])
        payload = {"conversationId": str(conversation.id), "messageId": message["id"], "rating": "down", "comment": "Needs sources"}
        self.assertEqual(self.post_internal("primo-feedback", payload).status_code, 200)
        self.save(conversation.id, [message])
        row = PrimoMessage.objects.get(conversation=conversation)
        self.assertEqual((row.feedback, row.feedback_comment), ("down", "Needs sources"))
        self.client.force_login(self.other)
        self.assertEqual(self.post_internal("primo-feedback", payload).status_code, 400)
        self.client.force_login(self.user)
        self.post_internal("primo-feedback", {**payload, "rating": ""})
        row.refresh_from_db()
        self.assertEqual((row.feedback, row.feedback_comment), ("", ""))

    def test_upload_to_foreign_conversation_is_rejected(self):
        from uuid import uuid4
        conversation = PrimoConversation.objects.create(user=self.other)
        response = self.post_internal("primo-attachment", {"operation": "create", "conversationId": str(conversation.id), "key": f"{self.user.id}/{uuid4()}.txt", "name": "Recipe.txt", "mediaType": "text/plain", "size": 100})
        self.assertEqual(response.status_code, 400)

    def test_attachment_manifest_is_batched_ordered_and_contains_no_content_or_keys(self):
        from .domains.primo.actions import action_primo_attachment
        conversation = PrimoConversation.objects.create(user=self.user)
        files = [self.attachment(conversation.id) for _ in range(5)]
        ids = [row["id"] for row in reversed(files)]
        # The action's atomic wrapper creates one savepoint around one narrow read.
        with self.assertNumQueries(3, msg="The source manifest must use one query regardless of file count, plus its transaction savepoint."):
            result = action_primo_attachment(self.user, {
                "operation": "manifest", "conversationId": str(conversation.id), "ids": ids + ids,
            })
        self.assertEqual(result["items"], list(reversed(files)))
        self.assertNotIn("content", str(result))
        self.assertNotIn("key", str(result))

    def test_attachment_manifest_refuses_every_unavailable_state(self):
        from .models import PrimoAttachment
        for state in ("preparing", "expired", "deleted", "foreign", "other-conversation"):
            with self.subTest(state=state):
                conversation = PrimoConversation.objects.create(user=self.user)
                attachment = self.attachment(conversation.id)
                row = PrimoAttachment.objects.get(id=attachment["id"])
                if state == "preparing":
                    row.content = ""
                elif state == "expired":
                    row.expires_at = timezone.now() - timedelta(seconds=1)
                elif state == "deleted":
                    row.deleted = True
                elif state == "foreign":
                    row.user = self.other
                else:
                    row.conversation_id = PrimoConversation.objects.create(user=self.user).id
                row.save()
                response = self.post_internal("primo-attachment", {
                    "operation": "manifest", "conversationId": str(conversation.id), "ids": [attachment["id"]],
                })
                self.assertEqual(response.status_code, 400)

    def test_manifest_sent_file_survives_expiry_but_not_conversation_deletion(self):
        from .models import PrimoAttachment
        conversation = PrimoConversation.objects.create(user=self.user)
        attachment = self.attachment(conversation.id)
        message = self.message("user-file", "Read this")
        message["metadata"] = {"attachmentIds": [attachment["id"]]}
        self.save(conversation.id, [message])
        PrimoAttachment.objects.filter(id=attachment["id"]).update(expires_at=timezone.now() - timedelta(days=1))
        payload = {"operation": "manifest", "conversationId": str(conversation.id), "ids": [attachment["id"]]}
        self.assertEqual(self.post_internal("primo-attachment", payload).status_code, 200)
        self.post_internal("primo-delete-conversation", {"conversationId": str(conversation.id)})
        self.assertEqual(self.post_internal("primo-attachment", payload).status_code, 400)
