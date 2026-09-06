// @vitest-environment jsdom

import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/**
 * The reviewer, driven from the inbox: receipts the watcher already read are
 * seeded straight into the list, so this exercises the screen the merchant
 * actually spends the morning on — one receipt at a time, imported on its own.
 */

const importInvoices = vi.fn()
const skipDriveFiles = vi.fn()
const loadReadyDriveDocuments = vi.fn()
const refresh = vi.fn()

vi.mock("@/app/(app)/ingredients/actions", () => ({
  searchCatalogIngredients: vi.fn(async () => ({ items: [] })),
  activateCatalogIngredient: vi.fn(),
}))
vi.mock("@/app/(app)/invoices/actions", () => ({
  importInvoices: (input: unknown) => importInvoices(input),
  checkDriveNow: vi.fn(),
  deleteInvoice: vi.fn(),
  loadReadyDriveDocuments: () => loadReadyDriveDocuments(),
  skipDriveFiles: (input: unknown) => skipDriveFiles(input),
  saveAnthropicKey: vi.fn(),
  deleteAnthropicKey: vi.fn(),
}))
vi.mock("@/app/(app)/settings/actions", () => ({
  listSuppliers: () => Promise.resolve([{ id: "sup-1", name: "Wegmans" }]),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
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
} from "./receipt-fixture"

afterEach(cleanup)

/**
 * The two routes the dialog calls directly: the parse of an uploaded file, and
 * the store that keeps its bytes. `documentFails` is the store refusing.
 */
function mockRoutes(documentFails = false) {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).startsWith("/api/invoices/document")) {
      return documentFails
        ? { ok: false, json: async () => ({}) }
        : { ok: true, json: async () => ({ key: "user-1/kept.pdf" }) }
    }
    return {
      ok: true,
      json: async () => ({
        documents: [parseResult({ driveFileId: null, fileName: "drop.pdf" })],
      }),
    }
  })
  global.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

/** An uploaded PDF, dropped on the files screen. */
function dropUpload() {
  const zone = screen.getByText("Drop invoice PDFs or receipt photos here")
    .parentElement as HTMLElement
  fireEvent.drop(zone, {
    dataTransfer: {
      files: [new File(["%PDF"], "drop.pdf", { type: "application/pdf" })],
    },
  })
}

function Harness({ inbox = true }: { inbox?: boolean }) {
  const [open, setOpen] = React.useState(true)
  return (
    <ImportInvoicesDialog
      config={null}
      driveConnectHref={null}
      ingredientsStatus="ready"
      onRetryIngredients={() => {}}
      ingredients={INGREDIENTS}
      open={open}
      onOpenChange={setOpen}
      inbox={inbox}
      byok={false}
      aiKeyConfigured={false}
      aiKeyHint={null}
    />
  )
}

async function openReviewer(results: InvoiceParseResult[]) {
  loadReadyDriveDocuments.mockResolvedValue({
    documents: results.map((result) => readyDocument(result)),
    readyCount: results.length,
    unreadable: 0,
  })
  render(<Harness />)
  await screen.findByText(`1 of ${results.length}`)
}

const SECOND = parseResult({
  fileName: "baldor-9001.pdf",
  driveFileId: "drive-2",
  supplier: "baldor",
  supplierName: "Baldor",
  invoiceNumber: "9001",
  lines: [line({ match: { kind: "expense-only", note: null } })],
})

describe("an uploaded file is kept before the invoice is imported", () => {
  const realFetch = global.fetch

  beforeEach(() => {
    importInvoices.mockResolvedValue(IMPORT_RECEIPT)
  })

  // These are the only tests that stub fetch and the only ones that read the
  // import calls positionally, so both go back as they were.
  afterEach(() => {
    global.fetch = realFetch
    importInvoices.mockReset()
  })

  it("stores the bytes and imports under the key it got back", async () => {
    const fetchMock = mockRoutes()
    render(<Harness inbox={false} />)
    dropUpload()
    await screen.findByText("1 of 1")

    fireEvent.click(screen.getByRole("button", { name: "Import" }))

    await waitFor(() => expect(importInvoices).toHaveBeenCalled())
    expect(importInvoices.mock.calls[0][0].invoices[0].documentKey).toBe(
      "user-1/kept.pdf"
    )
    const store = fetchMock.mock.calls.find(([url]) =>
      String(url).startsWith("/api/invoices/document")
    ) as unknown as [string, RequestInit]
    const init = store[1]
    const headers = init.headers as Record<string, string>
    expect(init.method).toBe("POST")
    expect(headers["x-file-name"]).toBe("drop.pdf")
    expect(headers["content-type"]).toBe("application/pdf")
  })

  it("imports nothing when the file couldn't be kept", async () => {
    mockRoutes(true)
    render(<Harness inbox={false} />)
    dropUpload()
    await screen.findByText("1 of 1")

    fireEvent.click(screen.getByRole("button", { name: "Import" }))

    await screen.findByText("Couldn't keep the file — try again.")
    expect(importInvoices).not.toHaveBeenCalled()
  })

  it("keeps nothing for a receipt whose document is in the folder", async () => {
    const fetchMock = mockRoutes()
    await openReviewer([parseResult()])

    fireEvent.click(screen.getByRole("button", { name: "Import" }))

    await waitFor(() => expect(importInvoices).toHaveBeenCalled())
    expect(importInvoices.mock.calls[0][0].invoices[0].documentKey).toBeNull()
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).startsWith("/api/invoices/document")
      )
    ).toBe(false)
  })
})

describe("the reviewer imports one receipt at a time", () => {
  it("drops a decorated balance row from an already-read receipt", async () => {
    const purchase = line()
    const balance = line({
      position: 2,
      description: "**** BALANCE",
      itemKey: "desc:balance",
      lineAmountCents: 2159,
      match: { kind: "ignored" },
      raw: {
        ...purchase.raw,
        description: "**** BALANCE",
        quantity: null,
        unit: null,
        unitPrice: null,
        lineAmount: "21.59",
      },
    })
    await openReviewer([
      parseResult({
        lines: [purchase, balance],
        totalsMismatch:
          "Line items add up to $43.18 but the invoice total reads $21.59.",
      }),
    ])

    expect(screen.queryByText("**** BALANCE")).toBeNull()
    expect(screen.queryByText(/Line items add up/)).toBeNull()
  })

  it("imports the quantity corrected during review", async () => {
    importInvoices.mockResolvedValue(IMPORT_RECEIPT)
    await openReviewer([
      parseResult({
        lines: [line({ quantity: 20, unit: "EA", lineAmountCents: 598 })],
      }),
    ])

    const quantity = screen.getByRole("spinbutton", {
      name: "Quantity for BUTTER SALTED 24#",
    }) as HTMLInputElement
    expect(quantity.value).toBe("20")
    fireEvent.change(quantity, { target: { value: "2" } })

    fireEvent.click(screen.getByRole("button", { name: "Import" }))

    await waitFor(() => expect(importInvoices).toHaveBeenCalled())
    const importedLine = importInvoices.mock.calls[0][0].invoices[0].lines[0]
    expect(importedLine.quantity).toBe(2)
    expect(importedLine.sourcePayload.quantity).toBe("1")
  })

  it("sends the receipt on its own and moves on to the next", async () => {
    importInvoices.mockResolvedValue(IMPORT_RECEIPT)
    await openReviewer([parseResult(), SECOND])
    expect(screen.getByText("487155")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Import" }))

    await screen.findByText("1 of 1")
    const payload = importInvoices.mock.calls[0][0]
    expect(payload.invoices).toHaveLength(1)
    expect(payload.invoices[0].fileName).toBe("wegmans-487155.pdf")
    expect(payload.reviewedCurrencyCode).toBe("USD")
    expect(screen.getByText("9001")).toBeTruthy()
  })

  it("holds back only the receipt whose line amount is missing", async () => {
    await openReviewer([
      parseResult({ lines: [line({ lineAmountCents: null })] }),
      SECOND,
    ])

    expect(
      screen.getByText(
        "wegmans-487155.pdf: enter the missing line amounts before importing."
      )
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Import" }).hasAttribute("disabled")
    ).toBe(true)

    fireEvent.keyDown(document.body, { key: "ArrowRight" })

    await screen.findByText("2 of 2")
    expect(
      screen.getByRole("button", { name: "Import" }).hasAttribute("disabled")
    ).toBe(false)
  })

  it("pages one receipt at a time on the arrow keys", async () => {
    await openReviewer([parseResult(), SECOND, parseResult()])

    fireEvent.keyDown(document.body, { key: "ArrowRight" })
    await screen.findByText("2 of 3")

    fireEvent.keyDown(document.body, { key: "ArrowLeft" })
    await screen.findByText("1 of 3")
  })

  it("takes a skipped receipt out of the list and out of the folder", async () => {
    skipDriveFiles.mockResolvedValue({ skipped: 1 })
    await openReviewer([parseResult(), SECOND])

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
    expect(screen.queryByText("487155")).toBeNull()
  })

  it("refreshes the page behind once, when the last receipt has gone", async () => {
    importInvoices.mockResolvedValue(IMPORT_RECEIPT)
    await openReviewer([parseResult()])

    fireEvent.click(screen.getByRole("button", { name: "Import" }))

    await screen.findByText("1 invoice saved")
    expect(refresh).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Done" }))

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  })
})
