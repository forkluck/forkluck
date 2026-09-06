import json
import urllib.parse
from datetime import timedelta

from django.conf import settings
from django.db import connection, transaction
from django.http import HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods

from .crypto import CredentialCryptoError, decrypt, encrypt
from .models import (
    AuthorizationCode,
    AuthorizationSession,
    ConnectorConnection,
    ConnectorRun,
    DocumentPage,
)
from .providers import PROVIDERS
from .services import (
    client_required,
    connection_required,
    error,
    metrics_client_required,
    now,
    provider_allowed,
    random_token,
    rate_limit,
    request_json,
    run_json,
)


def _provider(key, subject_id=None):
    provider = PROVIDERS.get(key)
    if not provider_allowed(key, subject_id):
        return None
    return provider if provider and provider["available"] else None


def _body(request):
    try:
        return request_json(request)
    except ValueError as exc:
        return error("invalid_request", str(exc))


def _redirect_uri(client, payload):
    uri = payload.get("redirectUri")
    return uri if isinstance(uri, str) and uri == client.redirect_uri else None


@require_GET
def health(request):
    return JsonResponse({"status": "ok"})


@require_GET
def ready(request):
    try:
        connection.ensure_connection()
    except Exception:
        return JsonResponse({"status": "not_ready"}, status=503)
    return JsonResponse({"status": "ready"})


@require_GET
@metrics_client_required
def metrics(request):
    # Deliberately no tenant or credential dimensions.
    queued = ConnectorRun.objects.filter(status=ConnectorRun.Status.QUEUED).count()
    running = ConnectorRun.objects.filter(status=ConnectorRun.Status.RUNNING).count()
    failed = ConnectorRun.objects.filter(status=ConnectorRun.Status.FAILED).count()
    return HttpResponse(
        f'forkluck_connector_runs{{status="queued"}} {queued}\nforkluck_connector_runs{{status="running"}} {running}\nforkluck_connector_runs{{status="failed"}} {failed}\n',
        content_type="text/plain; version=0.0.4",
    )


@csrf_exempt
@require_GET
@client_required
def providers(request, *, client, subject_id):
    return JsonResponse(
        {
            "providers": [
                {key: value for key, value in provider.items() if key != "client"}
                for key, provider in PROVIDERS.items()
                if _provider(key, subject_id)
            ]
        }
    )


@csrf_exempt
@require_http_methods(["POST"])
@client_required
def create_authorization_session(request, *, client, subject_id):
    payload = _body(request)
    if isinstance(payload, JsonResponse):
        return payload
    provider_key = payload.get("providerKey")
    state = payload.get("state")
    redirect_uri = _redirect_uri(client, {"redirectUri": payload.get("callbackUrl")})
    if not _provider(provider_key, subject_id):
        return error("unknown_provider", "Provider is unavailable", 404)
    if not rate_limit(
        client,
        subject_id,
        provider_key,
        "authorize",
        settings.CONNECTORS_AUTH_ATTEMPTS_PER_MINUTE,
    ):
        return error("rate_limited", "Too many authorization attempts", 429)
    if not isinstance(state, str) or not 16 <= len(state) <= 256:
        return error("invalid_state", "state must be 16–256 characters")
    if redirect_uri is None:
        return error(
            "invalid_callback_url",
            "callbackUrl must exactly match the registered callback",
        )
    session = AuthorizationSession.objects.create(
        client=client,
        subject_id=subject_id,
        provider_key=provider_key,
        state=state,
        redirect_uri=redirect_uri,
        expires_at=now() + timedelta(seconds=settings.CONNECTORS_LOGIN_TTL_SECONDS),
    )
    return JsonResponse(
        {
            "sessionId": str(session.id),
            "authorizationUrl": f"{settings.CONNECTORS_PUBLIC_BASE_URL}/authorize/{session.id}",
            "expiresAt": session.expires_at.isoformat(),
        },
        status=201,
    )


@require_http_methods(["GET", "POST"])
def authorize(request, session_id):
    session = get_object_or_404(AuthorizationSession, pk=session_id)
    if session.consumed_at or session.expires_at <= now():
        return HttpResponse(
            "This authorization session has expired. Return to Forkluck and try again.",
            status=410,
        )
    provider = _provider(session.provider_key, session.subject_id)
    if provider is None:
        return HttpResponse("This connector is unavailable.", status=404)
    if request.method == "GET":
        return render(
            request,
            "connectors/authorize.html",
            {"provider": provider, "session": session},
        )
    username, password = (
        request.POST.get("username", ""),
        request.POST.get("password", ""),
    )
    if not username or not password or len(username) > 200 or len(password) > 500:
        return render(
            request,
            "connectors/authorize.html",
            {
                "provider": provider,
                "session": session,
                "error": "Enter a valid username and password.",
            },
            status=400,
        )
    if not rate_limit(
        session.client,
        session.subject_id,
        session.provider_key,
        "hosted_login",
        settings.CONNECTORS_AUTH_ATTEMPTS_PER_MINUTE,
    ):
        return render(
            request,
            "connectors/authorize.html",
            {
                "provider": provider,
                "session": session,
                "error": "Too many attempts. Try again later.",
            },
            status=429,
        )
    try:
        provider["client"](timeout=15.0).login(username, password)
        token = random_token()
        with transaction.atomic():
            locked = AuthorizationSession.objects.select_for_update().get(pk=session.id)
            if locked.consumed_at or locked.expires_at <= now():
                return HttpResponse(
                    "This authorization session has expired.", status=410
                )
            row, _created = ConnectorConnection.objects.update_or_create(
                client=locked.client,
                subject_id=locked.subject_id,
                provider_key=locked.provider_key,
                defaults={
                    "credential_encrypted": encrypt(
                        json.dumps({"username": username, "password": password})
                    ),
                    "token_hash": ConnectorConnection.hash_token(token),
                    "status": ConnectorConnection.Status.CONNECTED,
                    "last_error": "",
                },
            )
            code = random_token()
            AuthorizationCode.objects.create(
                code_hash=AuthorizationCode.digest(code),
                client=locked.client,
                subject_id=locked.subject_id,
                provider_key=locked.provider_key,
                connection=row,
                session=locked,
                token_encrypted=encrypt(token),
                expires_at=now()
                + timedelta(seconds=settings.CONNECTORS_CODE_TTL_SECONDS),
            )
            locked.consumed_at = now()
            locked.save(update_fields=["consumed_at"])
        separator = "&" if "?" in session.redirect_uri else "?"
        from django.shortcuts import redirect

        return redirect(
            session.redirect_uri
            + separator
            + urllib.parse.urlencode({"code": code, "state": session.state})
        )
    except CredentialCryptoError:
        return HttpResponse(
            "Connector service is not configured to store credentials.", status=503
        )
    except (
        Exception
    ):  # Provider exceptions are intentionally not reflected or logged with form data.
        return render(
            request,
            "connectors/authorize.html",
            {
                "provider": provider,
                "session": session,
                "error": "The provider did not accept that sign-in. Check it and try again.",
            },
            status=400,
        )


@csrf_exempt
@require_http_methods(["POST"])
@client_required
def exchange_code(request, *, client, subject_id):
    payload = _body(request)
    if isinstance(payload, JsonResponse):
        return payload
    code, session_id, state = (
        payload.get("code"),
        payload.get("sessionId"),
        payload.get("state"),
    )
    if not all(isinstance(value, str) for value in (code, session_id, state)):
        return error("invalid_code", "sessionId, state and code are required")
    with transaction.atomic():
        row = (
            AuthorizationCode.objects.select_for_update()
            .select_related("connection")
            .filter(
                code_hash=AuthorizationCode.digest(code),
                client=client,
                subject_id=subject_id,
                session_id=session_id,
                session__state=state,
            )
            .first()
        )
        if row is None or row.consumed_at or row.expires_at <= now():
            return error(
                "invalid_code", "Authorization code is invalid or expired", 400
            )
        row.consumed_at = now()
        row.save(update_fields=["consumed_at"])
    try:
        token = decrypt(row.token_encrypted)
    except CredentialCryptoError:
        return error("server_error", "Connection token could not be recovered", 503)
    return JsonResponse(
        {
            "connectionId": str(row.connection_id),
            "providerKey": row.provider_key,
            "accessToken": token,
            "status": row.connection.status,
        }
    )


@csrf_exempt
@require_http_methods(["DELETE"])
@connection_required(require_provider=False)
def disconnect(request, connection_id, *, client, subject_id, connection):
    connection.status = ConnectorConnection.Status.DISCONNECTED
    connection.credential_encrypted = ""
    connection.token_hash = ConnectorConnection.hash_token(random_token())
    connection.save(
        update_fields=["status", "credential_encrypted", "token_hash", "updated_at"]
    )
    return HttpResponse(status=204)


@csrf_exempt
@require_http_methods(["POST"])
@client_required
def create_run(request, *, client, subject_id):
    payload = _body(request)
    if isinstance(payload, JsonResponse):
        return payload
    connection_id = payload.get("connectionId")
    idempotency_key = payload.get("idempotencyKey")
    token = request.headers.get("X-Forkluck-Connection-Token", "")
    if (
        not isinstance(idempotency_key, str)
        or not idempotency_key
        or len(idempotency_key) > 128
    ):
        return error("invalid_idempotency_key", "A stable idempotencyKey is required")
    connection = ConnectorConnection.objects.filter(
        pk=connection_id, client=client, subject_id=subject_id
    ).first()
    if connection is None:
        return error("not_found", "Connection was not found", 404)
    if not token or not connection.verify_token(token):
        return error("invalid_connection_token", "Connection token is invalid", 401)
    if not provider_allowed(connection.provider_key, subject_id):
        return error(
            "provider_not_allowed",
            "This connector is not enabled for this account",
            403,
        )
    if connection.status != ConnectorConnection.Status.CONNECTED:
        return error(
            "connection_unavailable", "Reconnect this provider before syncing", 409
        )
    existing = ConnectorRun.objects.filter(
        client=client, subject_id=subject_id, idempotency_key=idempotency_key
    ).first()
    if existing is not None:
        if existing.connection_id != connection.id:
            return error(
                "idempotency_conflict",
                "That idempotency key belongs to another connection",
                409,
            )
        return JsonResponse({"runId": str(existing.id)}, status=200)
    if not rate_limit(
        client,
        subject_id,
        connection.provider_key,
        "run",
        settings.CONNECTORS_RUNS_PER_MINUTE,
    ):
        return error("rate_limited", "Too many sync requests", 429)
    from .worker import fail_stale_runs

    fail_stale_runs()
    with transaction.atomic():
        # Serialize run creation on the connection itself. Locking an active
        # run is insufficient when none exists yet: two first requests can
        # both observe an empty queryset and race the partial unique index.
        locked_connection = ConnectorConnection.objects.select_for_update().get(
            pk=connection.pk
        )
        existing = ConnectorRun.objects.filter(
            client=client,
            subject_id=subject_id,
            idempotency_key=idempotency_key,
        ).first()
        if existing is not None:
            if existing.connection_id != locked_connection.id:
                return error(
                    "idempotency_conflict",
                    "That idempotency key belongs to another connection",
                    409,
                )
            return JsonResponse({"runId": str(existing.id)}, status=200)
        active = ConnectorRun.objects.filter(
            connection=locked_connection,
            status__in=[ConnectorRun.Status.QUEUED, ConnectorRun.Status.RUNNING],
        ).first()
        if active:
            return JsonResponse({"runId": str(active.id)}, status=200)
        run = ConnectorRun.objects.create(
            connection=locked_connection,
            client=client,
            subject_id=subject_id,
            idempotency_key=idempotency_key,
            cursor=payload.get("cursor")
            if isinstance(payload.get("cursor"), dict)
            else {},
            progress={"pagesDone": 0, "documents": 0},
        )
    return JsonResponse({"runId": str(run.id)}, status=201)


def _run_for_request(run_id, client, subject_id, connection):
    run = ConnectorRun.objects.filter(
        pk=run_id, client=client, subject_id=subject_id, connection=connection
    ).first()
    return run


@csrf_exempt
@require_GET
@connection_required
def run_status(request, run_id, *, client, subject_id, connection):
    run = _run_for_request(run_id, client, subject_id, connection)
    return (
        JsonResponse(run_json(run))
        if run
        else error("not_found", "Run was not found", 404)
    )


@csrf_exempt
@require_http_methods(["POST"])
@connection_required
def next_page(request, run_id, *, client, subject_id, connection):
    run = _run_for_request(run_id, client, subject_id, connection)
    if run is None:
        return error("not_found", "Run was not found", 404)
    payload = _body(request)
    if isinstance(payload, JsonResponse):
        return payload
    cursor = payload.get("cursor")
    if not isinstance(cursor, dict):
        return error("invalid_cursor", "cursor must be an object", 400)
    if run.status != ConnectorRun.Status.SUCCEEDED:
        return error(
            "page_not_ready",
            "The connector run has not completed successfully",
            409,
        )
    page = run.pages.filter(acknowledged_at__isnull=True).order_by("sequence").first()
    if page is None:
        return error(
            "cursor_consumed", "No unacknowledged page remains for this run", 409
        )
    previous = run.pages.filter(sequence=page.sequence - 1).first()
    expected_cursor = previous.next_cursor if previous is not None else {}
    if cursor != expected_cursor:
        return error(
            "stale_cursor", "This delivery cursor has already been consumed", 409
        )
    return JsonResponse(
        {
            "pageId": str(page.id),
            "documents": page.payload["documents"],
            "done": page.next_cursor.get("complete") is True,
            "nextCursor": None
            if page.next_cursor.get("complete") is True
            else page.next_cursor,
            "progress": run.progress,
        }
    )


@csrf_exempt
@require_http_methods(["POST"])
@connection_required
def ack_page(request, run_id, page_id, *, client, subject_id, connection):
    run = _run_for_request(run_id, client, subject_id, connection)
    if run is None:
        return error("not_found", "Run was not found", 404)
    with transaction.atomic():
        page = (
            DocumentPage.objects.select_for_update().filter(pk=page_id, run=run).first()
        )
        if page is None:
            return error("not_found", "Page was not found", 404)
        if page.acknowledged_at is None:
            page.acknowledged_at = now()
            page.save(update_fields=["acknowledged_at"])
    return JsonResponse({"acknowledged": True})
