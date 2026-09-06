// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

/**
 * "Remember for {supplier}" is the reviewer's answer to a one-off buy: apply
 * the price, but don't teach the supplier catalogue an item nobody will order
 * again. A merchant who declined the item on one line declined it on every
 * line of the same item, so the propagated twin carries the refusal too.
 */

const importInvoices = vi.fn()
const loadReadyDriveDocuments = vi.fn()

vi.mock("@/app/(app)/ingredients/actions", () => ({
  searchCatalogIngredients: vi.fn(async () => ({ items: [] })),
  activateCatalogIngredient: vi.fn(),
}))
vi.mock("@/app/(app)/invoices/actions", () => ({
  importInvoices: (input: unknown) => importInvoices(input),
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
  // Rendering the document is the document viewer's own test; here it only
  // has to be something the reviewer can put in its left pane.
  DocumentViewer: () => <div data-testid="viewer" />,
}))

import { ImportInvoicesDialog } from "@/components/invoices/import-invoices-dialog"

import {
  IMPORT_RECEIPT,
  INGREDIENTS,
  line,
  parseResult,
  readyDocument,
  reviewMatch,
} from "./receipt-fixture"

afterEach(cleanup)

/** Two lines of the same supplier item, both waiting on the same decision. */
const TWO_OF_THE_SAME = parseResult({
  lines: [
    line({ position: 1, match: reviewMatch({ ingredientId: null }) }),
    line({
      position: 2,
      description: "BUTTER SALTED 24# (2nd case)",
      match: reviewMatch({ ingredientId: null }),
    }),
  ],
})

async function openReviewer() {
  importInvoices.mockClear()
  importInvoices.mockResolvedValue(IMPORT_RECEIPT)
  loadReadyDriveDocuments.mockResolvedValue({
    documents: [readyDocument(TWO_OF_THE_SAME)],
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
  await screen.findByText("1 of 1")
}

describe("declining to remember an item", () => {
  it("applies the price and leaves the supplier catalogue alone", async () => {
    await openReviewer()

    fireEvent.click(screen.getAllByRole("button", { name: "Resolve" })[0])
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Remember for Wegmans" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Add price update" }))
    fireEvent.click(screen.getByRole("button", { name: "Import" }))

    await vi.waitFor(() => expect(importInvoices).toHaveBeenCalled())
    const [invoice] = importInvoices.mock.calls[0][0].invoices
    expect(invoice.lines[0].costEntry.remember).toBe(false)
    expect(invoice.lines[0].costEntry.packPriceCents).toBe(2159)
  })

  it("carries the refusal to the same item's other line", async () => {
    await openReviewer()

    fireEvent.click(screen.getAllByRole("button", { name: "Resolve" })[0])
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Remember for Wegmans" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Add price update" }))

    expect(screen.getByText("Same item")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Import" }))

    await vi.waitFor(() => expect(importInvoices).toHaveBeenCalled())
    const [invoice] = importInvoices.mock.calls[0][0].invoices
    expect(invoice.lines[1].costEntry.remember).toBe(false)
  })

  it("remembers by default", async () => {
    await openReviewer()

    fireEvent.click(screen.getAllByRole("button", { name: "Resolve" })[0])
    fireEvent.click(screen.getByRole("button", { name: "Add price update" }))
    fireEvent.click(screen.getByRole("button", { name: "Import" }))

    await vi.waitFor(() => expect(importInvoices).toHaveBeenCalled())
    const [invoice] = importInvoices.mock.calls[0][0].invoices
    expect(invoice.lines[0].costEntry.remember).toBe(true)
    expect(invoice.lines[1].costEntry.remember).toBe(true)
  })
})
