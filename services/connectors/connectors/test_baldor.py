from datetime import date
from unittest import mock

from django.test import SimpleTestCase

from .providers.baldor import BaldorClient, BaldorError


class BaldorAcquisitionTests(SimpleTestCase):
    def test_related_credit_and_listing_duplicates_are_normalized_once(self):
        client = BaldorClient()
        invoice = {
            "id": "IV26-000001",
            "attributes": {
                "relatedCredits": [
                    {"id": "CR26-000002", "date": "2026-01-01", "amount": "2.50"}
                ]
            },
        }
        credit = {"id": "CR26-000002", "attributes": {}}
        with (
            mock.patch.object(
                client,
                "invoices",
                side_effect=[
                    {"data": [invoice], "meta": {"pagination": {"pageCount": 2}}},
                    {
                        "data": [invoice, credit],
                        "meta": {"pagination": {"pageCount": 2}},
                    },
                ],
            ) as invoices,
            mock.patch.object(
                client,
                "lines",
                return_value={"data": [], "meta": {"pagination": {"pageCount": 1}}},
            ) as lines,
            mock.patch(
                "connectors.providers.baldor.normalize_document",
                side_effect=lambda row, items: {"number": row["id"]},
            ),
        ):
            batches = list(client.document_batches(date(2026, 1, 1), date(2026, 2, 1)))
        self.assertEqual(
            batches, [[{"number": "IV26-000001"}, {"number": "CR26-000002"}], []]
        )
        self.assertEqual([call.args[2] for call in invoices.call_args_list], [0, 1])
        self.assertEqual(
            lines.call_args_list,
            [mock.call("IV26-000001", 0), mock.call("CR26-000002", 0)],
        )

    def test_line_pages_are_zero_based_and_capped(self):
        client = BaldorClient()
        listing = {
            "data": [{"id": "IV26-000001", "attributes": {}}],
            "meta": {"pagination": {"pageCount": 1}},
        }
        with (
            mock.patch.object(client, "invoices", return_value=listing),
            mock.patch.object(
                client,
                "lines",
                side_effect=[
                    {"data": ["first"], "meta": {"pagination": {"pageCount": 2}}},
                    {"data": ["second"], "meta": {"pagination": {"pageCount": 2}}},
                ],
            ) as lines,
            mock.patch(
                "connectors.providers.baldor.normalize_document",
                side_effect=lambda row, items: {"items": items},
            ),
        ):
            self.assertEqual(
                list(client.document_batches(date(2026, 1, 1), date(2026, 1, 1))),
                [[{"items": ["first", "second"]}]],
            )
        self.assertEqual([call.args[1] for call in lines.call_args_list], [0, 1])
        with (
            mock.patch.object(client, "invoices", return_value=listing),
            mock.patch.object(
                client,
                "lines",
                return_value={"data": [], "meta": {"pagination": {"pageCount": 21}}},
            ),
            self.assertRaises(BaldorError),
        ):
            list(client.document_batches(date(2026, 1, 1), date(2026, 1, 1)))

    def test_start_page_is_bounded_before_contacting_supplier(self):
        client = BaldorClient()
        for value in (-1, 100):
            with (
                self.subTest(start_page=value),
                mock.patch.object(client, "invoices") as invoices,
            ):
                with self.assertRaises(BaldorError):
                    list(
                        client.document_batches(
                            date(2026, 1, 1), date(2026, 1, 1), start_page=value
                        )
                    )
                invoices.assert_not_called()
