"""The one currency a workspace reports in."""

from ...models import BenchCostSettings

DEFAULT_CURRENCY = "USD"


def workspace_currency_code(user) -> str:
    """The stored choice, else USD."""
    return (
        BenchCostSettings.objects.filter(user=user)
        .values_list("currency_code", flat=True)
        .first()
        or DEFAULT_CURRENCY
    )
