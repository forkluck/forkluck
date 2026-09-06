"""The single action route: registry assembly and the error funnel.

Every internal mutation arrives here as POST actions/<slug>/. Each domain
owns the slugs it implements; this module only stitches those registries
together and turns handler failures into HTTP status codes. Imports run one
way — dispatch knows the domains, no domain knows dispatch.
"""

import logging
from collections.abc import Callable
from typing import Any

from django.core.exceptions import ImproperlyConfigured, ValidationError
from django.db import IntegrityError
from django.http import HttpRequest, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from ..domains.accounts.actions import ACTIONS as ACCOUNT_ACTIONS
from ..domains.accounts.billing import ACTIONS as BILLING_ACTIONS
from ..domains.accounts.billing_configuration import BillingNotReady
from ..domains.shared.billing import EntitlementError, write_blocked
from ..domains.shared.versioning import StaleWriteError
from ..domains.ingredients.actions import ACTIONS as INGREDIENT_ACTIONS
from ..domains.invoices.actions import ACTIONS as INVOICE_ACTIONS
from ..domains.invoices.connector_sync import ACTIONS as CONNECTOR_ACTIONS
from ..domains.labor.actions import ACTIONS as LABOR_ACTIONS
from ..domains.primo.actions import ACTIONS as PRIMO_ACTIONS
from ..domains.recipes.actions import ACTIONS as RECIPE_ACTIONS
from ..domains.workspace.actions import ACTIONS as WORKSPACE_ACTIONS
from ..models import User
from ..domains.sales.connections import ACTIONS as SALES_CONNECTION_ACTIONS
from ..domains.sales.core import ACTIONS as SALES_ACTIONS
from ..domains.sales.pos_sync import ACTIONS as SALES_SYNC_ACTIONS
from ..integrations.connectors import (
    ConnectorConflict,
    ConnectorError,
    ConnectorUnauthorized,
)
from ..integrations.token_crypto import TokenCryptoError
from .auth import internal_user
from .request import error, read_json

JsonObject = dict[str, Any]

logger = logging.getLogger(__name__)

ActionHandler = Callable[[User, JsonObject], JsonObject]

REGISTRIES: tuple[tuple[str, dict[str, ActionHandler]], ...] = (
    ("accounts", ACCOUNT_ACTIONS),
    ("billing", BILLING_ACTIONS),
    ("ingredients", INGREDIENT_ACTIONS),
    ("invoices", INVOICE_ACTIONS),
    ("invoices-connectors", CONNECTOR_ACTIONS),
    ("labor", LABOR_ACTIONS),
    ("primo", PRIMO_ACTIONS),
    ("recipes", RECIPE_ACTIONS),
    ("workspace", WORKSPACE_ACTIONS),
    ("sales-connections", SALES_CONNECTION_ACTIONS),
    ("sales-sync", SALES_SYNC_ACTIONS),
    ("sales", SALES_ACTIONS),
)


def _compose() -> dict[str, ActionHandler]:
    # Fail fast at import time so a duplicate slug can't shadow another
    # domain's action.
    combined: dict[str, ActionHandler] = {}
    owners: dict[str, str] = {}
    for owner, registry in REGISTRIES:
        for slug, handler in registry.items():
            if slug in combined:
                raise ImproperlyConfigured(
                    f"Action slug {slug!r} is claimed by both "
                    f"{owners[slug]} and {owner}"
                )
            combined[slug] = handler
            owners[slug] = owner
    return combined


ACTIONS: dict[str, ActionHandler] = _compose()


@csrf_exempt
@require_POST
@internal_user
def action(request: HttpRequest, action_name: str) -> JsonResponse:
    handler = ACTIONS.get(action_name)
    if handler is None:
        return error("Not found", 404)
    # A lapsed subscription may still run the billing actions that fix it, and
    # nothing else. Inert when billing is disabled: write_blocked answers
    # without a query then.
    if action_name not in BILLING_ACTIONS and write_blocked(request.user):
        return error(
            "Subscribe to continue using Forkluck.",
            403,
            code="subscription_required",
        )
    try:
        result = handler(request.user, read_json(request))
        return JsonResponse(result)
    except TokenCryptoError:
        # The detail names key ids and env vars — never echo it to the client.
        logger.exception("Token crypto failed in action %s", action_name)
        return error(
            "Stored provider credentials could not be read. Reconnect the "
            "channel in Settings."
        )
    except StaleWriteError as exc:
        return JsonResponse(
            {
                "error": (
                    f"This {exc.kind} changed in another window. "
                    "Reload to see the latest."
                ),
                "code": "stale_write",
                "editVersion": exc.current,
            },
            status=409,
        )
    except IntegrityError:
        # Reaching here means no domain recognised the constraint. The driver's
        # message names tables, constraints, columns and the conflicting values
        # themselves, so it stays in the log; domains that can explain a
        # specific constraint catch it themselves and raise ValueError.
        logger.exception("Database constraint failed in action %s", action_name)
        return error(
            "That change conflicts with existing data.", 409, code="conflict"
        )
    except BillingNotReady:
        return error(
            "Billing is temporarily unavailable. Try again shortly.",
            503,
            code="billing_not_ready",
        )
    except ConnectorConflict as exc:
        return error(str(exc), 409, code="connector_conflict")
    except ConnectorUnauthorized as exc:
        return error(str(exc), 403, code="connector_unauthorized")
    except ConnectorError as exc:
        return error(str(exc), 503, code="connector_service_error")
    except EntitlementError as exc:
        return error(str(exc), 403, code=exc.code)
    except (ValueError, ValidationError) as exc:
        message = exc.messages[0] if isinstance(exc, ValidationError) else str(exc)
        return error(message)
