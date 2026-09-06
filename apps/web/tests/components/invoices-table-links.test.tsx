// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("server-only", () => ({}))
vi.mock("@/app/(app)/invoices/actions", () => ({ deleteInvoice: vi.fn() }))
const push = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push }),
}))
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ add: vi.fn() }) }))

import { InvoicesTable } from "@/components/invoices/invoices-table"
import type { InvoiceRow } from "@/lib/backend/types"

afterEach(cleanup)

function invoice(): InvoiceRow {
  return {
    id: "inv-1",
    publicId: "inv_k8f3m29qp7vw",
    supplier: "local-farm",
    supplierName: "Local Farm",
    documentType: "invoice",
    invoiceNumber: "A-1",
    invoiceDate: "2026-08-12",
    currencyCode: "USD",
    totalCents: 12500,
    lineCount: 4,
    matchedLineCount: 4,
    unresolvedLineCount: 0,
    taxCents: 0,
    issueKind: null,
    totalDeltaCents: 0,
    fileName: "",
    source: null,
    driveFileId: null,
    driveWebViewLink: null,
    createdAt: new Date("2026-08-12T00:00:00Z"),
    updatedAt: new Date("2026-08-12T00:00:00Z"),
  }
}

describe("the invoices list", () => {
  it("draws the screen's primary and points every row at its own screen", () => {
    render(
      <InvoicesTable
        invoices={[invoice()]}
        emptyMessage="No invoices in this month."
        listHref="/invoices?month=2026-07"
        primary={<button type="button">New invoice</button>}
      />
    )

    expect(screen.getByRole("button", { name: "New invoice" })).toBeTruthy()
    // The name is a link to the same screen, so the route is prefetched
    // before the row is clicked; the row click itself lands beside it.
    expect(
      screen.getByRole("link", { name: "Local Farm" }).getAttribute("href")
    ).toBe("/invoices/inv_k8f3m29qp7vw?returnTo=%2Finvoices%3Fmonth%3D2026-07")
    fireEvent.click(screen.getByText("Local Farm").closest("tr")!)
    expect(push).toHaveBeenCalledWith(
      "/invoices/inv_k8f3m29qp7vw?returnTo=%2Finvoices%3Fmonth%3D2026-07"
    )
  })
})
