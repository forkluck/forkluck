import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const backend = {
  getDriveFilesForWorkspace: vi.fn(),
  probeInvoiceLinesForWorkspace: vi.fn(),
  saveDriveExtraction: vi.fn(),
  failDriveExtraction: vi.fn(),
}
const parse = {
  fetchDriveFileForExtraction: vi.fn(),
  prepareExtractionImage: vi.fn(),
  readWithoutAi: vi.fn(),
}
const extract = {
  extractWithEscalation: vi.fn(),
  extractionConfig: vi.fn(),
  detectDocuments: vi.fn(),
}
const cropImage = vi.fn()

vi.mock("@/lib/backend/queries", () => ({
  getDriveFilesForWorkspace: (...args: unknown[]) =>
    backend.getDriveFilesForWorkspace(...args),
  probeInvoiceLinesForWorkspace: (...args: unknown[]) =>
    backend.probeInvoiceLinesForWorkspace(...args),
  saveDriveExtraction: (body: unknown) => backend.saveDriveExtraction(body),
  failDriveExtraction: (body: unknown) => backend.failDriveExtraction(body),
}))
// The bundle reader itself (readDocumentParts, normalizeDocumentRead) is the
// real one — it is the same implementation the attended path uses, and what
// the model answers is stubbed below. Only the file readers are replaced.
vi.mock("@/lib/invoice-parse", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/invoice-parse")>()),
  fetchDriveFileForExtraction: (...args: unknown[]) =>
    parse.fetchDriveFileForExtraction(...args),
  prepareExtractionImage: (file: unknown) => parse.prepareExtractionImage(file),
  readWithoutAi: (file: unknown) => parse.readWithoutAi(file),
}))
vi.mock("@/lib/invoice-extract", () => ({
  extractWithEscalation: (...args: unknown[]) =>
    extract.extractWithEscalation(...args),
  extractionConfig: () => extract.extractionConfig(),
  detectDocuments: (...args: unknown[]) => extract.detectDocuments(...args),
}))
vi.mock("@/lib/image-prep", () => ({
  cropImage: (...args: unknown[]) => cropImage(...args),
}))

import { readNewDriveFiles } from "@/lib/drive-read"
import { DriveServiceError } from "@/lib/google-drive-service"
import { InvoiceAiBudgetError } from "@/lib/invoice-ai-usage"
import type { InvoiceExtraction } from "@/lib/invoice-import"

const FOLDERS = [
  {
    userId: "user-a",
    folderId: "folder-a",
    folderName: "Receipts",
    registeredAt: "2026-08-01T00:00:00Z",
  },
]

function row(driveFileId: string) {
  return {
    driveFileId,
    name: `${driveFileId}.pdf`,
    mimeType: "application/pdf",
    sizeBytes: 1000,
    modifiedTime: "2026-08-01T00:00:00Z",
    webViewLink: `https://drive.example/${driveFileId}`,
    folderPath: "Receipts",
    status: "new" as const,
    reason: "",
    invoiceId: null,
    seenAt: "2026-08-01T00:00:00Z",
    parts: [],
  }
}

const EXTRACTION: InvoiceExtraction = {
  supplierName: "Baldor",
  documentType: "invoice",
  invoiceNumber: "IV101-1",
  invoiceDate: "2026-01-02",
  totalAmount: "12.98",
  currency: null,
  otherChargesAmount: null,
  dueDate: null,
  subtotalAmount: null,
  taxAmount: null,
  lines: [],
  notUsable: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  extract.extractionConfig.mockReturnValue({
    engine: "qwen",
    model: "qwen3-vl-plus",
    escalationModel: "qwen3-vl-plus",
  })
  backend.getDriveFilesForWorkspace.mockResolvedValue({
    files: [row("file-1")],
    count: 1,
  })
  parse.fetchDriveFileForExtraction.mockResolvedValue({
    kind: "pdf",
    mediaType: "application/pdf",
    base64: "AAAA",
  })
  backend.probeInvoiceLinesForWorkspace.mockResolvedValue({
    items: [],
    duplicate: false,
    driveFileKnown: false,
    categories: [{ id: "cat-1", name: "Produce" }],
    currencyCode: "USD",
  })
  parse.readWithoutAi.mockResolvedValue({
    extraction: null,
    scanned: false,
    pages: [[]],
    pageSizes: [{ width: 612, height: 792 }],
  })
  extract.detectDocuments.mockResolvedValue({ documents: [] })
  cropImage.mockResolvedValue({
    base64: "CROP",
    mediaType: "image/jpeg",
    width: 800,
    height: 600,
  })
  extract.extractWithEscalation.mockResolvedValue({
    extraction: EXTRACTION,
    model: "qwen3-vl-plus",
    escalated: false,
  })
  backend.saveDriveExtraction.mockResolvedValue({ ok: true, readyCount: 1 })
  backend.failDriveExtraction.mockResolvedValue({ ok: true })
})

describe("readNewDriveFiles", () => {
  it("leaves budget-blocked files new rather than recording failed extractions", async () => {
    extract.extractWithEscalation.mockRejectedValue(
      new InvoiceAiBudgetError("At limit", true)
    )
    expect(await readNewDriveFiles({ folders: FOLDERS })).toEqual({
      read: 0,
      failed: 0,
      skipped: 1,
    })
    expect(backend.failDriveExtraction).not.toHaveBeenCalled()
    expect(backend.saveDriveExtraction).not.toHaveBeenCalled()
    expect(extract.extractWithEscalation.mock.calls[0][2].budget).toMatchObject(
      { beforeCall: expect.any(Function), record: expect.any(Function) }
    )
  })
  it("reads the oldest new files, up to the per-run cap", async () => {
    backend.getDriveFilesForWorkspace.mockResolvedValue({
      files: [row("file-1"), row("file-2")],
      count: 9,
    })

    const counts = await readNewDriveFiles({ folders: FOLDERS, perRun: 2 })

    expect(counts).toEqual({ read: 2, failed: 0, skipped: 0 })
    // Django orders `new` oldest-first; the cap travels with the request.
    expect(backend.getDriveFilesForWorkspace).toHaveBeenCalledWith(
      "user-a",
      "new",
      2
    )
    expect(backend.saveDriveExtraction.mock.calls[0][0]).toMatchObject({
      userId: "user-a",
      driveFileId: "file-1",
      parts: [
        {
          part: 0,
          pageStart: null,
          pageEnd: null,
          region: null,
          model: "qwen3-vl-plus",
          escalated: false,
          document: {
            supplierName: "Baldor",
            fileName: "file-1.pdf",
            driveWebViewLink: "https://drive.example/file-1",
            extractionModel: "qwen3-vl-plus",
          },
        },
      ],
    })
  })

  it("reads nothing on the bring-your-own-key engine", async () => {
    extract.extractionConfig.mockReturnValue({
      engine: "anthropic",
      model: "claude-opus-5",
      escalationModel: "claude-opus-5",
    })

    expect(await readNewDriveFiles({ folders: FOLDERS })).toEqual({
      read: 0,
      failed: 0,
      skipped: 0,
    })
    expect(backend.getDriveFilesForWorkspace).not.toHaveBeenCalled()
  })

  it("skips a workspace whose folder has never been listed in full", async () => {
    await readNewDriveFiles({
      folders: [{ ...FOLDERS[0], registeredAt: null }],
    })

    expect(backend.getDriveFilesForWorkspace).not.toHaveBeenCalled()
  })

  it("reads a digital invoice the template knows without paying the model", async () => {
    parse.readWithoutAi.mockResolvedValue({
      extraction: EXTRACTION,
      scanned: false,
      pages: [[]],
      pageSizes: [{ width: 612, height: 792 }],
    })

    const counts = await readNewDriveFiles({ folders: FOLDERS })

    expect(counts).toEqual({ read: 1, failed: 0, skipped: 0 })
    expect(extract.extractWithEscalation).not.toHaveBeenCalled()
    expect(backend.saveDriveExtraction.mock.calls[0][0].parts).toMatchObject([
      { part: 0, model: "text-layer", escalated: false },
    ])
  })

  it("stops on a document the free read refuses, without paying the model", async () => {
    parse.readWithoutAi.mockResolvedValue({
      error: "That file isn't a readable PDF.",
    })

    const counts = await readNewDriveFiles({ folders: FOLDERS })

    expect(counts).toEqual({ read: 0, failed: 1, skipped: 0 })
    expect(extract.extractWithEscalation).not.toHaveBeenCalled()
  })

  it("fails a file that has already become an invoice, before paying to read it", async () => {
    backend.probeInvoiceLinesForWorkspace.mockResolvedValue({
      items: [],
      duplicate: false,
      driveFileKnown: true,
      categories: [],
      currencyCode: "USD",
    })

    const counts = await readNewDriveFiles({ folders: FOLDERS })

    expect(counts).toEqual({ read: 0, failed: 1, skipped: 0 })
    expect(extract.extractWithEscalation).not.toHaveBeenCalled()
    expect(backend.failDriveExtraction).toHaveBeenCalledWith({
      userId: "user-a",
      driveFileId: "file-1",
      reason: "Already imported",
    })
  })

  it("fails a document the model says is not an invoice, in its own words", async () => {
    extract.extractWithEscalation.mockResolvedValue({
      extraction: { ...EXTRACTION, notUsable: "this is a menu" },
      model: "qwen3-vl-plus",
      escalated: false,
    })

    const counts = await readNewDriveFiles({ folders: FOLDERS })

    expect(counts).toEqual({ read: 0, failed: 1, skipped: 0 })
    expect(backend.failDriveExtraction.mock.calls[0][0].reason).toContain(
      "this is a menu"
    )
    expect(backend.saveDriveExtraction).not.toHaveBeenCalled()
  })

  it("fails a thrown read with a short reason and keeps going", async () => {
    backend.getDriveFilesForWorkspace.mockResolvedValue({
      files: [row("file-1"), row("file-2")],
      count: 2,
    })
    parse.fetchDriveFileForExtraction
      .mockRejectedValueOnce(new DriveServiceError("That file is too large."))
      .mockResolvedValue({
        kind: "pdf",
        mediaType: "application/pdf",
        base64: "AAAA",
      })

    const counts = await readNewDriveFiles({ folders: FOLDERS })

    expect(counts).toEqual({ read: 1, failed: 1, skipped: 0 })
    expect(backend.failDriveExtraction).toHaveBeenCalledWith({
      userId: "user-a",
      driveFileId: "file-1",
      reason: "That file is too large.",
    })
  })

  it("stores a part per receipt in a scanned bundle", async () => {
    parse.readWithoutAi.mockResolvedValue({
      extraction: null,
      scanned: true,
      pages: [],
      pageSizes: [
        { width: 612, height: 792 },
        { width: 612, height: 792 },
        { width: 612, height: 792 },
      ],
    })
    extract.detectDocuments.mockResolvedValue({
      documents: [
        { pageStart: 0, pageEnd: 0 },
        { pageStart: 1, pageEnd: 2 },
      ],
    })

    const counts = await readNewDriveFiles({ folders: FOLDERS })

    // One file, two receipts: the run counts documents, and the cap counted
    // the file.
    expect(counts).toEqual({ read: 2, failed: 0, skipped: 0 })
    // Each part is read on its own pages, never the whole bundle at once.
    expect(
      extract.extractWithEscalation.mock.calls.map((call) => call[2].pages)
    ).toEqual([
      { start: 0, end: 0 },
      { start: 1, end: 2 },
    ])
    expect(backend.saveDriveExtraction.mock.calls[0][0].parts).toMatchObject([
      { part: 0, pageStart: 0, pageEnd: 0, region: null },
      { part: 1, pageStart: 1, pageEnd: 2, region: null },
    ])
  })

  it("splits a photo the reader refused as a bundle into its regions", async () => {
    parse.fetchDriveFileForExtraction.mockResolvedValue({
      kind: "image",
      mediaType: "image/jpeg",
      base64: "AAAA",
    })
    parse.prepareExtractionImage.mockResolvedValue({
      kind: "image",
      mediaType: "image/jpeg",
      base64: "AAAA",
      size: { width: 2000, height: 1500 },
    })
    parse.readWithoutAi.mockResolvedValue({
      extraction: null,
      scanned: false,
      pages: [],
      pageSizes: [],
    })
    extract.extractWithEscalation
      .mockResolvedValueOnce({
        error: "This file doesn't look like a supplier invoice: two receipts",
        notUsable: "two receipts",
      })
      .mockResolvedValue({
        extraction: EXTRACTION,
        model: "qwen3-vl-plus",
        escalated: false,
      })
    const regions = [
      { x0: 0, y0: 0, x1: 1, y1: 0.5 },
      { x0: 0, y0: 0.5, x1: 1, y1: 1 },
    ]
    extract.detectDocuments.mockResolvedValue({
      documents: regions.map((region) => ({ region })),
    })

    const counts = await readNewDriveFiles({ folders: FOLDERS })

    expect(counts).toEqual({ read: 2, failed: 0, skipped: 0 })
    expect(cropImage).toHaveBeenCalledTimes(2)
    expect(backend.saveDriveExtraction.mock.calls[0][0].parts).toMatchObject([
      { part: 0, pageStart: null, pageEnd: null, region: regions[0] },
      { part: 1, pageStart: null, pageEnd: null, region: regions[1] },
    ])
  })

  it("keeps refusing a photo of several receipts it cannot separate", async () => {
    parse.fetchDriveFileForExtraction.mockResolvedValue({
      kind: "image",
      mediaType: "image/jpeg",
      base64: "AAAA",
    })
    parse.prepareExtractionImage.mockResolvedValue({
      kind: "image",
      mediaType: "image/jpeg",
      base64: "AAAA",
      size: { width: 2000, height: 1500 },
    })
    parse.readWithoutAi.mockResolvedValue({
      extraction: null,
      scanned: false,
      pages: [],
      pageSizes: [],
    })
    extract.extractWithEscalation.mockResolvedValue({
      error: "This file doesn't look like a supplier invoice: three receipts",
      notUsable: "three receipts",
    })

    const counts = await readNewDriveFiles({ folders: FOLDERS })

    expect(counts).toEqual({ read: 0, failed: 1, skipped: 0 })
    expect(backend.failDriveExtraction.mock.calls[0][0].reason).toBe(
      "This photo shows 3 receipts and they could not be separated — take one photo per receipt."
    )
  })

  it("stops starting files once the budget is spent", async () => {
    backend.getDriveFilesForWorkspace.mockResolvedValue({
      files: [row("file-1"), row("file-2"), row("file-3")],
      count: 3,
    })
    // One slow read is enough to spend a one-millisecond budget.
    extract.extractWithEscalation.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return {
        extraction: EXTRACTION,
        model: "qwen3-vl-plus",
        escalated: false,
      }
    })

    const counts = await readNewDriveFiles({ folders: FOLDERS, budgetMs: 1 })

    expect(counts).toEqual({ read: 1, failed: 0, skipped: 2 })
  })
})
