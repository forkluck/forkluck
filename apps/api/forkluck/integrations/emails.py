import base64
import json
import logging
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from azure.communication.email import EmailClient
from azure.core.exceptions import AzureError, HttpResponseError
from django.conf import settings

logger = logging.getLogger(__name__)

_client: EmailClient | None = None


class EmailNotConfigured(Exception):
    pass


def send_email(to: str, subject: str, text: str) -> None:
    """Send through the configured Ghost mail bridge, or directly through ACS.

    Raises EmailNotConfigured when neither provider is configured, and
    ValueError when delivery is not accepted. Callers surface friendly errors.
    """
    global _client

    if settings.FORKLUCK_MAIL_BRIDGE_URL:
        credentials = base64.b64encode(("api:" + settings.FORKLUCK_MAIL_BRIDGE_API_KEY).encode()).decode()
        request = Request(settings.FORKLUCK_MAIL_BRIDGE_URL, method="POST", headers={
            "Authorization": "Basic " + credentials,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        }, data=urlencode({
            "from": settings.FORKLUCK_EMAIL_FROM, "to": to,
            "subject": subject, "text": text, "o:tag": "source:forkluck-app",
        }).encode())
        try:
            with urlopen(request, timeout=10) as response:
                body = json.loads(response.read(4096))
                if response.status != 200 or not isinstance(body, dict) or not body.get("id"):
                    raise ValueError("Mail bridge did not accept the message")
        except (URLError, OSError, ValueError) as exc:
            # Do not retry through ACS after an ambiguous bridge response:
            # it may already have queued the message. Never log codes or keys.
            logger.error("Mail bridge could not accept email")
            raise ValueError("The verification email could not be sent") from exc
        return

    if not settings.ACS_CONNECTION_STRING:
        raise EmailNotConfigured("ACS_CONNECTION_STRING is not set")

    try:
        if _client is None:
            _client = EmailClient.from_connection_string(settings.ACS_CONNECTION_STRING)
        # polling=False and retry_total=0 keep this one request: the 202 is the
        # accept, and polling the status is rate-limited to 60 calls a minute
        # across the whole resource.
        _client.begin_send(
            {
                "senderAddress": settings.FORKLUCK_EMAIL_FROM,
                "recipients": {"to": [{"address": to}]},
                "content": {"subject": subject, "plainText": text},
            },
            polling=False,
            retry_total=0,
            connection_timeout=10,
            read_timeout=10,
        )
    except HttpResponseError as exc:
        logger.error(
            "ACS rejected email to %s: %s %s",
            to,
            exc.status_code,
            str(exc.message)[:500],
        )
        raise ValueError("The verification email could not be sent") from exc
    except (AzureError, ValueError) as exc:
        logger.error("ACS could not send to %s: %s", to, str(exc)[:500])
        raise ValueError("The verification email could not be sent") from exc


def send_verification_code(to: str, code: str, *, purpose: str) -> None:
    if purpose == "admin":
        subject = "Your Forkluck sign-in code"
    elif purpose == "password_reset":
        subject = "Your Forkluck password reset code"
    else:
        subject = "Your Forkluck verification code"
    text = (
        f"Your code is: {code}\n\n"
        "It expires in 10 minutes. If you didn't request this, you can "
        "ignore this email.\n\n— Forkluck"
    )
    send_email(to, subject, text)


def send_guest_share(
    to: str,
    *,
    owner_name: str,
    recipe_title: str,
    link: str,
    role: str,
) -> None:
    """Email one capability link to an address with no account.

    An editor invitation reads differently: the link only reads, and the
    editing it promises arrives with the account the address still has to
    create.
    """
    if role == "editor":
        subject = f"{owner_name} invited you to edit a recipe"
        text = (
            f'{owner_name} invited you to edit the recipe "{recipe_title}" '
            "on Forkluck."
            f"\n\nRead it here:\n{link}\n\n"
            "To edit it, create a Forkluck account with this email address "
            "and the recipe will be waiting in your kitchen.\n\n"
            "If you did not expect this, you can simply delete this message.\n"
        )
    else:
        subject = f"{owner_name} shared a recipe with you"
        text = (
            f'{owner_name} shared the recipe "{recipe_title}" with you on Forkluck.'
            f"\n\n{link}\n\n"
            "If you did not expect this, you can simply delete this message.\n"
        )
    send_email(to, subject, text)


def send_share_notification(
    to: str, *, owner_name: str, recipe_title: str, role: str, link: str
) -> None:
    """Tell an account holder that a recipe now sits in their kitchen."""
    subject = f"{owner_name} shared a recipe with you"
    standing = "an editor" if role == "editor" else "a viewer"
    text = (
        f'{owner_name} shared the recipe "{recipe_title}" with you on '
        f"Forkluck as {standing}."
        f"\n\nOpen it:\n{link}\n"
    )
    send_email(to, subject, text)


def send_shares_notification(
    to: str, *, owner_name: str, recipe_count: int, role: str, link: str
) -> None:
    """Tell an account holder that several recipes now sit in their kitchen.

    One mail for the whole selection rather than one per recipe: the share
    rows are what grant access, and the reader only needs telling once.
    """
    subject = f"{owner_name} shared {recipe_count} recipes with you"
    standing = "an editor" if role == "editor" else "a viewer"
    text = (
        f"{owner_name} shared {recipe_count} recipes with you on Forkluck "
        f"as {standing}."
        f"\n\nOpen them:\n{link}\n"
    )
    send_email(to, subject, text)


def send_book_share(
    to: str,
    *,
    owner_name: str,
    title: str,
    recipe_count: int,
    link: str,
    role: str,
) -> None:
    """Email one capability link over several recipes to an address with no
    account.

    The same promise `send_guest_share` makes, over a book rather than a
    single recipe: an editor invitation still only reads until the address
    has an account. An untitled book is named by its size.
    """
    name = title or f"{recipe_count} recipes"
    if role == "editor":
        subject = f"{owner_name} invited you to edit {recipe_count} recipes"
        text = (
            f'{owner_name} invited you to edit "{name}" on Forkluck.'
            f"\n\nRead them here:\n{link}\n\n"
            "To edit them, create a Forkluck account with this email address "
            "and the recipes will be waiting in your kitchen.\n\n"
            "If you did not expect this, you can simply delete this message.\n"
        )
    else:
        subject = f"{owner_name} shared {recipe_count} recipes with you"
        text = (
            f'{owner_name} shared "{name}" with you on Forkluck.'
            f"\n\n{link}\n\n"
            "If you did not expect this, you can simply delete this message.\n"
        )
    send_email(to, subject, text)


def send_kitchen_invite(to: str, *, owner_name: str, role: str, link: str) -> None:
    """Invite an address with no account into a whole kitchen.

    There is no link to the recipes yet: a member has to be an account
    holder, so what the mail asks for is the account, and the kitchen is
    waiting on the other side of it.
    """
    standing = "an editor" if role == "editor" else "a viewer"
    subject = f"{owner_name} invited you to their kitchen"
    text = (
        f"{owner_name} invited you to their kitchen on Forkluck as {standing}."
        "\n\nCreate a Forkluck account with this email address and their "
        "recipes will be waiting for you."
        f"\n\n{link}\n\n"
        "If you did not expect this, you can simply delete this message.\n"
    )
    send_email(to, subject, text)


def send_kitchen_member_notification(
    to: str, *, owner_name: str, role: str, link: str
) -> None:
    """Tell an account holder that a kitchen's recipes reached their app."""
    subject = f"{owner_name} added you to their kitchen"
    standing = "an editor" if role == "editor" else "a viewer"
    text = (
        f"{owner_name} added you to their kitchen on Forkluck as {standing}."
        f"\n\nOpen it:\n{link}\n"
    )
    send_email(to, subject, text)


def send_new_user_notification(
    to: str,
    *,
    name: str,
    email: str,
    registered_at: str,
    verified_at: str,
) -> None:
    """Tell the site owner that a verified registration entered the app."""
    subject = "New verified Forkluck user"
    text = (
        "A new user verified their email and signed in to Forkluck.\n\n"
        f"Name: {name}\n"
        f"Email: {email}\n"
        f"Registered: {registered_at}\n"
        f"Verified and signed in: {verified_at}\n"
    )
    send_email(to, subject, text)


def send_nutrition_request_notification(
    to: str,
    *,
    user_name: str,
    user_email: str,
    ingredient_name: str,
    ingredient_id: str,
    serving_grams: str,
    values: dict[str, object],
    note: str,
) -> None:
    """Tell support a custom nutrition value is waiting in the staff console."""
    subject = f"Custom nutrition value requested: {ingredient_name}"
    lines = [
        "A user typed package nutrition values for an ingredient no USDA record matches.",
        "Apply it from the staff console under Nutrition requests.",
        "",
        f"User: {user_name} <{user_email}>",
        f"Ingredient: {ingredient_name} ({ingredient_id})",
        f"Per serving of: {serving_grams} g",
    ]
    for key, value in values.items():
        lines.append(f"{key}: {'blank' if value is None else value}")
    if note:
        lines.extend(["", f"Note: {note}"])
    send_email(to, subject, "\n".join(lines) + "\n")
