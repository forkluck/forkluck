import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    """State-only removal; the table is dropped in the release after this one.

    Its foreign key goes now: an orphan table referencing users would stop
    TRUNCATE in the test flush, and the previous release never needed it.
    """

    dependencies = [
        ("forkluck", "0061_app_attest_key_and_delete_purpose"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.AlterField(
                    model_name="invoiceairead",
                    name="user",
                    field=models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.CASCADE,
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            state_operations=[migrations.DeleteModel(name="InvoiceAiRead")],
        ),
    ]
