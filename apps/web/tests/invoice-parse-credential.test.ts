import { beforeEach, describe, expect, it, vi } from "vitest"

import { ImportTooComplexError } from "@/lib/import-limits"
import type { InvoiceExtraction } from "@/lib/invoice-import"
import type { ParseInvoiceInput } from "@/lib/invoice-parse"

/**
 * The AI-credential state machine in `runInvoiceParse`.
 *
 * The workspace's credential is read only on the opt-in `anthropic` engine; on
 * Forkluck's own default engine the parse never asks for one. There,
 * `/internal/v1/ai-credential/` answers with three distinct states, and a null
 * `key` covers two of them: never configured, and configured-but-undecryptable.
 * They produce different user-facing copy, and only one of them is an error the
 * user can act on, so the cross-product of (configured x key x scanned) is the
 * matrix worth pinning — not one example.
 *
 * `apps/api/forkluck/test_invoices.py::AnthropicKeyTests` pins the same three
 * states on the Python side; these are the TypeScript parity cases.
 */

// `server-only` has no runtime entry outside the Next.js bundler.
vi.mock("server-only", () => ({}))
// Reached only through `import-limits`; nothing on this path reads a workbook.
vi.mock("xlsx", () => ({ utils: {} }))

const getAiCredential = vi.fn()
const djangoAction = vi.fn()
const extractPdfTextLines = vi.fn()
const parseInvoiceFromTextLines = vi.fn()
const extractWithEscalation = vi.fn()

vi.mock("@/lib/backend/queries", () => ({
  getAiCredential: () => getAiCredential(),
  getBusinessSettings: () => Promise.resolve({ currencyCode: "USD" }),
  // These cases all carry their own bytes; nothing here reaches Drive.
  getDriveFolder: () => Promise.resolve({ folder: null, skipped: [] }),
}))
vi.mock("@/lib/backend/client", () => ({
  djangoAction: (slug: string, body: unknown) => djangoAction(slug, body),
}))
vi.mock("@/lib/pdf-text", () => ({
  extractPdfTextLines: (base64: string) => extractPdfTextLines(base64),
}))
vi.mock("@/lib/invoice-template", () => ({
  parseInvoiceFromTextLines: (pages: unknown) =>
    parseInvoiceFromTextLines(pages),
}))
// The engine each case runs on; the credential branch keys off it.
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

const INPUT: ParseInvoiceInput = {
  file: { kind: "pdf", mediaType: "application/pdf", base64: "ZmFrZQ==" },
  fileName: "invoice.pdf",
  driveFileId: null,
  driveWebViewLink: null,
}

function textLayer(scanned: boolean) {
  extractPdfTextLines.mockResolvedValue({ scanned, pages: [], pageSizes: [] })
}

beforeEach(() => {
  engine = "anthropic"
  getAiCredential.mockReset()
  djangoAction.mockReset()
  extractPdfTextLines.mockReset()
  parseInvoiceFromTextLines.mockReset()
  extractWithEscalation.mockReset()
  // The template defers by default; the credential branch is what's under test.
  parseInvoiceFromTextLines.mockReturnValue(null)
  djangoAction.mockResolvedValue({
    items: [],
    duplicate: false,
    categories: [],
  })
})

describe("runInvoiceParse credential states", () => {
  it("never reads the credential when the free template path succeeds", async () => {
    textLayer(false)
    parseInvoiceFromTextLines.mockReturnValue({
      supplierName: "Acme Produce",
      lines: [],
    } as unknown as InvoiceExtraction)

    await runInvoiceParse(INPUT)

    // Forkluck never pays for extraction, and never decrypts a key it does not
    // need to use.
    expect(getAiCredential).not.toHaveBeenCalled()
    expect(extractWithEscalation).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: "no key configured, digital PDF",
      credential: { configured: false, hint: null, key: null },
      scanned: false,
      expected: /Couldn't read this supplier's layout/,
    },
    {
      name: "no key configured, scanned PDF",
      credential: { configured: false, hint: null, key: null },
      scanned: true,
      expected: /This looks like a scanned PDF/,
    },
    {
      name: "key configured but undecryptable, digital PDF",
      credential: { configured: true, hint: "1234", key: null },
      scanned: false,
      expected: /can't be read/,
    },
    {
      name: "key configured but undecryptable, scanned PDF",
      credential: { configured: true, hint: "1234", key: null },
      scanned: true,
      // The unreadable key outranks the scan hint: telling a user to connect a
      // key they already connected is the wrong instruction.
      expected: /can't be read/,
    },
  ])("$name", async ({ credential, scanned, expected }) => {
    textLayer(scanned)
    getAiCredential.mockResolvedValue(credential)

    const result = await runInvoiceParse(INPUT)

    expect(result).toHaveProperty("error")
    expect((result as { error: string }).error).toMatch(expected)
    // No key means no AI call, in either null state.
    expect(extractWithEscalation).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    "uses the decrypted key when one is readable (scanned: %s)",
    async (scanned) => {
      textLayer(scanned)
      getAiCredential.mockResolvedValue({
        configured: true,
        hint: "1234",
        key: "sk-ant-test-key-1234",
      })
      djangoAction.mockResolvedValue({
        items: [],
        duplicate: false,
        categories: [{ id: "c1", name: "Produce" }],
      })
      extractWithEscalation.mockResolvedValue({ error: "AI declined" })

      const result = await runInvoiceParse(INPUT)

      expect(extractWithEscalation).toHaveBeenCalledWith(
        INPUT.file,
        ["Produce"],
        {
          engine: "anthropic",
          model: "test-model",
          apiKey: "sk-ant-test-key-1234",
        }
      )
      expect(result).toEqual({ error: "AI declined" })
    }
  )

  it("stops at a complexity ceiling instead of paying the AI path for it", async () => {
    extractPdfTextLines.mockRejectedValue(
      new ImportTooComplexError("That PDF contains too much text to process.")
    )
    getAiCredential.mockResolvedValue({
      configured: true,
      hint: "1234",
      key: "sk-ant-test-key-1234",
    })

    const result = await runInvoiceParse(INPUT)

    expect(result).toEqual({
      error: "That PDF contains too much text to process.",
    })
    expect(getAiCredential).not.toHaveBeenCalled()
    expect(extractWithEscalation).not.toHaveBeenCalled()
  })

  it("refuses a file pdf.js can't open instead of paying the AI for it", async () => {
    extractPdfTextLines.mockRejectedValue(new Error("not a pdf"))
    getAiCredential.mockResolvedValue({
      configured: true,
      hint: "1234",
      key: "sk-ant-test-key-1234",
    })

    const result = await runInvoiceParse(INPUT)

    // A missing text layer comes back as `scanned`, never as a throw, so the
    // only way here is bytes Anthropic would reject too.
    expect(result).toEqual({ error: "That file isn't a readable PDF." })
    expect(extractWithEscalation).not.toHaveBeenCalled()
  })

  it("reads on Forkluck's own engine with no workspace credential", async () => {
    engine = "qwen"
    textLayer(true)
    djangoAction.mockResolvedValue({
      items: [],
      duplicate: false,
      categories: [{ id: "c1", name: "Produce" }],
    })
    extractWithEscalation.mockResolvedValue({ error: "AI declined" })

    const result = await runInvoiceParse(INPUT)

    expect(getAiCredential).not.toHaveBeenCalled()
    expect(extractWithEscalation).toHaveBeenCalledWith(
      INPUT.file,
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

  it("surfaces the unconfigured-server error, never a key prompt", async () => {
    engine = "qwen"
    textLayer(true)
    djangoAction.mockResolvedValue({
      items: [],
      duplicate: false,
      categories: [],
    })
    extractWithEscalation.mockResolvedValue({
      error: "Forkluck's AI isn't configured on this server.",
    })

    const result = await runInvoiceParse(INPUT)

    expect(result).toEqual({
      error: "Forkluck's AI isn't configured on this server.",
    })
  })

  it("skips the AI when the probe already knows this Drive file", async () => {
    textLayer(true)
    getAiCredential.mockResolvedValue({
      configured: true,
      hint: "1234",
      key: "sk-ant-test-key-1234",
    })
    djangoAction.mockResolvedValue({
      items: [],
      duplicate: true,
      driveFileKnown: true,
      categories: [],
    })

    const result = await runInvoiceParse({ ...INPUT, driveFileId: "drive-1" })

    expect(djangoAction).toHaveBeenCalledWith("invoice-line-status", {
      supplier: "unknown",
      lines: [],
      driveFileId: "drive-1",
    })
    expect(result).toHaveProperty("error")
    expect(extractWithEscalation).not.toHaveBeenCalled()
  })
})
