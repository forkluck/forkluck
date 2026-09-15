from typing import Any
from datetime import timedelta
from django.db.models import Q

from django.db import transaction
from django.utils import timezone

from ...models import PrimoAttachment, PrimoConversation, PrimoMessage, User
from ..shared.values import bool_value, text_value, uuid_value
from .serializers import attachment_json, conversation_json

JsonObject = dict[str, Any]


def _conversation(user: User, value: Any) -> PrimoConversation:
    conversation = PrimoConversation.objects.filter(
        id=uuid_value(value, "conversationId"), user=user
    ).first()
    if conversation is None:
        raise ValueError("Conversation not found")
    return conversation


def _json_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{label} must be a list")
    return value


def _json_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


@transaction.atomic
def action_primo_save_turn(user: User, payload: JsonObject) -> JsonObject:
    conversation_id = uuid_value(payload.get("conversationId"), "conversationId")
    foreign = PrimoConversation.objects.filter(id=conversation_id).exclude(user=user)
    if foreign.exists():
        raise ValueError("Conversation not found")
    reply_to = payload.get("replyTo")
    if reply_to is not None:
        conversation = (
            PrimoConversation.objects.select_for_update()
            .filter(id=conversation_id, user=user)
            .first()
        )
        if conversation is None:
            # A late stream must not recreate a deleted conversation.
            return {"superseded": True}
        conversation_created = False
    else:
        conversation, conversation_created = PrimoConversation.objects.get_or_create(
            id=conversation_id, defaults={"user": user}
        )
        if conversation.user_id != user.id:
            raise ValueError("Conversation not found")
        conversation = PrimoConversation.objects.select_for_update().get(
            id=conversation.id, user=user
        )
    raw_messages = _json_list(payload.get("messages"), "messages")
    if not raw_messages:
        raise ValueError("messages is required")
    if len(raw_messages) > 200:
        raise ValueError("messages is too long")
    raw_messages = [_json_object(raw, "message") for raw in raw_messages]
    generation_id = payload.get("generationId")
    if generation_id is not None:
        generation_id = str(uuid_value(generation_id, "generationId"))
        if len(raw_messages) != 1 or raw_messages[0].get("role") != "user":
            raise ValueError("A generation requires one user message")
    if reply_to is not None:
        reply_to = _json_object(reply_to, "replyTo")
        if (
            len(raw_messages) != 1
            or raw_messages[0].get("role") != "assistant"
            or raw_messages[0].get("parentMessageId") != reply_to.get("messageId")
        ):
            raise ValueError("A response requires its user message")
        parent = (
            conversation.messages.filter(user=user, role="user")
            .order_by("-created_at", "-id")
            .first()
        )
        if (
            parent is None
            or parent.message_id != reply_to.get("messageId")
            or not reply_to.get("generationId")
            or parent.metadata.get("_generationId") != reply_to["generationId"]
        ):
            return {"superseded": True}
    edit = payload.get("edit")
    if edit is not None:
        edit = _json_object(edit, "edit")
        if generation_id is None or raw_messages[0].get("id") != edit.get("messageId"):
            raise ValueError("Invalid message edit")
        target = conversation.messages.filter(
            user=user, message_id=edit.get("messageId"), role="user"
        ).first()
        latest = conversation.messages.order_by("-created_at", "-id").first()
        if (
            target is None
            or latest is None
            or latest.message_id != edit.get("expectedLastMessageId")
            or target.text != edit.get("expectedText")
        ):
            raise ValueError("Conversation changed; reload before editing")
        following = conversation.messages.filter(
            Q(created_at__gt=target.created_at)
            | Q(created_at=target.created_at, id__gt=target.id)
        )
        PrimoAttachment.objects.filter(user=user, message__in=following).update(
            deleted=True
        )
        following.delete()
        raw_messages[0] = {
            **raw_messages[0],
            "parentMessageId": target.parent_message_id,
        }
    changed = conversation_created
    for raw in raw_messages:
        message = _json_object(raw, "message")
        message_id = text_value(message.get("id"), "message id", max_length=64)
        role = text_value(message.get("role"), "role", max_length=16)
        if role not in {"user", "assistant"}:
            raise ValueError("role is invalid")
        status = text_value(message.get("status", "complete"), "status", max_length=16)
        if status not in {"complete", "aborted", "error"}:
            raise ValueError("status is invalid")
        parts = _json_list(message.get("parts"), "parts")
        metadata = _json_object(message.get("metadata", {}), "metadata")
        defaults = {
            "user_id": user.id,
            "parent_message_id": text_value(
                message.get("parentMessageId", ""),
                "parentMessageId",
                max_length=64,
                allow_blank=True,
            ),
            "role": role,
            "parts": parts,
            "text": text_value(
                message.get("text", ""), "text", max_length=100_000, allow_blank=True
            ),
            "status": status,
            "metadata": metadata,
        }
        attachment_ids = metadata.get("attachmentIds", []) if role == "user" else []
        if not isinstance(attachment_ids, list) or len(attachment_ids) > 5:
            raise ValueError("Invalid attachments")
        ids = [uuid_value(value, "attachmentId") for value in attachment_ids]
        attachments = list(
            PrimoAttachment.objects.select_for_update().filter(
                id__in=ids,
                user=user,
                conversation_id=conversation.id,
                deleted=False,
            )
        )
        if (
            len(attachments) != len(ids)
            or sum(row.size for row in attachments) > 20_000_000
        ):
            raise ValueError("Invalid attachments")
        for attachment in attachments:
            if not attachment.content:
                raise ValueError("Attachment is still preparing")
            if attachment.message_id and attachment.message.message_id != message_id:
                raise ValueError("Attachment already sent")
            if not attachment.message_id and attachment.expires_at <= timezone.now():
                raise ValueError("Attachment expired; attach it again")
        if role == "user" and generation_id is not None:
            metadata = {**metadata, "_generationId": generation_id}
        if role == "user":
            metadata = {
                **metadata,
                "attachments": [attachment_json(row) for row in attachments],
            }
            defaults["metadata"] = metadata
        existing = PrimoMessage.objects.filter(
            conversation=conversation, message_id=message_id
        ).first()
        if (
            existing is not None
            and generation_id is not None
            and edit is None
            and existing.text != defaults["text"]
        ):
            raise ValueError("Conversation changed; reload before editing")
        if existing is None:
            existing = PrimoMessage.objects.create(
                conversation=conversation, message_id=message_id, **defaults
            )
            changed = True
        elif any(getattr(existing, key) != value for key, value in defaults.items()):
            for key, value in defaults.items():
                setattr(existing, key, value)
            existing.save(update_fields=[*defaults, "updated_at"])
            changed = True

        if attachments:
            PrimoAttachment.objects.filter(id__in=ids, user=user).update(
                message=existing
            )

    title = payload.get("title")
    updates: dict[str, Any] = {}
    if title is not None and not conversation.title:
        updates["title"] = text_value(title, "title", max_length=200)
        changed = True
    if changed:
        updates["last_message_at"] = timezone.now()
        PrimoConversation.objects.filter(id=conversation.id, user=user).update(
            **updates
        )
        conversation.refresh_from_db()
    last_user = next(
        (raw for raw in reversed(raw_messages) if raw.get("role") == "user"), None
    )
    response_id = None
    if last_user:
        response_id = (
            PrimoMessage.objects.filter(
                conversation=conversation,
                user=user,
                role="assistant",
                parent_message_id=last_user["id"],
            )
            .values_list("message_id", flat=True)
            .first()
        )
    return {"item": conversation_json(conversation), "responseMessageId": response_id}


def action_primo_rename_conversation(user: User, payload: JsonObject) -> JsonObject:
    conversation = _conversation(user, payload.get("conversationId"))
    conversation.title = text_value(payload.get("title"), "title", max_length=200)
    conversation.save(update_fields=["title", "updated_at"])
    return {"item": conversation_json(conversation)}


def action_primo_archive_conversation(user: User, payload: JsonObject) -> JsonObject:
    conversation = _conversation(user, payload.get("conversationId"))
    archived = bool_value(payload.get("archived"), "archived")
    archived_at = timezone.now() if archived else None
    PrimoConversation.objects.filter(id=conversation.id, user=user).update(
        is_archived=archived, archived_at=archived_at
    )
    conversation.is_archived = archived
    conversation.archived_at = archived_at
    return {"item": conversation_json(conversation)}


@transaction.atomic
def action_primo_delete_conversation(user: User, payload: JsonObject) -> JsonObject:
    conversation = _conversation(user, payload.get("conversationId"))
    conversation = PrimoConversation.objects.select_for_update().get(id=conversation.id, user=user)
    PrimoAttachment.objects.filter(user=user, conversation_id=conversation.id).update(deleted=True)
    conversation.delete()
    return {"ok": True}


def action_primo_feedback(user: User, payload: JsonObject) -> JsonObject:
    conversation = _conversation(user, payload.get("conversationId"))
    message = PrimoMessage.objects.filter(conversation=conversation, user=user,
        message_id=payload.get("messageId"), role="assistant").first()
    if message is None:
        raise ValueError("Response not found")
    rating = payload.get("rating", "")
    if rating not in {"", "up", "down"}:
        raise ValueError("Invalid feedback")
    comment = text_value(payload.get("comment", ""), "comment", max_length=2000, allow_blank=True)
    message.feedback = rating
    message.feedback_comment = comment if rating == "down" else ""
    message.save(update_fields=["feedback", "feedback_comment", "updated_at"])
    return {"ok": True}


@transaction.atomic
def action_primo_attachment(user: User, payload: JsonObject) -> JsonObject:
    operation = payload.get("operation")
    if operation == "manifest":
        conversation_id = uuid_value(payload.get("conversationId"), "conversationId")
        raw_ids = _json_list(payload.get("ids"), "ids")
        if len(raw_ids) > 1000:
            raise ValueError("Too many attachments")
        ids = list(dict.fromkeys(uuid_value(value, "attachmentId") for value in raw_ids))
        rows = list(PrimoAttachment.objects.filter(
            id__in=ids, user=user, conversation_id=conversation_id, deleted=False,
        ).filter(Q(message__isnull=False) | Q(expires_at__gt=timezone.now())).exclude(content="").defer("content"))
        if len(rows) != len(ids):
            raise ValueError("Attachment unavailable")
        by_id = {row.id: row for row in rows}
        return {"items": [attachment_json(by_id[value]) for value in ids]}
    if operation == "create":
        conversation_id = uuid_value(payload.get("conversationId"), "conversationId")
        if PrimoConversation.objects.filter(id=conversation_id).exclude(user=user).exists():
            raise ValueError("Conversation not found")
        User.objects.select_for_update().get(pk=user.pk)
        if PrimoAttachment.objects.filter(user=user, created_at__gte=timezone.now() - timedelta(hours=1)).count() >= 30:
            raise ValueError("Too many files. Try again later.")
        key = text_value(payload.get("key"), "key", max_length=150)
        if not key.startswith(f"{user.id}/"):
            raise ValueError("Invalid file")
        size = payload.get("size")
        if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= 8_000_000:
            raise ValueError("Invalid size")
        row = PrimoAttachment.objects.create(user=user, conversation_id=conversation_id,
            document_key=key, name=text_value(payload.get("name"), "name", max_length=255),
            media_type=text_value(payload.get("mediaType"), "mediaType", max_length=100), size=size,
            content=text_value(payload.get("content", ""), "content", max_length=24000, allow_blank=True),
            coverage=text_value(payload.get("coverage", ""), "coverage", max_length=255, allow_blank=True),
            expires_at=timezone.now() + timedelta(days=7))
        return {"item": attachment_json(row)}
    if operation == "cleanup":
        rows = PrimoAttachment.objects.filter(Q(user=user) | Q(user__isnull=True)).filter(
            Q(user__isnull=True) | Q(deleted=True) | Q(message__isnull=True, expires_at__lte=timezone.now()))[:30]
        return {"items": [{"id": str(row.id), "key": row.document_key} for row in rows]}
    rows = PrimoAttachment.objects.filter(Q(user=user) | (Q(user__isnull=True) if operation == "ack-delete" else Q(user=user)))
    row = rows.filter(id=uuid_value(payload.get("id"), "id")).first()
    if row is None:
        raise ValueError("Attachment not found")
    if operation == "ack-delete":
        if row.user_id is None or row.deleted or (row.message_id is None and row.expires_at <= timezone.now()):
            row.delete()
        return {"ok": True}
    if operation == "finish":
        if row.message_id or row.deleted:
            raise ValueError("Attachment unavailable")
        row.content = text_value(payload.get("content"), "content", max_length=24000)
        row.coverage = text_value(payload.get("coverage", ""), "coverage", max_length=255, allow_blank=True)
        row.save(update_fields=["content", "coverage", "updated_at"])
        return {"item": attachment_json(row)}
    if operation == "remove":
        if row.message_id is not None:
            raise ValueError("Delete the conversation to remove sent files")
        row.deleted = True
        row.save(update_fields=["deleted", "updated_at"])
        return {"ok": True}
    if operation == "read":
        if not row.content or row.deleted or (row.message_id is None and row.expires_at <= timezone.now()):
            raise ValueError("Attachment expired, still preparing or removed")
        if str(row.conversation_id) != str(payload.get("conversationId")):
            raise ValueError("Attachment not found")
        return {"item": {**attachment_json(row), "key": row.document_key, "content": row.content}}
    raise ValueError("Invalid attachment operation")


ACTIONS = {
    "primo-feedback": action_primo_feedback,
    "primo-attachment": action_primo_attachment,
    "primo-save-turn": action_primo_save_turn,
    "primo-rename-conversation": action_primo_rename_conversation,
    "primo-archive-conversation": action_primo_archive_conversation,
    "primo-delete-conversation": action_primo_delete_conversation,
}
