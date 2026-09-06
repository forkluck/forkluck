import uuid

import django.db.models.deletion
import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True
    dependencies = []
    operations = [
        migrations.CreateModel(
            name="ServiceClient",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("client_id", models.CharField(max_length=120, unique=True)),
                ("secret_hash", models.CharField(max_length=128)),
                ("redirect_uri", models.URLField(max_length=500)),
                ("active", models.BooleanField(default=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
        ),
        migrations.CreateModel(
            name="ConnectorConnection",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("subject_id", models.CharField(max_length=128)),
                ("provider_key", models.CharField(max_length=64)),
                ("credential_encrypted", models.TextField()),
                ("token_hash", models.CharField(max_length=128)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("connected", "Connected"),
                            ("needs_reconnect", "Needs reconnect"),
                            ("disconnected", "Disconnected"),
                        ],
                        default="connected",
                        max_length=24,
                    ),
                ),
                ("last_error", models.CharField(blank=True, max_length=500)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "client",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        to="connectors.serviceclient",
                    ),
                ),
            ],
        ),
        migrations.CreateModel(
            name="AuthorizationSession",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("subject_id", models.CharField(max_length=128)),
                ("provider_key", models.CharField(max_length=64)),
                ("state", models.CharField(max_length=256)),
                ("redirect_uri", models.URLField(max_length=500)),
                ("expires_at", models.DateTimeField()),
                ("consumed_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "client",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        to="connectors.serviceclient",
                    ),
                ),
            ],
        ),
        migrations.CreateModel(
            name="ConnectorRun",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("subject_id", models.CharField(max_length=128)),
                ("cursor", models.JSONField(default=dict)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("queued", "Queued"),
                            ("running", "Running"),
                            ("succeeded", "Succeeded"),
                            ("failed", "Failed"),
                        ],
                        default="queued",
                        max_length=16,
                    ),
                ),
                ("progress", models.JSONField(default=dict)),
                ("error", models.CharField(blank=True, max_length=500)),
                ("heartbeat_at", models.DateTimeField(blank=True, null=True)),
                ("claim_token", models.UUIDField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "client",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        to="connectors.serviceclient",
                    ),
                ),
                (
                    "connection",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        to="connectors.connectorconnection",
                    ),
                ),
            ],
        ),
        migrations.CreateModel(
            name="DocumentPage",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("sequence", models.PositiveIntegerField()),
                ("payload", models.JSONField()),
                ("next_cursor", models.JSONField(default=dict)),
                ("acknowledged_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "run",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="pages",
                        to="connectors.connectorrun",
                    ),
                ),
            ],
        ),
        migrations.CreateModel(
            name="AuthorizationCode",
            fields=[
                (
                    "code_hash",
                    models.CharField(max_length=128, primary_key=True, serialize=False),
                ),
                ("subject_id", models.CharField(max_length=128)),
                ("provider_key", models.CharField(max_length=64)),
                ("token_encrypted", models.TextField()),
                ("expires_at", models.DateTimeField()),
                ("consumed_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "client",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        to="connectors.serviceclient",
                    ),
                ),
                (
                    "connection",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        to="connectors.connectorconnection",
                    ),
                ),
                (
                    "session",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        to="connectors.authorizationsession",
                    ),
                ),
            ],
        ),
        migrations.CreateModel(
            name="RateLimitBucket",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("subject_id", models.CharField(max_length=128)),
                ("provider_key", models.CharField(max_length=64)),
                ("operation", models.CharField(max_length=32)),
                ("window_started", models.DateTimeField()),
                ("count", models.PositiveIntegerField(default=0)),
                (
                    "client",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        to="connectors.serviceclient",
                    ),
                ),
            ],
        ),
        migrations.AddConstraint(
            model_name="connectorconnection",
            constraint=models.UniqueConstraint(
                fields=("client", "subject_id", "provider_key"),
                name="unique_provider_connection_per_subject",
            ),
        ),
        migrations.AddConstraint(
            model_name="connectorrun",
            constraint=models.UniqueConstraint(
                condition=models.Q(("status__in", ["queued", "running"])),
                fields=("connection",),
                name="one_active_run_per_connection",
            ),
        ),
        migrations.AddConstraint(
            model_name="documentpage",
            constraint=models.UniqueConstraint(
                fields=("run", "sequence"), name="unique_page_sequence"
            ),
        ),
        migrations.AddConstraint(
            model_name="ratelimitbucket",
            constraint=models.UniqueConstraint(
                fields=(
                    "client",
                    "subject_id",
                    "provider_key",
                    "operation",
                    "window_started",
                ),
                name="unique_rate_limit_window",
            ),
        ),
    ]
