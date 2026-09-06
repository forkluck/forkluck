import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/auth-session", () => ({
  requireUser: () => Promise.resolve({ id: "user_1" }),
  getSession: () =>
    Promise.resolve({ billing: { entitlements: { invoiceAi: true } } }),
}))
vi.mock("@/lib/drive-watch", () => ({
  runDriveWatch: vi.fn(),
  startDriveRead: vi.fn(),
}))
vi.mock("@/lib/invoice-extract", () => ({ verifyAnthropicKey: vi.fn() }))

const getDriveFiles = vi.fn()
const probeInvoiceLines = vi.fn()
vi.mock("@/lib/backend/queries", () => ({
  getDriveFiles: (status: string, limit?: number) =>
    getDriveFiles(status, limit),
  getDriveFolder: vi.fn(),
  getConnectorSyncRun: vi.fn(),
}))
vi.mock("@/lib/invoice-parse", () => ({
  probeInvoiceLines: (...args: unknown[]) => probeInvoiceLines(...args),
}))

const { loadReadyDriveDocuments } = await import("@/app/(app)/invoices/actions")

function storedDocument() {
  return {
    supplier: "baldor",
    supplierName: "Baldor",
    documentType: "invoice",
    invoiceNumber: "IV101-1",
    invoiceDate: "2026-01-02",
    currency: null,
    totalCents: 1298,
    totalsMismatch: null,
    headerWarnings: [],
    lines: [
      {
        position: 1,
        sku: "A1",
        itemKey: "a1",
        description: "Carrots",
        quantity: 2,
        unit: "CS",
        packSize: "10 LB",
        unitPriceCents: 649,
        lineAmountCents: 1298,
        suggestedCategory: "Produce",
        uncertain: false,
        reason: null,
        raw: {
          lineNumber: 1,
          sku: "A1",
          description: "Carrots",
          quantity: "2",
          unit: "CS",
          packSize: "10 LB",
          unitPrice: "6.49",
          lineAmount: "12.98",
          suggestedCategory: "Produce",
          uncertain: false,
          uncertainReason: null,
        },
      },
    ],
    fileName: "baldor.pdf",
    driveWebViewLink: "https://drive.example/file-1",
    extractionModel: "qwen3-vl-plus",
    escalated: false,
  }
}

function part(document: unknown, patch: Record<string, unknown> = {}) {
  return {
    id: "part-1",
    part: 0,
    pageStart: null,
    pageEnd: null,
    region: null,
    status: "ready" as const,
    document,
    model: "qwen3-vl-plus",
    escalated: false,
    extractedAt: "2026-08-01T01:00:00Z",
    ...patch,
  }
}

function readyRow(...parts: ReturnType<typeof part>[]) {
  return {
    driveFileId: "file-1",
    name: "baldor.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1000,
    modifiedTime: "2026-08-01T00:00:00Z",
    webViewLink: "https://drive.example/file-1",
    folderPath: "Receipts",
    status: "ready" as const,
    reason: "",
    invoiceId: null,
    seenAt: "2026-08-01T00:00:00Z",
    parts,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  probeInvoiceLines.mockResolvedValue({
    items: [],
    duplicate: false,
    categories: [{ id: "cat-1", name: "Produce" }],
  })
})

describe("loadReadyDriveDocuments", () => {
  it("builds a review block per stored read, on a fresh probe", async () => {
    getDriveFiles.mockResolvedValue({
      files: [readyRow(part(storedDocument()))],
      count: 34,
    })

    const result = await loadReadyDriveDocuments()

    expect(getDriveFiles).toHaveBeenCalledWith("ready", 40)
    if ("error" in result) throw new Error(result.error)
    expect(result).toMatchObject({ readyCount: 34, unreadable: 0 })
    expect(result.documents).toHaveLength(1)
    expect(result.documents[0]).toMatchObject({
      mimeType: "application/pdf",
      result: {
        fileName: "baldor.pdf",
        driveFileId: "file-1",
        driveWebViewLink: "https://drive.example/file-1",
        extractionModel: "qwen3-vl-plus",
        supplierName: "Baldor",
        totalCents: 1298,
      },
    })
    expect(result.documents[0].result.lines).toHaveLength(1)
    // The categories come from the probe run now, not from whatever the
    // workspace looked like when the watcher read the file.
    expect(result.documents[0].result.categories).toEqual([
      { id: "cat-1", name: "Produce" },
    ])
    expect(probeInvoiceLines.mock.calls[0][1]).toBe("file-1")
  })

  it("seeds a block per ready part of a bundle and leaves a decided one out", async () => {
    getDriveFiles.mockResolvedValue({
      files: [
        readyRow(
          part(storedDocument(), { id: "part-a", part: 0, status: "imported" }),
          part(storedDocument(), {
            id: "part-b",
            part: 1,
            pageStart: 1,
            pageEnd: 2,
          }),
          part(storedDocument(), {
            id: "part-c",
            part: 2,
            region: { x0: 0, y0: 0.5, x1: 1, y1: 1 },
          })
        ),
      ],
      count: 1,
    })

    const result = await loadReadyDriveDocuments()

    if ("error" in result) throw new Error(result.error)
    // The imported part has been decided on; only the two still ready are
    // offered, each carrying where in the file it was read from.
    expect(result.documents.map((document) => document.result.part)).toEqual([
      { part: 1, pages: { start: 1, end: 2 }, region: null },
      { part: 2, pages: null, region: { x0: 0, y0: 0.5, x1: 1, y1: 1 } },
    ])
    expect(result.unreadable).toBe(0)
  })

  it("reports a stored read it no longer recognizes instead of throwing", async () => {
    const broken = storedDocument()
    // A line the current shape cannot read: the whole row is unusable.
    broken.lines[0].raw.lineNumber = "one" as never
    getDriveFiles.mockResolvedValue({
      files: [readyRow(part(broken)), readyRow(part(storedDocument()))],
      count: 2,
    })

    const result = await loadReadyDriveDocuments()

    if ("error" in result) throw new Error(result.error)
    expect(result.documents).toHaveLength(1)
    expect(result.unreadable).toBe(1)
  })
})
