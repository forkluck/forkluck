import hashlib
import secrets
import uuid

from django.db import models


class ServiceClient(models.Model):
    client_id = models.CharField(max_length=120, unique=True)
    secret_hash = models.CharField(max_length=128)
    redirect_uri = models.URLField(max_length=500)
    active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    @classmethod
    def hash_secret(cls, value: str) -> str:
        return hashlib.sha256(value.encode()).hexdigest()

    def verify_secret(self, value: str) -> bool:
        return secrets.compare_digest(self.secret_hash, self.hash_secret(value))


class ConnectorConnection(models.Model):
    class Status(models.TextChoices):
        CONNECTED = "connected", "Connected"
        NEEDS_RECONNECT = "needs_reconnect", "Needs reconnect"
        DISCONNECTED = "disconnected", "Disconnected"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    client = models.ForeignKey(ServiceClient, on_delete=models.PROTECT)
    subject_id = models.CharField(max_length=128)
    provider_key = models.CharField(max_length=64)
    credential_encrypted = models.TextField()
    token_hash = models.CharField(max_length=128)
    status = models.CharField(
        max_length=24, choices=Status.choices, default=Status.CONNECTED
    )
    last_error = models.CharField(max_length=500, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["client", "subject_id", "provider_key"],
                name="unique_provider_connection_per_subject",
            )
        ]

    @classmethod
    def hash_token(cls, value: str) -> str:
        return hashlib.sha256(value.encode()).hexdigest()

    def verify_token(self, value: str) -> bool:
        return secrets.compare_digest(self.token_hash, self.hash_token(value))


class AuthorizationSession(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    client = models.ForeignKey(ServiceClient, on_delete=models.PROTECT)
    subject_id = models.CharField(max_length=128)
    provider_key = models.CharField(max_length=64)
    state = models.CharField(max_length=256)
    redirect_uri = models.URLField(max_length=500)
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)


class AuthorizationCode(models.Model):
    code_hash = models.CharField(max_length=128, primary_key=True)
    client = models.ForeignKey(ServiceClient, on_delete=models.PROTECT)
    subject_id = models.CharField(max_length=128)
    provider_key = models.CharField(max_length=64)
    connection = models.ForeignKey(ConnectorConnection, on_delete=models.CASCADE)
    session = models.ForeignKey(AuthorizationSession, on_delete=models.CASCADE)
    token_encrypted = models.TextField()
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    @classmethod
    def digest(cls, value: str) -> str:
        return hashlib.sha256(value.encode()).hexdigest()


class ConnectorRun(models.Model):
    class Status(models.TextChoices):
        QUEUED = "queued", "Queued"
        RUNNING = "running", "Running"
        SUCCEEDED = "succeeded", "Succeeded"
        FAILED = "failed", "Failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    connection = models.ForeignKey(ConnectorConnection, on_delete=models.PROTECT)
    client = models.ForeignKey(ServiceClient, on_delete=models.PROTECT)
    subject_id = models.CharField(max_length=128)
    idempotency_key = models.CharField(max_length=128)
    cursor = models.JSONField(default=dict)
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.QUEUED
    )
    progress = models.JSONField(default=dict)
    error = models.CharField(max_length=500, blank=True)
    heartbeat_at = models.DateTimeField(null=True, blank=True)
    claim_token = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["connection"],
                condition=models.Q(status__in=["queued", "running"]),
                name="one_active_run_per_connection",
            ),
            models.UniqueConstraint(
                fields=["client", "subject_id", "idempotency_key"],
                name="unique_run_idempotency_key",
            ),
        ]


class DocumentPage(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    run = models.ForeignKey(
        ConnectorRun, on_delete=models.CASCADE, related_name="pages"
    )
    sequence = models.PositiveIntegerField()
    payload = models.JSONField()
    next_cursor = models.JSONField(default=dict)
    acknowledged_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["run", "sequence"], name="unique_page_sequence"
            )
        ]


class RateLimitBucket(models.Model):
    """Database-backed fixed-minute limit shared by all HTTP worker processes."""

    client = models.ForeignKey(ServiceClient, on_delete=models.CASCADE)
    subject_id = models.CharField(max_length=128)
    provider_key = models.CharField(max_length=64)
    operation = models.CharField(max_length=32)
    window_started = models.DateTimeField()
    count = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=[
                    "client",
                    "subject_id",
                    "provider_key",
                    "operation",
                    "window_started",
                ],
                name="unique_rate_limit_window",
            )
        ]
