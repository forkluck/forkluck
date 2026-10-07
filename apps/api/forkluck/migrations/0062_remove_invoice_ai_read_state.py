from django.db import migrations


class Migration(migrations.Migration):
    """State-only: the table is dropped in the release after this one."""

    dependencies = [
        ("forkluck", "0061_app_attest_key_and_delete_purpose"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[migrations.DeleteModel(name="InvoiceAiRead")],
        ),
    ]
