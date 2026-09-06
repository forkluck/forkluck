from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("connectors", "0001_initial")]
    operations = [
        migrations.AddField(
            model_name="connectorrun",
            name="idempotency_key",
            field=models.CharField(max_length=128, null=True),
        )
    ]
