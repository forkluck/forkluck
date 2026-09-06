import { describe, expect, it } from "vitest"

import { issueText } from "../components/invoices/invoice-issue"
import type { InvoiceRow } from "../lib/backend/types"

function invoice(partial: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "inv-1",
    publicId: "inv_1",
    supplier: "acme",
    supplierName: "Acme Produce",
    documentType: "invoice",
    invoiceNumber: "B-1001",
    invoiceDate: "2026-08-12",
    currencyCode: "USD",
    totalCents: 12500,
    taxCents: 0,
    lineCount: 8,
    matchedLineCount: 8,
    unresolvedLineCount: 0,
    issueKind: null,
    totalDeltaCents: 0,
    fileName: "",
    source: null,
    driveFileId: null,
    driveWebViewLink: null,
    createdAt: new Date("2026-08-12T00:00:00Z"),
    updatedAt: new Date("2026-08-12T00:00:00Z"),
    ...partial,
  }
}

describe("issueText", () => {
  it("says nothing about a sound row", () => {
    expect(issueText(invoice(), "USD")).toBeNull()
  })

  it("counts unmatched lines, singular and plural", () => {
    expect(
      issueText(
        invoice({ issueKind: "unmatched-lines", unresolvedLineCount: 1 }),
        "USD"
      )
    ).toBe("1 unmatched line")
    expect(
      issueText(
        invoice({ issueKind: "unmatched-lines", unresolvedLineCount: 2 }),
        "USD"
      )
    ).toBe("2 unmatched lines")
  })

  it("names a document nothing was read from", () => {
    expect(
      issueText(invoice({ issueKind: "no-lines", lineCount: 0 }), "USD")
    ).toBe("No lines read")
  })

  it("signs the gap between the total and the lines", () => {
    expect(
      issueText(
        invoice({ issueKind: "total-mismatch", totalDeltaCents: 8873 }),
        "USD"
      )
    ).toBe("Total doesn't match lines (+$88.73)")
    expect(
      issueText(
        invoice({ issueKind: "total-mismatch", totalDeltaCents: -8873 }),
        "USD"
      )
    ).toBe("Total doesn't match lines (-$88.73)")
  })

  it("drops the amount when the read did not annotate one", () => {
    expect(
      issueText(
        invoice({ issueKind: "total-mismatch", totalDeltaCents: null }),
        "USD"
      )
    ).toBe("Total doesn't match lines")
  })

  it("names a supplier nobody has claimed", () => {
    expect(issueText(invoice({ issueKind: "unknown-supplier" }), "USD")).toBe(
      "Unknown supplier"
    )
  })
})
