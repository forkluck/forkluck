from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("forkluck", "0024_fix_billing_locked"),
    ]

    operations = [
        migrations.AddField(
            model_name="recipeguestlink",
            name="role",
            field=models.CharField(
                choices=[("viewer", "Viewer"), ("editor", "Editor")],
                default="viewer",
                max_length=8,
            ),
        ),
    ]
