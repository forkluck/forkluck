from typing import Any

from ...models import PrimoAttachment, PrimoConversation, PrimoMessage
from ..shared.values import iso

JsonObject = dict[str, Any]


def conversation_json(row: PrimoConversation) -> JsonObject:
    return {
        "id": str(row.id),
        "title": row.title,
        "isArchived": row.is_archived,
        "archivedAt": iso(row.archived_at) if row.archived_at else None,
        "lastMessageAt": iso(row.last_message_at) if row.last_message_at else None,
        "createdAt": iso(row.created_at),
        "updatedAt": iso(row.updated_at),
    }


def message_json(row: PrimoMessage) -> JsonObject:
    return {
        "id": row.message_id,
        "role": row.role,
        "feedback": row.feedback,
        "feedbackComment": row.feedback_comment,
        "parts": row.parts,
        "status": row.status,
        "metadata": row.metadata,
        "createdAt": iso(row.created_at),
    }


def attachment_json(row: PrimoAttachment) -> JsonObject:
    return {"id": str(row.id), "name": row.name, "mediaType": row.media_type,
            "size": row.size, "coverage": row.coverage}
