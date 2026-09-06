from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("forkluck", "0022_drop_menu_item_component_table"),
    ]

    operations = [
        migrations.AlterField(
            model_name="billingaccount",
            name="locked",
            field=models.BooleanField(default=False),
        ),
    ]
