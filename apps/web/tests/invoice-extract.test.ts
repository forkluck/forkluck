import { APICallError } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import sharp from "sharp"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { InvoiceExtraction } from "@/lib/invoice-import"
import { InvoiceAiBudgetError } from "@/lib/invoice-ai-usage"
import * as imagePrep from "@/lib/image-prep"
import { normalizeInvoiceExtraction } from "@/lib/invoice-import"

import baldorInvoice from "./fixtures/invoices/baldor-invoice.json"

/**
 * Engine dispatch and validator-gated escalation in the one AI-SDK module.
 * Both providers are stubbed with the SDK's own mock model, so what is under
 * test is the message the engine builds, the errors it maps, and which of two
 * reads wins — never a network call.
 */

vi.mock("server-only", () => ({}))

const doGenerate = vi.fn()
const providerCalls: {
  provider: string
  apiKey: string
  model: string
  structured: boolean
}[] = []

function stubProvider(provider: string) {
  return (settings: { apiKey?: string; supportsStructuredOutputs?: boolean }) =>
    (model: string) => {
      providerCalls.push({
        provider,
        apiKey: settings.apiKey ?? "",
        model,
        structured: settings.supportsStructuredOutputs === true,
      })
      return new MockLanguageModelV4({ provider, modelId: model, doGenerate })
    }
}

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: stubProvider("anthropic"),
}))
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: stubProvider("qwen"),
}))

/** Rasterization, without the canvas binary: what is under test is which
 * pages are drawn and at what scale. */
let pdfPageCount = 1
const rendered: Array<{ page: number; scale: number }> = []
vi.mock("unpdf", () => ({
  getDocumentProxy: async () => ({
    get numPages() {
      return pdfPageCount
    },
    getPage: async () => ({
      getViewport: () => ({ width: 612, height: 792 }),
    }),
  }),
  renderPageAsImage: async (
    _pdf: unknown,
    page: number,
    options: { scale: number }
  ) => {
    rendered.push({ page, scale: options.scale })
    return new Uint8Array([1, 2, 3])
  },
}))

const {
  alignReceiptHighlights,
  detectDocuments,
  extractInvoice,
  extractWithEscalation,
  extractionConfig,
} = await import("@/lib/invoice-extract")

const CLEAN: InvoiceExtraction = {
  ...(baldorInvoice as InvoiceExtraction),
  lines: (baldorInvoice as InvoiceExtraction).lines.map((line) => ({
    ...line,
    uncertain: false,
    uncertainReason: null,
  })),
}
/** The same document read badly: the printed total no longer matches the
 * lines, which is exactly what the validator escalates on. */
const MISMATCHED: InvoiceExtraction = { ...CLEAN, totalAmount: "999.99" }

const PDF = {
  kind: "pdf" as const,
  mediaType: "application/pdf" as const,
  base64: "cGRm",
}
const PHOTO = {
  kind: "image" as const,
  mediaType: "image/jpeg" as const,
  base64: "cGhvdG8=",
}

function respond(extraction: InvoiceExtraction, finishReason = "stop") {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(extraction) }],
    finishReason: { unified: finishReason as "stop" },
    usage: { inputTokens: { total: 100 }, outputTokens: { total: 20 } },
    warnings: [],
  }
}

const ANTHROPIC = {
  engine: "anthropic" as const,
  model: "claude-opus-5",
  apiKey: "sk-ant",
}
/** Forkluck's own engine: no merchant key anywhere in the options. */
const QWEN = {
  engine: "qwen" as const,
  model: "qwen3-vl-plus",
  apiKey: null,
}

function lastCall() {
  return doGenerate.mock.lastCall![0]
}

beforeEach(() => {
  doGenerate.mockReset().mockResolvedValue(respond(CLEAN))
  providerCalls.length = 0
  rendered.length = 0
  pdfPageCount = 1
  vi.spyOn(console, "info").mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("receipt highlight ownership", () => {
  function misplacedPrefix(): InvoiceExtraction {
    const line = CLEAN.lines[0]
    return {
      ...CLEAN,
      supplierName: "Wegmans",
      documentType: "receipt",
      totalAmount: "11.49",
      lines: [
        {
          ...line,
          description: "DELI ITEM",
          quantity: "4",
          unit: null,
          unitPrice: "1.50",
          packSize: null,
          lineAmount: "5.49",
          box: { page: 0, bbox_2d: [100, 200, 900, 300] },
        },
        {
          ...line,
          description: "PEARS",
          quantity: null,
          unit: null,
          unitPrice: null,
          packSize: null,
          lineAmount: "6.00",
          box: { page: 0, bbox_2d: [250, 310, 900, 340] },
        },
      ],
    }
  }

  it("moves only the prefix region and preserves the numeric transcription", async () => {
    const pixels = vi
      .spyOn(imagePrep, "receiptPrefixBoundary")
      .mockResolvedValue(0.245)
    const original = misplacedPrefix()
    const before = structuredClone(original)
    const result = await alignReceiptHighlights(original, ["cGl4ZWxz"])
    const normalized = normalizeInvoiceExtraction(result)
    if ("error" in normalized) throw new Error(normalized.error)
    expect(
      normalized.lines.map(({ quantity, box }) => ({ quantity, box }))
    ).toEqual([
      {
        quantity: null,
        box: { page: 0, x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.245 },
      },
      { quantity: 4, box: { page: 0, x0: 0.1, y0: 0.245, x1: 0.9, y1: 0.34 } },
    ])
    expect(result.lines[0].quantity).toBe("4")
    expect(result.lines[1].quantity).toBeNull()
    expect(original).toEqual(before)
    expect(pixels).toHaveBeenCalledTimes(1)
    expect(pixels.mock.calls[0][0].toString()).toBe("pixels")
  })

  it.each([
    "unclear pixels",
    "pixel failure",
    "other supplier",
    "explicit unit",
    "page break",
    "no images",
  ])("keeps the original rectangles for %s", async (scenario) => {
    const pixels = vi
      .spyOn(imagePrep, "receiptPrefixBoundary")
      .mockResolvedValue(null)
    if (scenario === "pixel failure")
      pixels.mockRejectedValue(new Error("invalid image"))
    const original = misplacedPrefix()
    if (scenario === "other supplier") original.supplierName = "Example Grocer"
    if (scenario === "explicit unit") original.lines[0].unit = "LB"
    if (scenario === "page break") original.lines[1].box!.page = 1
    const result = await alignReceiptHighlights(
      original,
      scenario === "no images" ? undefined : ["cGl4ZWxz"]
    )
    expect(result).toEqual(original)
    if (!["unclear pixels", "pixel failure"].includes(scenario))
      expect(pixels).not.toHaveBeenCalled()
  })

  it("uses the already rendered PDF in the actual extraction path", async () => {
    vi.stubEnv("QWEN_API_KEY", "sk-forkluck")
    vi.spyOn(imagePrep, "receiptPrefixBoundary").mockResolvedValue(0.245)
    doGenerate.mockResolvedValue(respond(misplacedPrefix()))
    const result = await extractInvoice(PDF, ["Ingredients"], QWEN)
    if ("error" in result) throw new Error(result.error)
    expect(result.extraction.lines[0].box?.bbox_2d[3]).toBe(0.245)
    expect(result.extraction.lines[1].box?.bbox_2d[1]).toBe(0.245)
    expect(doGenerate).toHaveBeenCalledTimes(1)
    expect(rendered).toHaveLength(1)
  })

  it("keeps a corrected prefix above an item while trimming its overlap below", async () => {
    vi.spyOn(imagePrep, "receiptPrefixBoundary").mockResolvedValue(0.245)
    const bottom = vi
      .spyOn(imagePrep, "receiptItemBottomBoundary")
      .mockResolvedValue(0.322)
    const original = misplacedPrefix()
    original.lines.push({
      ...original.lines[1],
      description: "LIME",
      lineAmount: "0.79",
      box: { page: 0, bbox_2d: [250, 325, 900, 360] },
    })
    const result = await alignReceiptHighlights(original, ["cGl4ZWxz"])
    const normalized = normalizeInvoiceExtraction(result)
    if ("error" in normalized) throw new Error(normalized.error)
    expect(normalized.lines[1]).toMatchObject({
      quantity: 4,
      box: { y0: 0.245, y1: 0.322 },
    })
    expect(normalized.lines[2].box?.y0).toBe(0.325)
    expect(bottom).toHaveBeenCalledTimes(1)
    expect(bottom.mock.calls[0][1].y1).toBe(0.36)
  })

  it.each(["another page", "no overlap", "reversed order"])(
    "does not trim neighboring boxes with %s",
    async (scenario) => {
      const bottom = vi
        .spyOn(imagePrep, "receiptItemBottomBoundary")
        .mockResolvedValue(0.245)
      vi.spyOn(imagePrep, "receiptPrefixBoundary").mockResolvedValue(null)
      const original = misplacedPrefix()
      if (scenario === "another page") original.lines[1].box!.page = 1
      if (scenario === "reversed order") original.lines[1].box!.bbox_2d[1] = 190
      expect(await alignReceiptHighlights(original, ["cGl4ZWxz"])).toEqual(
        original
      )
      expect(bottom).not.toHaveBeenCalled()
    }
  )

  it("cannot change numeric normalization when only one rectangle is refined", async () => {
    vi.spyOn(imagePrep, "receiptPrefixBoundary").mockResolvedValue(null)
    vi.spyOn(imagePrep, "receiptItemBottomBoundary").mockResolvedValue(0.322)
    const original = misplacedPrefix()
    original.lines.push({
      ...original.lines[1],
      description: "LIME",
      lineAmount: "0.79",
      box: { page: 0, bbox_2d: [250, 325, 900, 360] },
    })
    const before = normalizeInvoiceExtraction(original)
    const after = normalizeInvoiceExtraction(
      await alignReceiptHighlights(original, ["cGl4ZWxz"])
    )
    if ("error" in before || "error" in after)
      throw new Error("unusable fixture")
    const numbers = (invoice: typeof before) =>
      invoice.lines.map(
        ({ quantity, unitPriceCents, lineAmountCents, uncertain, reason }) => ({
          quantity,
          unitPriceCents,
          lineAmountCents,
          uncertain,
          reason,
        })
      )
    expect(numbers(after)).toEqual(numbers(before))
    expect(after.lines.map((line) => line.quantity)).toEqual([null, 4, null])
  })

  it("does not spend a second AI read because a rectangle changed coordinate frames", async () => {
    vi.stubEnv("QWEN_API_KEY", "sk-forkluck")
    vi.spyOn(imagePrep, "receiptPrefixBoundary").mockResolvedValue(null)
    vi.spyOn(imagePrep, "receiptItemBottomBoundary").mockResolvedValue(0.322)
    const original = misplacedPrefix()
    original.totalAmount = "12.28"
    original.lines.push({
      ...original.lines[1],
      description: "LIME",
      lineAmount: "0.79",
      box: { page: 0, bbox_2d: [250, 325, 900, 360] },
    })
    doGenerate.mockResolvedValue(respond(original))
    const result = await extractWithEscalation(PDF, ["Ingredients"], QWEN)
    if ("error" in result) throw new Error(result.error)
    expect(result.normalized.lines.map((line) => line.quantity)).toEqual([
      null,
      4,
      null,
    ])
    expect(result.escalated).toBe(false)
    expect(doGenerate).toHaveBeenCalledTimes(1)
  })

  it.each([264, 270, 275, 300])(
    "aligns real pixels when the next box starts at %s through or below the prefix",
    async (nextTop) => {
      const original = misplacedPrefix()
      original.lines[0].box!.bbox_2d = [100, 200, 900, 335]
      original.lines[1].box!.bbox_2d = [100, nextTop, 900, 360]
      original.lines.push({
        ...original.lines[1],
        description: "LIME",
        lineAmount: "0.79",
        box: { page: 0, bbox_2d: [250, 340, 900, 380] },
      })
      const pixels = await sharp(
        Buffer.from(
          '<svg width="1000" height="1000"><rect width="1000" height="1000" fill="white"/><rect x="250" y="215" width="300" height="15"/><rect x="760" y="215" width="90" height="15"/><rect x="120" y="260" width="180" height="15"/><rect x="250" y="310" width="300" height="15"/><rect x="760" y="310" width="90" height="15"/><rect x="250" y="345" width="300" height="15"/><rect x="760" y="345" width="90" height="15"/></svg>'
        )
      )
        .png()
        .toBuffer()
      const result = normalizeInvoiceExtraction(
        await alignReceiptHighlights(original, [pixels.toString("base64")])
      )
      if ("error" in result) throw new Error(result.error)
      expect(result.lines.map((line) => line.quantity)).toEqual([null, 4, null])
      expect(result.lines[0].box!.y1).toBeGreaterThan(0.23)
      expect(result.lines[0].box!.y1).toBeLessThan(0.26)
      expect(result.lines[1].box!.y0).toBe(result.lines[0].box!.y1)
      expect(result.lines[1].box!.y1).toBeGreaterThan(0.325)
      expect(result.lines[1].box!.y1).toBeLessThan(0.34)
    }
  )
})

describe("extractionConfig", () => {
  beforeEach(() => {
    for (const name of [
      "INVOICE_EXTRACTION_ENGINE",
      "INVOICE_EXTRACTION_MODEL",
      "INVOICE_ESCALATION_MODEL",
    ]) {
      vi.stubEnv(name, undefined)
    }
  })

  it("runs on Forkluck's own Qwen engine by default", () => {
    // Unset escalation means the same model, read again with a hint.
    expect(extractionConfig()).toEqual({
      engine: "qwen",
      model: "qwen3-vl-flash",
      escalationModel: "qwen3-vl-flash",
    })
  })

  it("defaults tier 2 to claude-opus-5 on the opt-in Anthropic engine", () => {
    vi.stubEnv("INVOICE_EXTRACTION_ENGINE", "anthropic")

    expect(extractionConfig()).toEqual({
      engine: "anthropic",
      model: "claude-opus-5",
      escalationModel: "claude-opus-5",
    })
  })

  it("takes the escalation model as a model id on the configured engine", () => {
    vi.stubEnv("INVOICE_EXTRACTION_MODEL", "qwen3-vl-flash")
    vi.stubEnv("INVOICE_ESCALATION_MODEL", "qwen3-vl-plus")

    expect(extractionConfig()).toMatchObject({
      engine: "qwen",
      model: "qwen3-vl-flash",
      escalationModel: "qwen3-vl-plus",
    })
  })

  it("disables the second pass on an empty escalation model", () => {
    vi.stubEnv("INVOICE_ESCALATION_MODEL", "")

    expect(extractionConfig().escalationModel).toBe("")
  })
})

describe("extractInvoice engines", () => {
  it("sends a PDF to Anthropic as a file part on the merchant's key", async () => {
    const result = await extractInvoice(PDF, ["Produce"], ANTHROPIC)

    expect(providerCalls).toMatchObject([
      { provider: "anthropic", apiKey: "sk-ant", model: "claude-opus-5" },
    ])
    const content = lastCall().prompt[0].content
    expect(content[0]).toMatchObject({
      type: "file",
      mediaType: "application/pdf",
    })
    expect(content[1].text).toContain("Produce")
    expect(lastCall().providerOptions?.anthropic).toEqual({
      structuredOutputMode: "outputFormat",
      effort: "medium",
    })
    expect(result).toEqual({
      extraction: CLEAN,
      usage: { inputTokens: 100, outputTokens: 20 },
      model: "claude-opus-5",
    })
  })

  it("sends a photo as an image part", async () => {
    await extractInvoice(PHOTO, ["Produce"], ANTHROPIC)

    expect(lastCall().prompt[0].content[0]).toMatchObject({
      type: "file",
      mediaType: "image/jpeg",
    })
  })

  it("runs the qwen engine on Forkluck's own key, with no Anthropic options", async () => {
    vi.stubEnv("QWEN_API_KEY", "qwen-key")

    await extractInvoice(PHOTO, ["Produce"], QWEN)

    expect(providerCalls).toMatchObject([
      { provider: "qwen", apiKey: "qwen-key", model: "qwen3-vl-plus" },
    ])
    expect(lastCall().providerOptions).toBeUndefined()
  })

  it("asks DashScope for its json_schema response format", async () => {
    // json_object mode is refused unless the prompt says "json", and carries
    // no schema; the flag is what makes the field descriptions reach Qwen.
    vi.stubEnv("QWEN_API_KEY", "qwen-key")
    await extractInvoice(PHOTO, ["Ingredients"], QWEN)
    expect(providerCalls[0]).toMatchObject({
      provider: "qwen",
      structured: true,
    })
  })

  it("refuses the qwen engine when this server has no key of its own", async () => {
    vi.stubEnv("QWEN_API_KEY", "")

    expect(await extractInvoice(PHOTO, ["Produce"], QWEN)).toEqual({
      error: "Forkluck's AI isn't configured on this server.",
    })
    expect(doGenerate).not.toHaveBeenCalled()
  })

  it("appends the escalation hint to the prompt", async () => {
    await extractInvoice(PDF, ["Produce"], {
      ...ANTHROPIC,
      hint: "Line items add up to something else.",
    })

    expect(lastCall().prompt[0].content[1].text).toContain(
      "Line items add up to something else."
    )
  })

  it.each([
    ["content-filter", "The model declined to read this file."],
    ["length", "This document is too long to extract in one pass."],
  ])("maps the %s stop reason", async (finishReason, error) => {
    doGenerate.mockResolvedValue(respond(CLEAN, finishReason))

    expect(await extractInvoice(PDF, ["Produce"], ANTHROPIC)).toEqual({ error })
  })

  it("maps a rejected key to the key's own copy", async () => {
    doGenerate.mockRejectedValue(
      new APICallError({
        message: "unauthorized",
        url: "https://api.anthropic.com",
        requestBodyValues: {},
        statusCode: 401,
        isRetryable: false,
      })
    )

    const result = await extractInvoice(PDF, ["Produce"], ANTHROPIC)

    expect(result).toEqual({
      error:
        "Anthropic rejected your API key — check it under AI key on the Invoices page.",
    })
  })

  it("reports any other API failure with its status", async () => {
    doGenerate.mockRejectedValue(
      new APICallError({
        message: "boom",
        url: "https://api.anthropic.com",
        requestBodyValues: {},
        statusCode: 400,
        isRetryable: false,
      })
    )

    expect(await extractInvoice(PDF, ["Produce"], ANTHROPIC)).toEqual({
      error: "Extraction failed (400) — try again.",
    })
  })
})

describe("extractWithEscalation", () => {
  it("shares the Qwen deadline with escalation and keeps the first read on expiry", async () => {
    vi.useFakeTimers()
    vi.stubEnv("QWEN_API_KEY", "qwen-key")
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), ms)
      return controller.signal
    })
    doGenerate
      .mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(respond(MISMATCHED)), 15_000)
          )
      )
      .mockImplementationOnce(
        ({ abortSignal }) =>
          new Promise((_resolve, reject) => {
            abortSignal.addEventListener(
              "abort",
              () => reject(new Error("Aborted")),
              { once: true }
            )
          })
      )
    let completed = false
    const run = extractWithEscalation(PDF, ["Ingredients"], QWEN).then(
      (result) => {
        completed = true
        return result
      }
    )
    await vi.advanceTimersByTimeAsync(15_000)
    expect(doGenerate).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(completed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await run).toMatchObject({
      extraction: MISMATCHED,
      escalated: false,
    })
    expect(AbortSignal.timeout).toHaveBeenCalledTimes(1)
    expect(AbortSignal.timeout).toHaveBeenCalledWith(25_000)
  })

  it("does not reserve or start a call after its deadline", async () => {
    vi.stubEnv("QWEN_API_KEY", "qwen-key")
    const budget = { beforeCall: vi.fn(), record: vi.fn() }
    const result = await extractWithEscalation(PDF, ["Ingredients"], {
      ...QWEN,
      budget,
      signal: AbortSignal.abort(),
    })
    expect(result).toMatchObject({
      error: expect.stringContaining("took too long"),
    })
    expect(budget.beforeCall).not.toHaveBeenCalled()
    expect(doGenerate).not.toHaveBeenCalled()
  })

  it("keeps a clean first read and never pays for a second", async () => {
    const run = await extractWithEscalation(PDF, ["Produce"], ANTHROPIC)

    expect(doGenerate).toHaveBeenCalledTimes(1)
    expect(run).toMatchObject({
      extraction: CLEAN,
      model: "claude-opus-5",
      escalated: false,
      usage: { inputTokens: 100, outputTokens: 20 },
    })
  })

  it("escalates a totals mismatch and keeps the reconciled read", async () => {
    vi.stubEnv("INVOICE_ESCALATION_MODEL", "claude-opus-5-tier3")
    doGenerate
      .mockResolvedValueOnce(respond(MISMATCHED))
      .mockResolvedValueOnce(respond(CLEAN))

    const run = await extractWithEscalation(PDF, ["Produce"], ANTHROPIC)

    expect(doGenerate).toHaveBeenCalledTimes(2)
    // The second pass carries the validator's findings.
    expect(lastCall().prompt[0].content[1].text).toContain(
      "A first read of this document did not reconcile"
    )
    expect(run).toMatchObject({
      extraction: CLEAN,
      model: "claude-opus-5-tier3",
      escalated: true,
      // Both passes were billed.
      usage: { inputTokens: 200, outputTokens: 40 },
    })
  })

  it("keeps the first read when the escalation reads the file worse", async () => {
    vi.stubEnv("INVOICE_ESCALATION_MODEL", "claude-opus-5-tier3")
    doGenerate
      .mockResolvedValueOnce(respond(MISMATCHED))
      .mockResolvedValueOnce(respond({ ...MISMATCHED, invoiceDate: null }))

    const run = await extractWithEscalation(PDF, ["Produce"], ANTHROPIC)

    expect(run).toMatchObject({
      extraction: MISMATCHED,
      model: "claude-opus-5",
      escalated: false,
    })
  })

  it("keeps the first read when the escalation itself fails", async () => {
    vi.stubEnv("INVOICE_ESCALATION_MODEL", "claude-opus-5-tier3")
    doGenerate
      .mockResolvedValueOnce(respond(MISMATCHED))
      .mockRejectedValueOnce(new Error("network"))

    const run = await extractWithEscalation(PDF, ["Produce"], ANTHROPIC)

    expect(run).toMatchObject({ extraction: MISMATCHED, escalated: false })
  })

  it("escalates on qwen against Forkluck's key, never the merchant's", async () => {
    vi.stubEnv("QWEN_API_KEY", "qwen-key")
    vi.stubEnv("INVOICE_EXTRACTION_ENGINE", "qwen")
    doGenerate
      .mockResolvedValueOnce(respond(MISMATCHED))
      .mockResolvedValueOnce(respond(CLEAN))

    // A photo, not a PDF: on qwen a PDF would be rasterized first.
    const run = await extractWithEscalation(PHOTO, ["Produce"], QWEN)

    // Unset INVOICE_ESCALATION_MODEL means the same model, read again with
    // the validator's findings.
    expect(providerCalls).toMatchObject([
      { provider: "qwen", apiKey: "qwen-key", model: "qwen3-vl-plus" },
      { provider: "qwen", apiKey: "qwen-key", model: "qwen3-vl-plus" },
    ])
    expect(run).toMatchObject({ extraction: CLEAN, escalated: true })
  })

  it("does not escalate when no tier-3 model is configured", async () => {
    vi.stubEnv("INVOICE_ESCALATION_MODEL", "")
    doGenerate.mockResolvedValue(respond(MISMATCHED))

    const run = await extractWithEscalation(PDF, ["Produce"], ANTHROPIC)

    expect(doGenerate).toHaveBeenCalledTimes(1)
    expect(run).toMatchObject({ extraction: MISMATCHED, escalated: false })
  })
})

describe("rasterizing a scan", () => {
  beforeEach(() => {
    vi.stubEnv("QWEN_API_KEY", "qwen-key")
  })

  it("draws only the pages of the document it was asked for", async () => {
    pdfPageCount = 6

    await extractInvoice(PDF, ["Produce"], {
      ...QWEN,
      pages: { start: 2, end: 3 },
    })

    // 0-based range, 1-based pdf.js pages.
    expect(rendered.map((page) => page.page)).toEqual([3, 4])
    expect(lastCall().prompt[0].content).toHaveLength(3)
  })

  it("refuses a scan longer than one document instead of reading its first pages", async () => {
    pdfPageCount = 7

    expect(await extractInvoice(PDF, ["Produce"], QWEN)).toEqual({
      error: "This scan has 7 pages; Forkluck reads up to 4 per document.",
    })
    expect(doGenerate).not.toHaveBeenCalled()
  })

  it("counts the range, not the file, against that limit", async () => {
    pdfPageCount = 15

    await extractInvoice(PDF, ["Produce"], {
      ...QWEN,
      pages: { start: 8, end: 9 },
    })

    expect(rendered.map((page) => page.page)).toEqual([9, 10])
  })
})

describe("detectDocuments", () => {
  function documents(
    entries: Array<{
      pageStart?: number | null
      pageEnd?: number | null
      region?: { x0: number; y0: number; x1: number; y1: number } | null
    }>
  ) {
    doGenerate.mockResolvedValue({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            documents: entries.map((entry) => ({
              pageStart: entry.pageStart ?? null,
              pageEnd: entry.pageEnd ?? null,
              region: entry.region ?? null,
            })),
          }),
        },
      ],
      finishReason: { unified: "stop" as const },
      usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
      warnings: [],
    })
  }

  it("sends a text PDF as its pages' first lines and answers page ranges", async () => {
    documents([
      { pageStart: 0, pageEnd: 1 },
      { pageStart: 2, pageEnd: 2 },
    ])

    const result = await detectDocuments(
      {
        kind: "pdf-text",
        pages: ["BALDOR\nIV101-1", "continued", "BALDOR\nIV101-2"],
      },
      ANTHROPIC
    )

    const prompt = lastCall().prompt[0].content
    expect(prompt[0].text).toContain("--- page 0 ---")
    expect(prompt[0].text).toContain("IV101-2")
    expect(prompt[1].text).toContain(
      "This file may hold more than one supplier document."
    )
    expect(result).toEqual({
      documents: [
        { pageStart: 0, pageEnd: 1 },
        { pageStart: 2, pageEnd: 2 },
      ],
    })
  })

  it("shows a scan cheaply: half scale, and never more than twenty pages", async () => {
    vi.stubEnv("QWEN_API_KEY", "qwen-key")
    pdfPageCount = 30
    documents([{ pageStart: 0, pageEnd: 29 }])

    await detectDocuments({ kind: "pdf-scan", base64: "cGRm" }, QWEN)

    expect(rendered).toHaveLength(20)
    expect(new Set(rendered.map((page) => page.scale))).toEqual(new Set([0.5]))
  })

  it("answers regions for a photo of several receipts", async () => {
    documents([
      { region: { x0: 0, y0: 0, x1: 0.5, y1: 1 } },
      { region: { x0: 0.5, y0: 0, x1: 1, y1: 1 } },
    ])

    const result = await detectDocuments(
      { kind: "image", base64: "cGhvdG8=", mediaType: "image/jpeg" },
      ANTHROPIC
    )

    expect(lastCall().prompt[0].content[0]).toMatchObject({
      type: "file",
      mediaType: "image/jpeg",
    })
    expect(result).toEqual({
      documents: [
        { region: { x0: 0, y0: 0, x1: 0.5, y1: 1 } },
        { region: { x0: 0.5, y0: 0, x1: 1, y1: 1 } },
      ],
    })
  })

  it("drops an entry that names neither pages nor a region", async () => {
    documents([{ pageStart: 0, pageEnd: 0 }, {}])

    expect(
      await detectDocuments({ kind: "pdf-text", pages: ["one"] }, ANTHROPIC)
    ).toEqual({
      documents: [{ pageStart: 0, pageEnd: 0 }],
    })
  })

  it("says so rather than throwing when the model answers nothing usable", async () => {
    doGenerate.mockResolvedValue({
      content: [{ type: "text" as const, text: "not json" }],
      finishReason: { unified: "stop" as const },
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
      warnings: [],
    })

    expect(
      await detectDocuments({ kind: "pdf-text", pages: ["one"] }, ANTHROPIC)
    ).toEqual({
      error: "Couldn't tell how many documents this file holds.",
    })
  })
})

describe("hosted AI admission", () => {
  beforeEach(() => vi.stubEnv("QWEN_API_KEY", "test-server-key"))

  it("does not contact Qwen when the budget refuses extraction or detection", async () => {
    const refusal = new InvoiceAiBudgetError("Monthly allowance reached", true)
    const budget = {
      beforeCall: vi.fn().mockRejectedValue(refusal),
      record: vi.fn(),
    }
    await expect(extractInvoice(PHOTO, [], { ...QWEN, budget })).rejects.toBe(
      refusal
    )
    await expect(
      detectDocuments(
        { kind: "image", base64: PHOTO.base64, mediaType: PHOTO.mediaType },
        { ...QWEN, budget }
      )
    ).rejects.toBe(refusal)
    expect(doGenerate).not.toHaveBeenCalled()
    expect(budget.record).not.toHaveBeenCalled()
  })

  it("reserves retries before the first network attempt and meters escalation too", async () => {
    const events: string[] = []
    const budget = {
      beforeCall: vi.fn(async () => {
        events.push("reserve")
      }),
      record: vi.fn(async () => {
        events.push("record")
      }),
    }
    doGenerate
      .mockImplementationOnce(async () => {
        events.push("model")
        return respond(MISMATCHED)
      })
      .mockImplementationOnce(async () => {
        events.push("model")
        return respond(CLEAN)
      })
    await extractWithEscalation(PHOTO, [], { ...QWEN, budget })
    expect(events).toEqual([
      "reserve",
      "model",
      "record",
      "reserve",
      "model",
      "record",
    ])
    expect(budget.beforeCall.mock.calls).toEqual([[2], [2]])
    expect(budget.record).toHaveBeenCalledTimes(2)
  })

  it("preserves a usable first read when optional escalation has no budget", async () => {
    doGenerate.mockResolvedValue(respond(MISMATCHED))
    const budget = {
      beforeCall: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(new InvoiceAiBudgetError("At limit", true)),
      record: vi.fn(),
    }
    const result = await extractWithEscalation(PHOTO, [], { ...QWEN, budget })
    expect(result).toMatchObject({ extraction: MISMATCHED, escalated: false })
    expect(doGenerate).toHaveBeenCalledTimes(1)
  })

  it("records billed usage even when the generated object is malformed", async () => {
    doGenerate.mockResolvedValue({
      ...respond(CLEAN),
      content: [{ type: "text", text: "bad json" }],
    })
    const budget = { beforeCall: vi.fn(), record: vi.fn() }
    const result = await extractInvoice(PHOTO, [], { ...QWEN, budget })
    expect(result).toHaveProperty("error")
    expect(budget.record).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 100, outputTokens: 20 })
    )
  })
})

describe("a file the model refuses", () => {
  it("hands the refusal's own words back so a bundle can be split", async () => {
    doGenerate.mockResolvedValue(
      respond({ ...CLEAN, notUsable: "This scan holds 3 separate receipts." })
    )

    expect(await extractWithEscalation(PHOTO, ["Produce"], ANTHROPIC)).toEqual({
      error:
        "This file doesn't look like a supplier invoice: This scan holds 3 separate receipts.",
      notUsable: "This scan holds 3 separate receipts.",
    })
  })
})
