// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

/**
 * The probe already picked a pantry item for most review lines. When it also
 * read a pack and a price, taking its answer is one click — the drawer is for
 * the lines it couldn't finish.
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
import type { InvoiceParseResult } from "@/lib/invoice-import"

import {
  IMPORT_RECEIPT,
  INGREDIENTS,
  line,
  parseResult,
  readyDocument,
  reviewMatch,
} from "./receipt-fixture"

afterEach(cleanup)

async function openReviewer(result: InvoiceParseResult) {
  importInvoices.mockClear()
  importInvoices.mockResolvedValue(IMPORT_RECEIPT)
  loadReadyDriveDocuments.mockResolvedValue({
    documents: [readyDocument(result)],
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

describe("the suggested pantry item", () => {
  it("resolves the line in one click, on the read it already had", async () => {
    await openReviewer(
      parseResult({
        lines: [line({ match: reviewMatch({ ingredientId: "ing-butter" }) })],
      })
    )

    fireEvent.click(
      screen.getByRole("button", { name: "Use Butter · 24 lb · $21.59" })
    )

    expect(screen.getByText("Resolved")).toBeTruthy()
    expect(
      screen.queryByRole("button", { name: "Add price update" })
    ).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Import" }))
    await vi.waitFor(() => expect(importInvoices).toHaveBeenCalled())
    const [invoice] = importInvoices.mock.calls[0][0].invoices
    expect(invoice.lines[0].costEntry).toMatchObject({
      ingredientId: "ing-butter",
      name: "Butter",
      packAmount: 24,
      packUnit: "lb",
      packPriceCents: 2159,
    })
    expect(invoice.lines[0].needsReview).toBe(false)
  })

  it("opens the drawer instead when the read is short of a price", async () => {
    await openReviewer(
      parseResult({
        lines: [
          line({
            match: reviewMatch({
              ingredientId: "ing-butter",
              suggestedPriceCents: null,
            }),
          }),
        ],
      })
    )

    fireEvent.click(screen.getByRole("button", { name: "Use Butter · 24 lb" }))

    expect(
      screen.getByRole("button", { name: "Add price update" })
    ).toBeTruthy()
    expect(screen.queryByText("Resolved")).toBeNull()
  })

  it("says nothing when the probe had no item to suggest", async () => {
    await openReviewer(
      parseResult({
        lines: [line({ match: reviewMatch({ ingredientId: null }) })],
      })
    )

    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull()
    expect(screen.getByRole("button", { name: "Resolve" })).toBeTruthy()
  })
})
