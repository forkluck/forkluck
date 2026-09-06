// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

/**
 * A file that holds several receipts: a scanned bundle, or one photo of a pile
 * of them. Each document is its own block in the reviewer, they all read the
 * one file behind them, and each is imported or skipped on its own.
 */

const skipDriveFiles = vi.fn()
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
  skipDriveFiles: (input: unknown) => skipDriveFiles(input),
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

/** What the pane was told to draw, which is the point of these tests. */
const viewerProps = vi.fn()
vi.mock("@/components/invoices/document-viewer", () => ({
  DocumentViewer: (props: unknown) => {
    viewerProps(props)
    return <div data-testid="viewer" />
  },
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

/** Two receipts scanned into one PDF: pages 0–1 and pages 2–3 of it. */
function scannedBundle(): InvoiceParseResult[] {
  return [
    parseResult({
      part: { part: 0, pages: { start: 0, end: 1 }, region: null },
      invoiceNumber: "487155",
    }),
    parseResult({
      part: { part: 1, pages: { start: 2, end: 3 }, region: null },
      invoiceNumber: "487156",
    }),
  ]
}

async function openReviewer(
  results: InvoiceParseResult[],
  mimeType = "application/pdf"
) {
  loadReadyDriveDocuments.mockResolvedValue({
    documents: results.map((result) => readyDocument(result, mimeType)),
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
  await screen.findByText(`1 of ${results.length}`)
}

function lastViewerProps() {
  const calls = viewerProps.mock.calls
  return calls[calls.length - 1][0] as {
    pages: { start: number; end: number } | null
    region: { x0: number; y0: number; x1: number; y1: number } | null
    boxes: Array<{ box: { x0: number; y0: number; x1: number; y1: number } }>
  }
}

describe("a scan holding several receipts", () => {
  it("reviews each one as its own block of the one file", async () => {
    await openReviewer(scannedBundle())

    expect(screen.getByText("487155 · part 1 of 2")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Files (1)" })).toBeTruthy()
    expect(lastViewerProps().pages).toEqual({ start: 0, end: 1 })

    fireEvent.keyDown(document.body, { key: "ArrowRight" })

    await screen.findByText("2 of 2")
    expect(screen.getByText("487156 · part 2 of 2")).toBeTruthy()
    expect(lastViewerProps().pages).toEqual({ start: 2, end: 3 })
  })

  it("skips one receipt out of the bundle and keeps the file", async () => {
    skipDriveFiles.mockResolvedValue({ ok: true })
    await openReviewer(scannedBundle())

    fireEvent.click(screen.getByRole("button", { name: "Skip" }))

    await screen.findByText("1 of 1")
    expect(skipDriveFiles).toHaveBeenCalledWith({
      files: [
        {
          driveFileId: "drive-1",
          fileName: "wegmans-487155.pdf",
          reason: "",
          part: 0,
        },
      ],
    })
    // The other receipt is still there, and so is the file it is read from.
    expect(screen.getByText("487156 · part 2 of 2")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Files (1)" })).toBeTruthy()
  })

  it("takes the whole file when it is never to be offered again", async () => {
    skipDriveFiles.mockResolvedValue({ ok: true })
    await openReviewer(scannedBundle())

    fireEvent.click(
      screen.getByRole("button", { name: "Never offer this file" })
    )

    await screen.findByText("Drop invoice PDFs or receipt photos here")
    expect(skipDriveFiles).toHaveBeenCalledWith({
      files: [
        {
          driveFileId: "drive-1",
          fileName: "wegmans-487155.pdf",
          reason: "",
          part: null,
        },
      ],
    })
    expect(screen.queryByText("wegmans-487155.pdf")).toBeNull()
  })
})

describe("a photo of several receipts", () => {
  it("outlines the receipt's corner and puts its lines back in the photo", async () => {
    await openReviewer(
      [
        parseResult({
          fileName: "IMG_1584.JPG",
          part: {
            part: 1,
            pages: null,
            region: { x0: 0.5, y0: 0.2, x1: 1, y1: 0.6 },
          },
          lines: [
            line({ box: { page: 0, x0: 0.2, y0: 0.5, x1: 0.6, y1: 0.75 } }),
          ],
        }),
      ],
      "image/jpeg"
    )

    const props = lastViewerProps()
    expect(props.region).toEqual({ x0: 0.5, y0: 0.2, x1: 1, y1: 0.6 })
    // Fractions of the crop become fractions of the whole photo.
    const box = props.boxes[0].box
    expect(box.x0).toBeCloseTo(0.6)
    expect(box.x1).toBeCloseTo(0.8)
    expect(box.y0).toBeCloseTo(0.4)
    expect(box.y1).toBeCloseTo(0.5)
  })
})
