from django.db import migrations


def unlock_accounts_that_are_not_deleting(apps, schema_editor):
    """A lock now means deletion only; a lapsed subscription is on the free plan."""
    BillingAccount = apps.get_model("forkluck", "BillingAccount")
    BillingAccount.objects.filter(locked=True, deletion_state="active").exclude(
        status="deleting"
    ).update(locked=False)


class Migration(migrations.Migration):
    dependencies = [
        ("forkluck", "0023_billing_account_unlocked_default"),
    ]

    operations = [
        migrations.RunPython(
            unlock_accounts_that_are_not_deleting, migrations.RunPython.noop
        ),
    ]
