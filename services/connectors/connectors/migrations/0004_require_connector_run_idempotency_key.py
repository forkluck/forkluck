from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("connectors", "0003_backfill_connector_run_idempotency_key")]
    operations = [
        migrations.AlterField(
            model_name="connectorrun",
            name="idempotency_key",
            field=models.CharField(max_length=128),
        ),
        migrations.AddConstraint(
            model_name="connectorrun",
            constraint=models.UniqueConstraint(
                fields=("client", "subject_id", "idempotency_key"),
                name="unique_run_idempotency_key",
            ),
        ),
    ]
