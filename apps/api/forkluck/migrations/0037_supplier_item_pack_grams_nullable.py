from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("forkluck", "0036_drive_folder_registered_at"),
    ]

    operations = [
        migrations.AlterField(
            model_name="supplieritem",
            name="pack_grams",
            field=models.IntegerField(blank=True, null=True),
        ),
    ]
