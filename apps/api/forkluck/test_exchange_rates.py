from datetime import date
from decimal import Decimal

from django.test import SimpleTestCase

from .integrations.exchange_rates import convert_cents, parse_ecb_daily_rates


ECB_SAMPLE = b"""<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01"
 xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube><Cube time="2026-08-07">
    <Cube currency="USD" rate="1.2500"/>
    <Cube currency="GBP" rate="0.8750"/>
    <Cube currency="CAD" rate="1.5000"/>
  </Cube></Cube>
</gesmes:Envelope>
"""


class ExchangeRateTests(SimpleTestCase):
    def test_parses_ecb_date_and_euro_based_rates(self):
        rate_date, rates = parse_ecb_daily_rates(ECB_SAMPLE)

        self.assertEqual(rate_date, date(2026, 8, 7))
        self.assertEqual(rates["EUR"], Decimal("1"))
        self.assertEqual(rates["USD"], Decimal("1.2500"))
        self.assertEqual(rates["GBP"], Decimal("0.8750"))
        self.assertEqual(rates["CAD"], Decimal("1.5000"))

    def test_cent_conversion_rounds_half_up(self):
        self.assertEqual(convert_cents(101, Decimal("0.5")), 51)
        self.assertEqual(convert_cents(100, Decimal("1.2")), 120)
