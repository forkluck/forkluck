from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from xml.etree import ElementTree


ECB_DAILY_RATES_URL = (
    "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
)
SUPPORTED_CURRENCIES = frozenset({"USD", "EUR", "GBP", "CAD"})
RATE_PRECISION = Decimal("0.000000000001")


class ExchangeRateError(ValueError):
    pass


@dataclass(frozen=True)
class ExchangeRateQuote:
    source_currency: str
    target_currency: str
    rate: Decimal
    rate_date: date
    provider: str = "European Central Bank"

    def as_json(self) -> dict[str, str]:
        return {
            "sourceCurrency": self.source_currency,
            "targetCurrency": self.target_currency,
            "rate": format(self.rate, "f"),
            "rateDate": self.rate_date.isoformat(),
            "provider": self.provider,
        }


def parse_ecb_daily_rates(payload: bytes) -> tuple[date, dict[str, Decimal]]:
    try:
        root = ElementTree.fromstring(payload)
    except ElementTree.ParseError as exc:
        raise ExchangeRateError("The exchange-rate response was invalid") from exc

    rate_date: date | None = None
    rates: dict[str, Decimal] = {"EUR": Decimal("1")}
    for element in root.iter():
        if "time" in element.attrib:
            try:
                rate_date = date.fromisoformat(element.attrib["time"])
            except ValueError as exc:
                raise ExchangeRateError(
                    "The exchange-rate date was invalid"
                ) from exc
        currency = element.attrib.get("currency")
        raw_rate = element.attrib.get("rate")
        if currency in SUPPORTED_CURRENCIES and raw_rate is not None:
            try:
                rates[currency] = Decimal(raw_rate)
            except InvalidOperation as exc:
                raise ExchangeRateError(
                    "The exchange-rate response was invalid"
                ) from exc

    if rate_date is None or not SUPPORTED_CURRENCIES.issubset(rates):
        raise ExchangeRateError("The exchange-rate response was incomplete")
    return rate_date, rates


def get_ecb_daily_rates() -> tuple[date, dict[str, Decimal]]:
    """Fetch the ECB's daily reference rates.

    Deliberately uncached: the quote and the currency-change confirm are two
    requests that can land on different gunicorn workers, and Django's
    per-process LocMemCache would let one hold a pre-publish snapshot while the
    other fetched a post-publish one — failing the confirm with "the exchange
    rate changed" through no fault of the user. This is one static XML file
    behind a 5s timeout, requested only from the currency screen.
    """
    request = Request(
        ECB_DAILY_RATES_URL,
        headers={"User-Agent": "Forkluck/1.0 (+https://forkluck.com)"},
    )
    try:
        with urlopen(request, timeout=5) as response:
            return parse_ecb_daily_rates(response.read())
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise ExchangeRateError(
            "Exchange rates are temporarily unavailable. Try again shortly."
        ) from exc


def get_exchange_rate_quote(
    source_currency: str, target_currency: str
) -> ExchangeRateQuote:
    if (
        source_currency not in SUPPORTED_CURRENCIES
        or target_currency not in SUPPORTED_CURRENCIES
    ):
        raise ExchangeRateError("Invalid currency")
    if source_currency == target_currency:
        raise ExchangeRateError("Choose a different currency to convert")

    rate_date, rates = get_ecb_daily_rates()
    rate = (rates[target_currency] / rates[source_currency]).quantize(
        RATE_PRECISION
    )
    return ExchangeRateQuote(
        source_currency=source_currency,
        target_currency=target_currency,
        rate=rate,
        rate_date=rate_date,
    )


def convert_cents(cents: int, rate: Decimal) -> int:
    converted = (Decimal(cents) * rate).quantize(
        Decimal("1"), rounding=ROUND_HALF_UP
    )
    result = int(converted)
    if result < 0 or result > 2_147_483_647:
        raise ExchangeRateError("A converted amount is outside the allowed range")
    return result
