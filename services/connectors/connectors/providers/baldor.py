"""Baldor acquisition and normalization. Credentials stay in this service."""

import html
import http.cookiejar
import json
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from html.parser import HTMLParser

LOGIN_PATH = "/users/default/login"
LOGIN_PATHS = (LOGIN_PATH, "/users/default/new-login")
PROBE_PATH = "/users/default/login-redirect"
INVOICE_PAGE_CAP = 100
LINE_PAGE_CAP = 20
DOCUMENT_NUMBER = re.compile(r"^(IV|CR)\d{2,4}-\d{6,}$", re.IGNORECASE)


class BaldorError(Exception):
    pass


class BaldorAuthError(BaldorError):
    pass


class BaldorTransientError(BaldorError):
    pass


class _Forms(HTMLParser):
    def __init__(self):
        super().__init__()
        self.forms = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "form":
            self.forms.append(
                {
                    "id": values.get("id", "").lower(),
                    "action": values.get("action", ""),
                    "inputs": [],
                }
            )
        elif tag == "input" and self.forms:
            self.forms[-1]["inputs"].append(values)


class BaldorClient:
    """Session-local and paced; credentials and cookies never enter logs or DB payloads."""

    def __init__(
        self,
        base_url="https://www.baldorfood.com",
        timeout=30.0,
        sleep=time.sleep,
        pause_seconds=3.0,
        jitter_seconds=1.0,
        random_value=random.random,
        retry_waits=(30.0, 120.0),
    ):
        parsed = urllib.parse.urlsplit(base_url)
        local_http = parsed.scheme == "http" and parsed.hostname in {
            "localhost",
            "127.0.0.1",
        }
        if parsed.scheme != "https" and not local_http:
            raise BaldorError("Baldor must be reached over HTTPS")
        (
            self.base_url,
            self.timeout,
            self.sleep,
            self.pause_seconds,
            self.jitter_seconds,
            self.random_value,
            self.retry_waits,
        ) = (
            base_url.rstrip("/"),
            timeout,
            sleep,
            pause_seconds,
            jitter_seconds,
            random_value,
            retry_waits,
        )
        self.last_request_at = None
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )

    def _request(self, path, data=None, json_response=False):
        url = urllib.parse.urljoin(self.base_url + "/", path.lstrip("/"))
        if (
            urllib.parse.urlsplit(url).netloc
            != urllib.parse.urlsplit(self.base_url).netloc
        ):
            raise BaldorError("Baldor redirected outside its host")
        request = urllib.request.Request(
            url,
            data=urllib.parse.urlencode(data).encode() if data else None,
            headers={
                "User-Agent": "forkluck-connectors/1.0",
                **({"Accept": "application/vnd.api+json"} if json_response else {}),
            },
        )
        for wait in self.retry_waits + (None,):
            if self.last_request_at is not None:
                remaining = (
                    self.pause_seconds
                    + self.jitter_seconds * self.random_value()
                    - (time.monotonic() - self.last_request_at)
                )
                if remaining > 0:
                    self.sleep(remaining)
            self.last_request_at = time.monotonic()
            try:
                with self.opener.open(request, timeout=self.timeout) as response:
                    final_url = response.geturl()
                    if (
                        urllib.parse.urlsplit(final_url).netloc
                        != urllib.parse.urlsplit(self.base_url).netloc
                    ):
                        raise BaldorError("Baldor redirected outside its host")
                    raw = response.read(5 * 1024 * 1024 + 1)
                    if len(raw) > 5 * 1024 * 1024:
                        raise BaldorError("Baldor response was too large")
                    return final_url, raw.decode("utf-8", "replace")
            except urllib.error.HTTPError as exc:
                if exc.code in {401, 403}:
                    raise BaldorAuthError("Baldor rejected the session") from None
                retry_after = exc.headers.get("Retry-After")
                if exc.code != 429 and exc.code < 500:
                    raise BaldorTransientError("Baldor request failed") from None
            except (urllib.error.URLError, TimeoutError):
                retry_after = None
            if wait is None:
                raise BaldorTransientError("Baldor could not be reached")
            try:
                self.sleep(float(retry_after) if retry_after else wait)
            except ValueError:
                self.sleep(wait)

    def login(self, username, password):
        url, body = self._request(PROBE_PATH)
        if not _is_login_page(url, body):
            _, body = self._request(LOGIN_PATH)
        parser = _Forms()
        parser.feed(body)
        form = next(
            (
                item
                for item in parser.forms
                if item["id"] in {"login-form", "jsidnewloginform"}
            ),
            None,
        )
        if form is None:
            raise BaldorAuthError("Baldor sign-in form could not be read")
        fields = {
            item["name"]: item.get("value", "")
            for item in form["inputs"]
            if item.get("type") == "hidden" and item.get("name")
        }
        username_field = next(
            (
                item.get("name")
                for item in form["inputs"]
                if "email" in item.get("name", "").lower()
                or "username" in item.get("name", "").lower()
            ),
            None,
        )
        password_field = next(
            (
                item.get("name")
                for item in form["inputs"]
                if "password" in item.get("name", "").lower()
            ),
            None,
        )
        if not username_field or not password_field:
            raise BaldorAuthError("Baldor sign-in form could not be read")
        fields.update({username_field: username, password_field: password})
        url, body = self._request(form["action"] or LOGIN_PATH, fields)
        if _is_login_page(url, body):
            raise BaldorAuthError("Baldor did not accept sign in")
        url, body = self._request(PROBE_PATH)
        if _is_login_page(url, body):
            raise BaldorAuthError("Baldor did not accept sign in")

    def document_batches(self, from_date: date, to_date: date, *, start_page=0):
        """Yield normalized documents for each bounded supplier listing page."""
        if not isinstance(start_page, int) or not 0 <= start_page < INVOICE_PAGE_CAP:
            raise BaldorError("Invalid starting invoice page")
        seen_documents = set()
        page = start_page
        while True:
            payload = self.invoices(from_date, to_date, page)
            rows = payload.get("data")
            page_count = int(
                payload.get("meta", {}).get("pagination", {}).get("pageCount", 0)
            )
            if (
                not isinstance(rows, list)
                or page_count < 0
                or page_count > INVOICE_PAGE_CAP
            ):
                raise BaldorError("Provider returned invalid invoice page")
            documents = []
            for listed_row in rows:
                for row in _document_rows(listed_row):
                    document_number = str(row["id"]).upper()
                    if document_number in seen_documents:
                        continue
                    seen_documents.add(document_number)
                    documents.append(
                        normalize_document(row, _all_lines(self, document_number))
                    )
            yield documents
            if page + 1 >= page_count:
                return
            page += 1

    def invoices(self, from_date: date, to_date: date, page=0):
        query = urllib.parse.urlencode(
            {
                "hideRelatedCredits": 1,
                "openInvoices": 0,
                "page[number]": page,
                "page[size]": 20,
                "orderBy": "t.invoiceDate ASC",
                "fromDate": from_date.strftime("%m/%d/%Y"),
                "toDate": to_date.strftime("%m/%d/%Y"),
            }
        )
        _, body = self._request("/api/v1/invoices?" + query, json_response=True)
        try:
            return json.loads(body)
        except json.JSONDecodeError as exc:
            raise BaldorError("Baldor returned unreadable invoices") from exc

    def lines(self, document_number, page=0):
        if not DOCUMENT_NUMBER.match(document_number):
            raise BaldorError("Unexpected document number")
        _, body = self._request(
            f"/api/v1/order/{urllib.parse.quote(document_number)}/products?page[number]={page}&page[size]=50",
            json_response=True,
        )
        try:
            return json.loads(body)
        except json.JSONDecodeError as exc:
            raise BaldorError("Baldor returned unreadable invoice lines") from exc


def _is_login_page(url, body):
    return (
        urllib.parse.urlsplit(url).path.rstrip("/") in LOGIN_PATHS
        or "login-form" in body.lower()
        or "jsidnewloginform" in body.lower()
    )


def normalize_document(header, lines):
    """Produce only the supplier_documents:v1 shape. No raw provider payload escapes."""
    attributes = header["attributes"]
    number = str(header["id"]).upper()
    if not DOCUMENT_NUMBER.match(number):
        raise BaldorError("Unexpected document number")

    def cents(value):
        return int(
            (Decimal(str(value)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP)
        )

    is_credit = attributes.get("isCredit") is True
    total_cents = cents(attributes["invoiceTotal"])
    if is_credit:
        total_cents = -abs(total_cents)
    return {
        "supplier": "baldor",
        "supplierName": "Baldor Specialty Foods Inc.",
        "documentType": "credit_memo" if is_credit else "invoice",
        "invoiceNumber": number,
        "invoiceDate": attributes["formattedInvoiceDate"],
        "totalCents": total_cents,
        "currencyCode": "USD",
        "fileName": f"{number}.pdf",
        "lines": [
            {
                "sku": str(row["attributes"]["productId"]),
                "description": html.unescape(str(row["attributes"]["productTitle"])),
                "quantity": float(Decimal(str(row["attributes"]["quantity"]))),
                "unit": str(row["attributes"]["brname"]),
                "packSize": str(row["attributes"]["unitPart"]),
                "unitPriceCents": cents(row["attributes"]["price"]),
                "lineAmountCents": cents(row["attributes"]["priceExtended"]),
                "sourcePayload": {
                    "byWeight": row["attributes"].get("byWeight") is True,
                    "typeOfProduct": str(row["attributes"].get("typeOfProduct", "")),
                },
            }
            for row in lines
        ],
    }


def _all_lines(client, document_number):
    lines, page = [], 0
    while True:
        payload = client.lines(document_number, page)
        rows = payload.get("data")
        page_count = int(
            payload.get("meta", {}).get("pagination", {}).get("pageCount", 1)
        )
        if not isinstance(rows, list) or not 0 <= page_count <= LINE_PAGE_CAP:
            raise BaldorError("Provider returned an invalid invoice-lines page")
        lines.extend(rows)
        if page + 1 >= page_count:
            return lines
        page += 1


def _document_rows(row):
    """Expand credits hidden from the invoice listing into fetchable documents."""
    rows = [row]
    attributes = row.get("attributes") if isinstance(row, dict) else None
    related = (
        attributes.get("relatedCredits", []) if isinstance(attributes, dict) else []
    )
    if not isinstance(related, list):
        raise BaldorError("Provider returned invalid related credits")
    for credit in related:
        if not isinstance(credit, dict):
            raise BaldorError("Provider returned invalid related credits")
        rows.append(
            {
                "id": credit.get("id"),
                "attributes": {
                    "formattedInvoiceDate": str(credit.get("date", ""))[:10],
                    "invoiceTotal": credit.get("amount"),
                    "isCredit": True,
                },
            }
        )
    return rows
