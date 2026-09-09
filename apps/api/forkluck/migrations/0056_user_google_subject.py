from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("forkluck", "0055_recipe_component_unit")]

    operations = [
        migrations.AddField(
            model_name="user",
            name="google_subject",
            field=models.CharField(blank=True, max_length=255, null=True, unique=True),
        ),
    ]
