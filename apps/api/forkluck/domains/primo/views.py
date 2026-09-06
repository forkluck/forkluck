from django.http import HttpRequest, JsonResponse

from ...http.request import error
from ...models import PrimoConversation, PrimoMessage
from ..shared.pagination import paginate, paginated_payload, parse_browse_query
from .serializers import conversation_json, message_json


def conversation_list(request: HttpRequest) -> JsonResponse:
    try:
        browse = parse_browse_query(
            request.GET,
            allowed_orders=frozenset({"-lastMessageAt"}),
            default_order="-lastMessageAt",
            extra_keys=frozenset({"archived"}),
        )
        archived = request.GET.get("archived", "0")
        if archived not in {"0", "1"}:
            raise ValueError("Invalid archived")
        queryset = PrimoConversation.objects.filter(
            user=request.user, is_archived=archived == "1"
        ).order_by("-last_message_at", "-id")
        if browse.query:
            queryset = queryset.filter(title__icontains=browse.query)
        rows, total = paginate(queryset, browse)
    except ValueError as exc:
        return error(str(exc))
    return JsonResponse(
        paginated_payload([conversation_json(row) for row in rows], browse, total)
    )


def conversation_detail(request: HttpRequest, conversation_id) -> JsonResponse:
    conversation = PrimoConversation.objects.filter(
        id=conversation_id, user=request.user
    ).first()
    if conversation is None:
        return error("Not found", 404)
    messages = PrimoMessage.objects.filter(
        conversation=conversation, user=request.user
    ).order_by("created_at", "id")
    return JsonResponse(
        {
            "item": {
                "conversation": conversation_json(conversation),
                "messages": [message_json(row) for row in messages],
            }
        }
    )
