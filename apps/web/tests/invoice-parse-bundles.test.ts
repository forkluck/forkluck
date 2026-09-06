import { beforeEach, describe, expect, it, vi } from "vitest"

import type { InvoiceExtraction } from "@/lib/invoice-import"
import type { TemplateLine } from "@/lib/invoice-template"

import baldorInvoice from "./fixtures/invoices/baldor-invoice.json"

/**
 * One file, several supplier documents — a PDF holding two invoices, a photo
 * of two receipts. What is pinned here is the split itself: when the extra
 * detection call is paid for at all, which pages or pixels each document is
 * read from, the part each result carries, and that a line's box still names
 * the page of the whole file rather than of its slice.
 *
 * The template and the normalizer are the real ones; only the model calls and
 * the file readers are stubbed.
 */

vi.mock("server-only", () => ({}))
vi.mock("xlsx", () => ({ utils: {} }))

const djangoAction = vi.fn()
const extractPdfTextLines = vi.fn()
const extractWithEscalation = vi.fn()
const detectDocuments = vi.fn()
const prepareImage = vi.fn()
const cropImage = vi.fn()

vi.mock("@/lib/backend/queries", () => ({
  getAiCredential: () =>
    Promise.resolve({ configured: false, hint: null, key: null }),
  getBusinessSettings: () => Promise.resolve({ currencyCode: "USD" }),
  getDriveFolder: () => Promise.resolve({ folder: null, skipped: [] }),
}))
vi.mock("@/lib/backend/client", () => ({
  djangoAction: (slug: string, body: unknown) => djangoAction(slug, body),
}))
vi.mock("@/lib/pdf-text", () => ({
  extractPdfTextLines: (base64: string) => extractPdfTextLines(base64),
}))
vi.mock("@/lib/image-prep", () => ({
  prepareImage: (input: Buffer) => prepareImage(input),
  cropImage: (input: Buffer, region: unknown) => cropImage(input, region),
}))
vi.mock("@/lib/invoice-extract", () => ({
  // Forkluck's own engine throughout: no workspace key is involved in a split.
  extractionConfig: () => ({
    engine: "qwen",
    model: "test-model",
    escalationModel: "",
  }),
  extractWithEscalation: (
    file: unknown,
    categories: string[],
    options: unknown
  ) => extractWithEscalation(file, categories, options),
  detectDocuments: (input: unknown, options: unknown) =>
    detectDocuments(input, options),
}))

const { runInvoiceParse } = await import("@/lib/invoice-parse")

// --- A two-invoice PDF, in the text layer a real read would produce ---------

const PAGE = { width: 612, height: 792 }
const CHAR_WIDTH = 6

function line(
  page: number,
  index: number,
  ...items: Array<[number, string]>
): TemplateLine {
  const ordered = items.map(([x, text]) => ({
    x,
    width: text.length * CHAR_WIDTH,
    text,
  }))
  return {
    text: ordered.map((item) => item.text).join(" "),
    items: ordered,
    page,
    y: PAGE.height - 60 - index * 18,
    height: 10,
  }
}

/** One whole Baldor invoice, printed on the given page of the file. */
function baldorPage(page: number, number: string): TemplateLine[] {
  const rows: Array<Array<[number, string]>> = [
    [
      [40, "Please Mail Payment To:"],
      [400, "Baldor Specialty Foods Inc."],
    ],
    [
      [400, "Invoice"],
      [470, number],
    ],
    [
      [400, "Invoice Date"],
      [470, "1/2/2026"],
    ],
    [
      [40, "Ordered"],
      [80, "Shipped"],
      [120, "B.O."],
      [150, "U/M"],
      [190, "Item"],
      [260, "Item"],
      [285, "Description"],
      [430, "Origin"],
      [470, "Unit"],
      [490, "Price"],
      [540, "Extended Price"],
    ],
    [
      [45, "3"],
      [85, "3"],
      [150, "CS"],
      [190, "TEST-CARROT"],
      [260, "CARROTS"],
      [300, "BABY ORANGE"],
      [430, "USA"],
      [470, "24.50"],
      [540, "73.50"],
    ],
    [
      [400, "Invoice Total"],
      [540, "73.50"],
    ],
  ]
  return rows.map((items, index) => line(page, index, ...items))
}

const PDF_INPUT = {
  file: {
    kind: "pdf" as const,
    mediaType: "application/pdf" as const,
    base64: "cGRm",
  },
  fileName: "two-invoices.pdf",
  driveFileId: null,
  driveWebViewLink: null,
}

const PHOTO_INPUT = {
  file: {
    kind: "image" as const,
    mediaType: "image/jpeg" as const,
    base64: Buffer.from("photo").toString("base64"),
  },
  fileName: "IMG_1584.JPG",
  driveFileId: null,
  driveWebViewLink: null,
}

const RECEIPT = baldorInvoice as InvoiceExtraction

function read(model = "test-model") {
  return {
    extraction: RECEIPT,
    normalized: null,
    model,
    escalated: false,
    usage: { inputTokens: 1, outputTokens: 1 },
    pageSizes: [{ width: 1000, height: 800 }],
  }
}

beforeEach(() => {
  djangoAction.mockReset().mockResolvedValue({
    items: [],
    duplicate: false,
    categories: [{ id: "c1", name: "Produce" }],
  })
  extractPdfTextLines.mockReset()
  extractWithEscalation.mockReset()
  detectDocuments.mockReset()
  prepareImage.mockReset().mockResolvedValue({
    base64: Buffer.from("prepared").toString("base64"),
    mediaType: "image/jpeg",
    bytes: 8,
    width: 1000,
    height: 800,
  })
  cropImage.mockReset()
})

describe("a PDF holding two invoices", () => {
  beforeEach(() => {
    extractPdfTextLines.mockResolvedValue({
      scanned: false,
      pages: [
        baldorPage(0, "IV101-0000000001"),
        baldorPage(1, "IV101-0000000002"),
      ],
      pageSizes: [PAGE, PAGE],
    })
  })

  it("splits it into one result per invoice, each read for free", async () => {
    detectDocuments.mockResolvedValue({
      documents: [
        { pageStart: 0, pageEnd: 0 },
        { pageStart: 1, pageEnd: 1 },
      ],
    })

    const result = await runInvoiceParse(PDF_INPUT)

    expect(detectDocuments.mock.calls[0][0]).toMatchObject({ kind: "pdf-text" })
    // The template read each invoice on its own; no model was paid to extract.
    expect(extractWithEscalation).not.toHaveBeenCalled()
    if ("error" in result) throw new Error(result.error)
    expect(result.documents).toHaveLength(2)
    expect(result.documents.map((document) => document.part)).toEqual([
      { part: 0, pages: { start: 0, end: 0 }, region: null },
      { part: 1, pages: { start: 1, end: 1 }, region: null },
    ])
    expect(result.documents.map((document) => document.invoiceNumber)).toEqual([
      "IV101-0000000001",
      "IV101-0000000002",
    ])
    // A box names the page of the file, not of the slice it was read from.
    expect(result.documents[0].lines[0].box?.page).toBe(0)
    expect(result.documents[1].lines[0].box?.page).toBe(1)
  })

  it("reads a range the template can't as one model call for those pages", async () => {
    extractPdfTextLines.mockResolvedValue({
      scanned: false,
      pages: [
        baldorPage(0, "IV101-0000000001"),
        // A second supplier's invoice the template knows nothing about — and
        // whose own total is what stops the whole file reading as one.
        [
          line(1, 0, [40, "Sysco Metro NY"]),
          line(1, 1, [400, "Invoice Total"], [540, "99.99"]),
        ],
      ],
      pageSizes: [PAGE, PAGE],
    })
    detectDocuments.mockResolvedValue({
      documents: [
        { pageStart: 0, pageEnd: 0 },
        { pageStart: 1, pageEnd: 1 },
      ],
    })
    extractWithEscalation.mockResolvedValue(read())

    const result = await runInvoiceParse(PDF_INPUT)

    expect(extractWithEscalation).toHaveBeenCalledTimes(1)
    expect(extractWithEscalation.mock.calls[0][2]).toMatchObject({
      pages: { start: 1, end: 1 },
    })
    if ("error" in result) throw new Error(result.error)
    expect(result.documents).toHaveLength(2)
  })

  it("reads the whole file, and never asks a model to split it, when the free read works", async () => {
    extractPdfTextLines.mockResolvedValue({
      scanned: false,
      pages: [baldorPage(0, "IV101-0000000001")],
      pageSizes: [PAGE],
    })

    const result = await runInvoiceParse(PDF_INPUT)

    expect(detectDocuments).not.toHaveBeenCalled()
    if ("error" in result) throw new Error(result.error)
    expect(result.documents).toHaveLength(1)
    expect(result.documents[0].part).toEqual({
      part: 0,
      pages: null,
      region: null,
    })
  })

  it("reads one detected document exactly as it read a whole file before", async () => {
    detectDocuments.mockResolvedValue({
      documents: [{ pageStart: 0, pageEnd: 1 }],
    })
    extractWithEscalation.mockResolvedValue(read())

    const result = await runInvoiceParse(PDF_INPUT)

    // No page range: the model is shown the file, and the four-page refusal
    // applies to it whole.
    expect(extractWithEscalation.mock.calls[0][2]).toEqual({
      engine: "qwen",
      model: "test-model",
      apiKey: null,
      budget: {
        beforeCall: expect.any(Function),
        record: expect.any(Function),
      },
    })
    if ("error" in result) throw new Error(result.error)
    expect(result.documents[0].part).toEqual({
      part: 0,
      pages: null,
      region: null,
    })
  })

  it("says how many documents it saw when a scan can't be split", async () => {
    extractPdfTextLines.mockResolvedValue({
      scanned: true,
      pages: [[], []],
      pageSizes: [PAGE, PAGE],
    })
    detectDocuments.mockResolvedValue({ documents: [] })
    extractWithEscalation.mockResolvedValue({
      error: "This file doesn't look like a supplier invoice: 15 receipts.",
      notUsable: "This scan holds 15 receipts.",
    })

    expect(await runInvoiceParse(PDF_INPUT)).toEqual({
      error:
        "This scan holds 15 receipts and they could not be separated — save one file per receipt.",
    })
  })
})

describe("a photo of several receipts", () => {
  beforeEach(() => {
    extractPdfTextLines.mockRejectedValue(new Error("not a PDF"))
  })

  it("only pays to split a photo the reader itself refused as a bundle", async () => {
    extractWithEscalation.mockResolvedValue(read())

    const result = await runInvoiceParse(PHOTO_INPUT)

    expect(detectDocuments).not.toHaveBeenCalled()
    if ("error" in result) throw new Error(result.error)
    expect(result.documents).toHaveLength(1)
  })

  it("crops each detected receipt out of the prepared photo and reads it", async () => {
    extractWithEscalation
      .mockResolvedValueOnce({
        error: "This file doesn't look like a supplier invoice: 2 receipts.",
        notUsable: "This photo shows 2 separate receipts.",
      })
      .mockResolvedValue(read())
    detectDocuments.mockResolvedValue({
      documents: [
        { region: { x0: 0, y0: 0, x1: 0.5, y1: 1 } },
        { region: { x0: 0.5, y0: 0, x1: 1, y1: 1 } },
      ],
    })
    cropImage.mockImplementation((_input: Buffer, region: { x0: number }) => ({
      base64: Buffer.from(`crop-${region.x0}`).toString("base64"),
      mediaType: "image/jpeg",
      bytes: 6,
      width: 500,
      height: 800,
    }))

    const result = await runInvoiceParse(PHOTO_INPUT)

    // The fractions are of the prepared pixels — what the model saw.
    expect(cropImage.mock.calls[0][0]).toEqual(Buffer.from("prepared"))
    expect(extractWithEscalation.mock.calls[1][0]).toEqual({
      kind: "image",
      mediaType: "image/jpeg",
      base64: Buffer.from("crop-0").toString("base64"),
      size: { width: 500, height: 800 },
    })
    if ("error" in result) throw new Error(result.error)
    expect(result.documents.map((document) => document.part)).toEqual([
      { part: 0, pages: null, region: { x0: 0, y0: 0, x1: 0.5, y1: 1 } },
      { part: 1, pages: null, region: { x0: 0.5, y0: 0, x1: 1, y1: 1 } },
    ])
  })

  it("tells the cook what to do when the receipts can't be separated", async () => {
    extractWithEscalation.mockResolvedValue({
      error: "This file doesn't look like a supplier invoice: 3 receipts.",
      notUsable: "This photo shows 3 receipts.",
    })
    detectDocuments.mockResolvedValue({ documents: [] })

    expect(await runInvoiceParse(PHOTO_INPUT)).toEqual({
      error:
        "This photo shows 3 receipts and they could not be separated — take one photo per receipt.",
    })
  })

  it("refuses rather than import one receipt twice when both regions are the same", async () => {
    // What qwen3-vl-plus actually answered for a photo of one receipt.
    extractWithEscalation.mockResolvedValue({
      error: "This file doesn't look like a supplier invoice: 2 receipts.",
      notUsable: "This photo shows 2 receipts.",
    })
    detectDocuments.mockResolvedValue({
      documents: [
        { region: { x0: 0.02, y0: 0.08, x1: 0.87, y1: 0.89 } },
        { region: { x0: 0.02, y0: 0.08, x1: 0.87, y1: 0.89 } },
      ],
    })

    expect(await runInvoiceParse(PHOTO_INPUT)).toEqual({
      error:
        "This photo shows 2 receipts and they could not be separated — take one photo per receipt.",
    })
    expect(cropImage).not.toHaveBeenCalled()
  })

  it("keeps a refusal that splitting would not fix", async () => {
    extractWithEscalation.mockResolvedValue({
      error:
        "This file doesn't look like a supplier invoice: this is a restaurant menu.",
      notUsable: "this is a restaurant menu",
    })

    expect(await runInvoiceParse(PHOTO_INPUT)).toEqual({
      error:
        "This file doesn't look like a supplier invoice: this is a restaurant menu.",
    })
    expect(detectDocuments).not.toHaveBeenCalled()
  })

  it("keeps the receipts it could read when one of them fails", async () => {
    extractWithEscalation
      .mockResolvedValueOnce({
        error: "This file doesn't look like a supplier invoice: 2 receipts.",
        notUsable: "This photo shows 2 receipts.",
      })
      .mockResolvedValueOnce(read())
      .mockResolvedValueOnce({ error: "Extraction failed — try again." })
    detectDocuments.mockResolvedValue({
      documents: [
        { region: { x0: 0, y0: 0, x1: 0.5, y1: 1 } },
        { region: { x0: 0.5, y0: 0, x1: 1, y1: 1 } },
      ],
    })
    cropImage.mockResolvedValue({
      base64: "Y3JvcA==",
      mediaType: "image/jpeg",
      bytes: 4,
      width: 500,
      height: 800,
    })

    const result = await runInvoiceParse(PHOTO_INPUT)

    if ("error" in result) throw new Error(result.error)
    expect(result.documents).toHaveLength(1)
    expect(result.documents[0].part.part).toBe(0)
  })
})
