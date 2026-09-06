// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

/**
 * A receipt that looks like one already on file is not refused, it is shown
 * beside it: the merchant is the one who knows whether the second Tuesday
 * delivery is the same delivery.
 */

const importInvoices = vi.fn()
const deleteInvoice = vi.fn()
const loadReadyDriveDocuments = vi.fn()

vi.mock("@/app/(app)/ingredients/actions", () => ({
  searchCatalogIngredients: vi.fn(async () => ({ items: [] })),
  activateCatalogIngredient: vi.fn(),
}))

vi.mock("@/app/(app)/invoices/actions", () => ({
  importInvoices: (input: unknown) => importInvoices(input),
  checkDriveNow: vi.fn(),
  deleteInvoice: (id: string) => deleteInvoice(id),
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
// The document pane renders PDFs; nothing here is about the document.
vi.mock("@/components/invoices/document-viewer", () => ({
  DocumentViewer: () => <div data-testid="viewer" />,
}))

import { DuplicateCompare } from "@/components/invoices/duplicate-compare"
import { ImportInvoicesDialog } from "@/components/invoices/import-invoices-dialog"
import type { ExistingInvoiceRef } from "@/lib/invoice-import"

import {
  IMPORT_RECEIPT,
  INGREDIENTS,
  parseResult,
  readyDocument,
} from "./receipt-fixture"

afterEach(cleanup)

const EXISTING: ExistingInvoiceRef = {
  id: "17",
  publicId: "inv_k8f3m29qp7vw",
  invoiceNumber: "487155",
  invoiceDate: "2026-08-09",
  totalCents: 1999,
  lineCount: 1,
  importedAt: "2026-08-11T14:30:00Z",
}

function renderCompare() {
  const handlers = {
    onKeepExisting: vi.fn(),
    onReplace: vi.fn(),
  }
  render(
    <DuplicateCompare
      current={{
        invoiceNumber: "487155",
        invoiceDate: "2026-08-09",
        totalCents: 2159,
        lineCount: 1,
      }}
      existing={EXISTING}
      currencyCode="USD"
      busy={false}
      {...handlers}
    />
  )
  return handlers
}

/** The two cells of one row, this receipt first. */
function row(label: string): HTMLElement[] {
  const term = screen.getByText(label)
  const cells: HTMLElement[] = []
  let node = term.nextElementSibling
  while (node && cells.length < 2) {
    cells.push(node as HTMLElement)
    node = node.nextElementSibling
  }
  return cells
}

describe("this receipt beside the one already imported", () => {
  it("lines the two up field by field", () => {
    renderCompare()
    expect(row("Number").map((cell) => cell.textContent)).toEqual([
      "487155",
      "487155",
    ])
    expect(row("Total").map((cell) => cell.textContent)).toEqual([
      "$21.59",
      "$19.99",
    ])
    expect(row("Lines").map((cell) => cell.textContent)).toEqual(["1", "1"])
    expect(row("Imported on")[0].textContent).toBe("—")
  })

  it("draws only the fields that disagree in ink", () => {
    renderCompare()
    for (const cell of row("Total")) {
      expect(cell.className).toContain("text-foreground")
    }
    for (const cell of row("Number")) {
      expect(cell.className).toContain("text-ink-soft")
    }
  })

  it("offers keep or replace, and says how to keep both", () => {
    const handlers = renderCompare()
    fireEvent.click(screen.getByRole("button", { name: "Keep existing" }))
    fireEvent.click(screen.getByRole("button", { name: "Replace" }))
    expect(handlers.onKeepExisting).toHaveBeenCalledTimes(1)
    expect(handlers.onReplace).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("button", { name: "Import anyway" })).toBeNull()
    expect(
      screen.getByText(/To keep both, change the number, date or total/)
    ).toBeTruthy()
  })

  it("replaces by deleting the imported invoice first, then importing", async () => {
    deleteInvoice.mockResolvedValue({ ok: true })
    importInvoices.mockResolvedValue(IMPORT_RECEIPT)
    loadReadyDriveDocuments.mockResolvedValue({
      documents: [
        readyDocument(
          parseResult({ duplicate: true, existingInvoice: EXISTING })
        ),
      ],
      readyCount: 1,
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
    await screen.findByText("An invoice like this one is already on file.")

    fireEvent.click(screen.getByRole("button", { name: "Replace" }))

    await vi.waitFor(() => expect(importInvoices).toHaveBeenCalled())
    expect(deleteInvoice).toHaveBeenCalledWith("17")
    expect(deleteInvoice.mock.invocationCallOrder[0]).toBeLessThan(
      importInvoices.mock.invocationCallOrder[0]
    )
  })
})
