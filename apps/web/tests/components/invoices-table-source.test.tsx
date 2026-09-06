// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

const refresh = vi.hoisted(() => vi.fn())

vi.mock("server-only", () => ({}))
vi.mock("@/app/(app)/invoices/actions", () => ({ deleteInvoice: vi.fn() }))
vi.mock("next/navigation", () => {
  const router = { refresh }
  return { useRouter: () => router }
})
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
    invoiceDate: "2026-08-12",
    currencyCode: "USD",
    totalCents: 12500,
    lineCount: 8,
    matchedLineCount: 8,
    unresolvedLineCount: 0,
    taxCents: 0,
    issueKind: null,
    totalDeltaCents: 0,
    fileName: "",
    source: "connector",
    driveFileId: null,
    driveWebViewLink: null,
    createdAt: new Date("2026-08-12T00:00:00Z"),
    updatedAt: new Date("2026-08-12T00:00:00Z"),
    ...partial,
  }
}

describe("invoices table source", () => {
  it("marks connector rows so they read apart from uploads", () => {
    render(
      <InvoicesTable
        invoices={[
          invoice(),
          invoice({
            id: "inv-2",
            invoiceNumber: "U-2002",
            supplierName: "Local Farm",
            source: null,
          }),
        ]}
        emptyMessage="No invoices in this month."
      />
    )

    // The connector row is badged; the uploaded row is not.
    expect(screen.getAllByText("Supplier import")).toHaveLength(1)
  })
})
