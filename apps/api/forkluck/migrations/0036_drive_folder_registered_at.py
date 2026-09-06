from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("forkluck", "0035_remove_drive_file_skip_state"),
    ]

    operations = [
        migrations.AddField(
            model_name="drivefoldersource",
            name="registered_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
