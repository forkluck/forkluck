import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The photo path through `runInvoiceParse`.
 *
 * A receipt photo has no text layer and no supplier template to try, so it
 * must never touch `extractPdfTextLines` — unpdf would refuse the bytes and
 * the user would be told their photo "isn't a readable PDF". It goes through
 * `prepareImage` (upright, downscaled) and then to the AI — Forkluck's own by
 * default, or the workspace's key on the opt-in `anthropic` engine.
 */

vi.mock("server-only", () => ({}))
// Reached only through `import-limits`; nothing on this path reads a workbook.
vi.mock("xlsx", () => ({ utils: {} }))

const getAiCredential = vi.fn()
const djangoAction = vi.fn()
const extractPdfTextLines = vi.fn()
const extractWithEscalation = vi.fn()
const prepareImage = vi.fn()
const fetchDriveFileBytes = vi.fn()
const assertFileInFolder = vi.fn()
const getDriveFolder = vi.fn()

vi.mock("@/lib/backend/queries", () => ({
  getAiCredential: () => getAiCredential(),
  getBusinessSettings: () => Promise.resolve({ currencyCode: "USD" }),
  getDriveFolder: () => getDriveFolder(),
}))
vi.mock("@/lib/backend/client", () => ({
  djangoAction: (slug: string, body: unknown) => djangoAction(slug, body),
}))
vi.mock("@/lib/google-drive-service", () => ({
  DriveServiceError: class DriveServiceError extends Error {},
  assertFileInFolder: (fileId: string, folderId: string) =>
    assertFileInFolder(fileId, folderId),
  fetchDriveFileBytes: (fileId: string, maxBytes: unknown) =>
    fetchDriveFileBytes(fileId, maxBytes),
}))
vi.mock("@/lib/pdf-text", () => ({
  extractPdfTextLines: (base64: string) => extractPdfTextLines(base64),
}))
vi.mock("@/lib/image-prep", () => ({
  prepareImage: (input: Buffer) => prepareImage(input),
}))
// The engine each case runs on; only `anthropic` reads a workspace key.
let engine: "anthropic" | "qwen" = "anthropic"

vi.mock("@/lib/invoice-extract", () => ({
  extractionConfig: () => ({
    engine,
    model: "test-model",
    escalationModel: "",
  }),
  extractWithEscalation: (
    file: unknown,
    categories: string[],
    options: unknown
  ) => extractWithEscalation(file, categories, options),
}))

const { runInvoiceParse } = await import("@/lib/invoice-parse")
const { DRIVE_MAX_IMAGE_BYTES, DRIVE_MAX_PDF_BYTES } =
  await import("@/lib/drive-folder")

const PHOTO_BYTES = Buffer.from("original-photo-bytes")

const PHOTO = {
  file: {
    kind: "image" as const,
    mediaType: "image/jpeg" as const,
    base64: PHOTO_BYTES.toString("base64"),
  },
  fileName: "IMG_1584.JPG",
  driveFileId: null,
  driveWebViewLink: null,
}

const KEY = { configured: true, hint: "1234", key: "sk-ant-test-key-1234" }

beforeEach(() => {
  engine = "anthropic"
  getAiCredential.mockReset().mockResolvedValue(KEY)
  djangoAction.mockReset().mockResolvedValue({
    items: [],
    duplicate: false,
    categories: [{ id: "c1", name: "Produce" }],
  })
  extractPdfTextLines.mockReset()
  extractWithEscalation.mockReset().mockResolvedValue({ error: "AI declined" })
  prepareImage.mockReset().mockResolvedValue({
    base64: "cHJlcGFyZWQ=",
    mediaType: "image/jpeg",
    bytes: 9,
    width: 1200,
    height: 1600,
  })
  fetchDriveFileBytes.mockReset()
  assertFileInFolder.mockReset()
  getDriveFolder.mockReset().mockResolvedValue({ folder: null, skipped: [] })
})

describe("runInvoiceParse on photos", () => {
  it("prepares the image and extracts it without touching the PDF path", async () => {
    const result = await runInvoiceParse(PHOTO)

    expect(extractPdfTextLines).not.toHaveBeenCalled()
    expect(prepareImage).toHaveBeenCalledWith(PHOTO_BYTES)
    expect(extractWithEscalation).toHaveBeenCalledWith(
      {
        kind: "image",
        mediaType: "image/jpeg",
        base64: "cHJlcGFyZWQ=",
        // The prepared pixels the model reads: also what a box is a fraction of.
        size: { width: 1200, height: 1600 },
      },
      ["Produce"],
      {
        engine: "anthropic",
        model: "test-model",
        apiKey: "sk-ant-test-key-1234",
      }
    )
    expect(result).toEqual({ error: "AI declined" })
  })

  it("reads a photo on Forkluck's own engine with no key at all", async () => {
    engine = "qwen"
    getAiCredential.mockResolvedValue({
      configured: false,
      hint: null,
      key: null,
    })

    const result = await runInvoiceParse(PHOTO)

    expect(getAiCredential).not.toHaveBeenCalled()
    expect(extractWithEscalation).toHaveBeenCalledWith(
      {
        kind: "image",
        mediaType: "image/jpeg",
        base64: "cHJlcGFyZWQ=",
        // The prepared pixels the model reads: also what a box is a fraction of.
        size: { width: 1200, height: 1600 },
      },
      ["Produce"],
      {
        engine: "qwen",
        model: "test-model",
        apiKey: null,
        budget: {
          beforeCall: expect.any(Function),
          record: expect.any(Function),
        },
      }
    )
    expect(result).toEqual({ error: "AI declined" })
  })

  it("asks for a key in the photo's own words on the BYOK engine", async () => {
    getAiCredential.mockResolvedValue({
      configured: false,
      hint: null,
      key: null,
    })

    const result = await runInvoiceParse(PHOTO)

    expect(result).toEqual({
      error:
        "Photos and scans need AI reading — connect an AI key (optional) to import them.",
    })
    expect(extractPdfTextLines).not.toHaveBeenCalled()
    expect(extractWithEscalation).not.toHaveBeenCalled()
  })

  it("caps a Drive file by the kind Drive reports", async () => {
    getDriveFolder.mockResolvedValue({
      folder: { folderId: "folder-1", folderName: "kitchen-receipts" },
      skipped: [],
    })
    fetchDriveFileBytes.mockResolvedValue({
      base64: PHOTO_BYTES.toString("base64"),
      mimeType: "image/jpeg",
      bytes: PHOTO_BYTES.byteLength,
    })

    await runInvoiceParse({
      file: null,
      fileName: "IMG_1584.JPG",
      driveFileId: "drive-1",
      driveWebViewLink: null,
    })

    expect(assertFileInFolder).toHaveBeenCalledWith("drive-1", "folder-1")
    const maxBytes = fetchDriveFileBytes.mock.calls[0][1] as (
      mimeType: string
    ) => number
    expect(maxBytes("image/jpeg")).toBe(DRIVE_MAX_IMAGE_BYTES)
    expect(maxBytes("application/pdf")).toBe(DRIVE_MAX_PDF_BYTES)
    expect(prepareImage).toHaveBeenCalledWith(PHOTO_BYTES)
    expect(extractWithEscalation).toHaveBeenCalledWith(
      {
        kind: "image",
        mediaType: "image/jpeg",
        base64: "cHJlcGFyZWQ=",
        // The prepared pixels the model reads: also what a box is a fraction of.
        size: { width: 1200, height: 1600 },
      },
      ["Produce"],
      {
        engine: "anthropic",
        model: "test-model",
        apiKey: "sk-ant-test-key-1234",
      }
    )
  })

  it("refuses a HEIC from Drive instead of sending it to the model", async () => {
    getDriveFolder.mockResolvedValue({
      folder: { folderId: "folder-1", folderName: "kitchen-receipts" },
      skipped: [],
    })
    fetchDriveFileBytes.mockResolvedValue({
      base64: PHOTO_BYTES.toString("base64"),
      mimeType: "image/heic",
      bytes: PHOTO_BYTES.byteLength,
    })

    const result = await runInvoiceParse({
      file: null,
      fileName: "IMG_1584.HEIC",
      driveFileId: "drive-1",
      driveWebViewLink: null,
    })

    expect(result).toEqual({
      error: "iPhone HEIC photos aren't supported — share it as JPEG.",
    })
    expect(extractWithEscalation).not.toHaveBeenCalled()
  })
})
