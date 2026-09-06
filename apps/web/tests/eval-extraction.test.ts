import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

import type { InvoiceExtraction } from "@/lib/invoice-import"

/**
 * The pure parts of the golden-set eval: which files are cases, how a
 * bootstrapped expected file is read back, what a run costs, and what the
 * report on disk holds. The reading itself (unpdf, sharp, the model) is
 * mocked away — this file must not be able to spend money.
 */

vi.mock("server-only", () => ({}))
vi.mock("@/lib/invoice-extract", () => ({
  extractWithEscalation: vi.fn(),
  // The real module pulls in server-only and the canvas binary; this repeats
  // only the engine rule the flag defaults read.
  extractionConfig: () => ({
    engine:
      process.env.INVOICE_EXTRACTION_ENGINE === "anthropic"
        ? "anthropic"
        : "qwen",
    model: "configured-model",
    escalationModel: "configured-model",
  }),
}))
vi.mock("@/lib/image-prep", () => ({ prepareImage: vi.fn() }))
vi.mock("@/lib/pdf-text", () => ({ extractPdfTextLines: vi.fn() }))

const {
  buildReport,
  discoverCases,
  extractionCostUsd,
  loadExpected,
  notUsableFromError,
  parseArgs,
  reportPath,
} = await import("../scripts/eval-extraction")

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forkluck-eval-"))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
afterEach(() => vi.unstubAllEnvs())

const extraction: InvoiceExtraction = {
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

fs.writeFileSync(path.join(dir, "baldor.pdf"), "")
fs.writeFileSync(
  path.join(dir, "baldor.pdf.expected.json"),
  JSON.stringify({ draft: true, ...extraction })
)
fs.writeFileSync(path.join(dir, "IMG_1584.JPG"), "")
fs.writeFileSync(path.join(dir, "manifest.json"), "[]")
fs.writeFileSync(path.join(dir, "README.md"), "")

describe("discoverCases", () => {
  it("takes receipts only, and knows which ones are labelled", () => {
    const cases = discoverCases(dir, null)
    expect(cases.map((c) => c.name)).toEqual(["IMG_1584.JPG", "baldor.pdf"])
    expect(cases.map((c) => c.kind)).toEqual(["image", "pdf"])
    expect(cases.map((c) => c.hasExpected)).toEqual([false, true])
  })

  it("filters on the --only substring", () => {
    expect(discoverCases(dir, "IMG").map((c) => c.name)).toEqual([
      "IMG_1584.JPG",
    ])
  })
})

describe("loadExpected", () => {
  it("strips the draft flag before comparing", () => {
    const loaded = loadExpected(path.join(dir, "baldor.pdf.expected.json"))
    expect(loaded.draft).toBe(true)
    expect(loaded.expected).toEqual(extraction)
  })

  it("rejects an expected file that is not an extraction", () => {
    const broken = path.join(dir, "broken.pdf.expected.json")
    fs.writeFileSync(broken, JSON.stringify({ supplierName: "Baldor" }))
    expect(() => loadExpected(broken)).toThrow()
  })
})

describe("extractionCostUsd", () => {
  it("prices the Anthropic tiers per million tokens", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000 }
    expect(extractionCostUsd("claude-opus-5", usage)).toBeCloseTo(7.5)
    expect(extractionCostUsd("claude-sonnet-5", usage)).toBeCloseTo(3)
    expect(extractionCostUsd("claude-haiku-4-5", usage)).toBeCloseTo(1.5)
  })

  it("reports no price for a model the table doesn't carry", () => {
    expect(
      extractionCostUsd("qwen3-vl-plus", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      })
    ).toBeNull()
  })
})

describe("notUsableFromError", () => {
  it("turns the normalizer's refusal back into a not-usable read", () => {
    const read = notUsableFromError(
      "This file doesn't look like a supplier invoice: 15 receipts in one scan"
    )
    expect(read?.notUsable).toBe("15 receipts in one scan")
    expect(read?.lines).toEqual([])
  })

  it("leaves an ordinary failure alone", () => {
    expect(notUsableFromError("Extraction failed — try again.")).toBeNull()
  })
})

describe("report", () => {
  it("names the file by engine, model and date", () => {
    expect(
      reportPath("/golden", "anthropic", "claude-opus-5", "2026-09-01")
    ).toBe("/golden/reports/anthropic-claude-opus-5-2026-09-01.json")
  })

  it("carries the run and its totals", () => {
    const options = parseArgs([
      "--engine",
      "anthropic",
      "--model",
      "claude-sonnet-5",
      "--escalate",
      "--dir",
      dir,
    ])
    const report = buildReport(
      options,
      "claude-sonnet-5",
      [
        {
          name: "baldor.pdf",
          comparison: null,
          reconciled: true,
          escalated: true,
          error: null,
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.25,
          ms: 1200,
          engine: "anthropic",
          model: "claude-sonnet-5",
        },
      ],
      "2026-09-01"
    )
    expect(report).toMatchObject({
      engine: "anthropic",
      model: "claude-sonnet-5",
      escalate: true,
      date: "2026-09-01",
    })
    expect(report.cases).toHaveLength(1)
    expect(report.summary.documents).toBe(1)
    expect(report.summary.costUsd).toBe(0.25)
  })
})

describe("parseArgs", () => {
  it("defaults to one pass on Forkluck's own engine over the configured golden set", () => {
    const options = parseArgs([])
    expect(options).toMatchObject({
      engine: "qwen",
      // Null means "whatever the deployment is configured with"; main resolves
      // it against extractionConfig().
      model: null,
      escalate: false,
      bootstrap: false,
      only: null,
    })
  })

  it("follows a deployment configured for the Anthropic engine", () => {
    vi.stubEnv("INVOICE_EXTRACTION_ENGINE", "anthropic")

    expect(parseArgs([]).engine).toBe("anthropic")
  })

  it("refuses an unknown flag", () => {
    expect(() => parseArgs(["--engin", "qwen"])).toThrow("Unknown flag")
  })
})
