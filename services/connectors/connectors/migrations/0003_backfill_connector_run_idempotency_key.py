import uuid

from django.db import migrations


def backfill_idempotency_keys(apps, schema_editor):
    ConnectorRun = apps.get_model("connectors", "ConnectorRun")
    for run in ConnectorRun.objects.filter(idempotency_key__isnull=True).iterator():
        run.idempotency_key = str(uuid.uuid4())
        run.save(update_fields=["idempotency_key"])


class Migration(migrations.Migration):
    dependencies = [("connectors", "0002_connector_run_idempotency_key")]
    operations = [
        migrations.RunPython(backfill_idempotency_keys, migrations.RunPython.noop)
    ]
