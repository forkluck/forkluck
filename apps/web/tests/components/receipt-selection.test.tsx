// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

/**
 * Picking a line in the reviewer is what moves the box on the document beside
 * it. The document pane is stubbed here — rendering a PDF is its own test —
 * so what is pinned is the selection the reviewer hands it.
 */

const loadReadyDriveDocuments = vi.fn()

vi.mock("@/app/(app)/ingredients/actions", () => ({
  searchCatalogIngredients: vi.fn(async () => ({ items: [] })),
  activateCatalogIngredient: vi.fn(),
}))
vi.mock("@/app/(app)/invoices/actions", () => ({
  importInvoices: vi.fn(),
  checkDriveNow: vi.fn(),
  deleteInvoice: vi.fn(),
  loadReadyDriveDocuments: () => loadReadyDriveDocuments(),
  skipDriveFiles: vi.fn(),
  saveAnthropicKey: vi.fn(),
  deleteAnthropicKey: vi.fn(),
}))
vi.mock("@/app/(app)/settings/actions", () => ({
  listSuppliers: () => Promise.resolve([]),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))
vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({ currencyCode: "USD", timezone: "UTC" }),
}))
vi.mock("@/components/invoices/document-viewer", () => ({
  DocumentViewer: ({
    boxes,
    selectedKey,
  }: {
    boxes: Array<{ key: string; label?: string }>
    selectedKey: string | null
  }) => (
    <div data-testid="viewer" data-selected={selectedKey ?? ""}>
      {boxes.map((entry) => (
        <span
          key={entry.key}
          data-testid="viewer-box"
          data-key={entry.key}
          data-label={entry.label}
        />
      ))}
    </div>
  ),
}))

import { ImportInvoicesDialog } from "@/components/invoices/import-invoices-dialog"
import type { InvoiceParseResult } from "@/lib/invoice-import"

import {
  INGREDIENTS,
  line,
  parseResult,
  readyDocument,
} from "./receipt-fixture"

afterEach(cleanup)

const BOX = { page: 0, x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.24 }

/** Two lines: one the read could place on the page, one it could not. */
const LINES = [
  line({ box: BOX }),
  line({
    itemKey: "flour-50",
    description: "FLOUR AP 50#",
    lineAmountCents: null,
    box: null,
  }),
]

async function openReviewer(results: InvoiceParseResult[]) {
  loadReadyDriveDocuments.mockResolvedValue({
    documents: results.map((result) => readyDocument(result)),
    readyCount: results.length,
    unreadable: 0,
  })
  render(
    <ImportInvoicesDialog
      config={null}
      driveConnectHref={null}
      ingredientsStatus="ready"
      onRetryIngredients={() => {}}
      ingredients={INGREDIENTS}
      open
      onOpenChange={vi.fn()}
      inbox
      byok={false}
      aiKeyConfigured={false}
      aiKeyHint={null}
    />
  )
  await screen.findByText(`1 of ${results.length}`)
}

function selection() {
  return screen.getByTestId("viewer").getAttribute("data-selected")
}

describe("the reviewer tells the document which line is selected", () => {
  it("selects the line whose row is clicked", async () => {
    await openReviewer([parseResult({ lines: LINES })])
    expect(selection()).toBe("")

    fireEvent.click(screen.getByText("BUTTER SALTED 24#"))

    expect(selection()).toBe("butter-24-0")
  })

  it("selects the row a control inside it is focused from", async () => {
    await openReviewer([parseResult({ lines: LINES })])

    fireEvent.focusIn(
      screen.getByLabelText("Amount for FLOUR AP 50#", { exact: true })
    )

    expect(selection()).toBe("flour-50-1")
  })

  it("starts the next receipt with nothing selected", async () => {
    await openReviewer([
      parseResult({ lines: LINES }),
      parseResult({ driveFileId: "drive-2", invoiceNumber: "9001" }),
    ])
    fireEvent.click(screen.getByText("BUTTER SALTED 24#"))
    expect(selection()).toBe("butter-24-0")

    fireEvent.keyDown(document.body, { key: "ArrowRight" })

    await screen.findByText("2 of 2")
    expect(selection()).toBe("")
  })

  it("hands the document only the lines it could place", async () => {
    await openReviewer([parseResult({ lines: LINES })])

    const drawn = screen.getAllByTestId("viewer-box")
    expect(
      drawn.map((node) => [
        node.getAttribute("data-key"),
        node.getAttribute("data-label"),
      ])
    ).toEqual([["butter-24-0", "BUTTER SALTED 24#"]])
  })
})
