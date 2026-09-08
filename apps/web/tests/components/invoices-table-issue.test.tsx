// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, within } from "@testing-library/react"

vi.mock("server-only", () => ({}))
vi.mock("@/app/(app)/invoices/actions", () => ({ deleteInvoice: vi.fn() }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ add: vi.fn() }) }))

import { InvoicesTable } from "@/components/invoices/invoices-table"
import type { InvoiceRow } from "@/lib/backend/types"

afterEach(cleanup)

function invoice(partial: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "inv-1",
    publicId: "inv_1",
    supplier: "acme",
    supplierName: "Acme Produce",
    documentType: "invoice",
    invoiceNumber: "B-1001",
    invoiceDate: "2026-08-09",
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
    createdAt: new Date("2026-08-09T00:00:00Z"),
    updatedAt: new Date("2026-08-09T00:00:00Z"),
    ...partial,
  }
}

describe("the invoices table's issue marker", () => {
  it("marks what is wrong beside the supplier and leaves a sound row bare", () => {
    render(
      <InvoicesTable
        invoices={[
          invoice(),
          invoice({
            id: "inv-2",
            issueKind: "unmatched-lines",
            unresolvedLineCount: 2,
          }),
          invoice({ id: "inv-3", issueKind: "no-lines", lineCount: 0 }),
          invoice({
            id: "inv-4",
            issueKind: "total-mismatch",
            totalDeltaCents: 8873,
          }),
          invoice({ id: "inv-5", issueKind: "unknown-supplier" }),
        ]}
        emptyMessage="No invoices in this month."
      />
    )

    // The column the marker replaced is gone.
    expect(screen.queryByRole("columnheader", { name: "Issue" })).toBeNull()
    expect(
      screen.getByRole("button", { name: "2 unmatched lines" })
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "No lines read" })).toBeTruthy()
    expect(
      screen.getByRole("button", {
        name: "Total doesn't match lines (+$88.73)",
      })
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Unknown supplier" })
    ).toBeTruthy()
    // The sound row is the first one under the header, and its only button is
    // the actions menu: no marker.
    const soundRow = screen.getAllByRole("row")[1]
    expect(
      within(soundRow)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"))
    ).toEqual(["Actions for Acme Produce B-1001"])
    // The status chip the tab replaced is gone.
    expect(screen.queryByText("Applied")).toBeNull()
  })

  it("prints the invoice date as the day and month every screen uses", () => {
    render(
      <InvoicesTable
        invoices={[invoice()]}
        emptyMessage="No invoices in this month."
      />
    )
    expect(screen.getByText("Aug 9")).toBeTruthy()
  })
})
