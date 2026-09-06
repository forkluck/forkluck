from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("forkluck", "0029_drive_folder_source"),
    ]

    operations = [
        migrations.AddField(
            model_name="expensecategory",
            name="is_supply",
            field=models.BooleanField(default=False),
        ),
    ]
