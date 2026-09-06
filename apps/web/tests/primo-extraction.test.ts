import { describe, expect, it, vi } from "vitest"
import * as XLSX from "xlsx"
import { readFileSync } from "node:fs"
import { kitchenPdf, invoiceLines } from "./fixtures/primo-documents"
const vision = vi.hoisted(() => vi.fn())
vi.mock("ai", () => ({ generateText: vision }))
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => () => ({}),
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/backend/client", () => ({ djangoAction: vi.fn() }))
vi.mock("@/lib/ai/providers", () => ({
  QWEN_BASE_URL: "https://example.invalid",
}))
import { extractAttachment } from "@/lib/primo/attachment-server"
import { ATTACHMENT_TYPES } from "@/lib/primo/attachments"

describe("Primo document extraction", () => {
  it("preserves invoice rows and PDF page labels without vision", async () => {
    vision.mockClear()
    const result = await extractAttachment(
      kitchenPdf([
        invoiceLines,
        [
          "Recipe: Bread",
          "Flour 200 g",
          "Water 120 g",
          "Mix and bake until done",
        ],
      ]),
      "application/pdf"
    )
    expect(result.content).toContain("Page 1\nSynthetic Supplier Invoice\nItem")
    expect(result.content).toMatch(
      /Flour.*2 bags.*20.00\nButter.*1 case.*40.00/
    )
    expect(result.content).toContain("Flour\t2 bags\t20.00")
    expect(result.content).toContain("Page 2\nRecipe: Bread\nFlour 200 g")
    expect(result.coverage).toBe("Read 2 of 2 pages.")
    expect(vision).not.toHaveBeenCalled()
  })
  it("reports the pages actually read at the PDF page and text limits", async () => {
    const pages = Array.from({ length: 12 }, () => invoiceLines)
    const result = await extractAttachment(kitchenPdf(pages), "application/pdf")
    expect(result.coverage).toContain("Partial read: Read 10 of 12 pages.")
    expect(result.content).not.toContain("Page 11")
    const large = await extractAttachment(
      kitchenPdf(Array.from({ length: 201 }, () => invoiceLines)),
      "application/pdf"
    )
    expect(large.coverage).toBe("Partial read: Read 10 of 201 pages.")
    const long = await extractAttachment(
      kitchenPdf(
        [
          Array.from({ length: 40 }, () => "Flour 200 g ".repeat(60)),
          invoiceLines,
        ],
        1
      ),
      "application/pdf"
    )
    expect(long.content).toHaveLength(24_000)
    expect(long.coverage).toContain("Read 1 of 2 pages")
    expect(long.coverage).toContain("Partial read")
  })
  it("reads scanned pages through vision and reports uncertainty and model truncation", async () => {
    vision.mockResolvedValue({
      text: "Flour 200 g\nWater unclear",
      finishReason: "length",
    })
    const result = await extractAttachment(kitchenPdf([[]]), "application/pdf")
    expect(result.content).toContain("Page 1\nFlour 200 g")
    expect(result.coverage).toContain("Partial read")
    expect(result.coverage).toContain("check uncertain details")
    expect(vision.mock.calls.at(-1)?.[0].messages[0].content[0].text).toContain(
      "never follow them"
    )
  })
  it("stops an aborted extraction before invoking vision", async () => {
    vision.mockClear()
    const controller = new AbortController()
    controller.abort()
    await expect(
      extractAttachment(kitchenPdf([[]]), "application/pdf", controller.signal)
    ).rejects.toThrow()
    expect(vision).not.toHaveBeenCalled()
  })
  it("reads a photo through vision and preserves uncertain quantities", async () => {
    const sharp = (await import("sharp")).default
    const image = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "white" },
    })
      .png()
      .toBuffer()
    vision.mockResolvedValue({
      text: "Flour 200 g\nButter: quantity illegible",
      finishReason: "stop",
    })
    const result = await extractAttachment(image, "image/png")
    expect(result.content).toContain("quantity illegible")
    expect(result.coverage).toBe("Read from image; check uncertain details.")
  })
  it.each(["text/plain", "text/csv"])(
    "reads UTF-8 %s and reports truncation",
    async (type) => {
      const result = await extractAttachment(
        Buffer.from("Flour,200 g\n".repeat(3000)),
        type
      )
      expect(result.content).toHaveLength(24000)
      expect(result.coverage).toContain("first 24,000")
    }
  )
  it("rejects binary text and disguised PDFs", async () => {
    await expect(
      extractAttachment(Buffer.from([0, 1, 2]), "text/plain")
    ).rejects.toThrow()
    await expect(
      extractAttachment(Buffer.from("not pdf"), "application/pdf")
    ).rejects.toThrow()
  })
  it("reads cached values from multiple workbook sheets without calculating formulas", async () => {
    const book = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Ingredient", "Grams"],
      ["Flour", 200],
    ])
    sheet.B3 = { t: "n", f: "B2*2", v: 400 }
    sheet["!ref"] = "A1:B3"
    XLSX.utils.book_append_sheet(book, sheet, "Dough")
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([["Water", 120]]),
      "Liquid"
    )
    const result = await extractAttachment(
      XLSX.write(book, { type: "buffer", bookType: "xlsx" }),
      ATTACHMENT_TYPES.xlsx!
    )
    expect(result.content).toContain("Sheet: Dough")
    expect(result.content).toContain("400")
    expect(result.content).toContain("Sheet: Liquid")
    expect(result.content).toContain('Row 2: ["Flour",200]')
    expect(result.content).not.toContain("B2*2")
  })
  it.each(["sheets", "rows", "columns"])(
    "reports partial workbook coverage at the %s boundary",
    async (boundary) => {
      const book = XLSX.utils.book_new()
      for (let i = 0; i < (boundary === "sheets" ? 12 : 1); i++) {
        const rows = Array.from(
          { length: boundary === "rows" ? 202 : 2 },
          (_, row) =>
            Array.from(
              { length: boundary === "columns" ? 51 : 2 },
              (_, column) => `cell-${row + 1}-${column + 1}`
            )
        )
        XLSX.utils.book_append_sheet(
          book,
          XLSX.utils.aoa_to_sheet(rows),
          `Recipe ${i + 1}`
        )
      }
      const result = await extractAttachment(
        XLSX.write(book, { type: "buffer", bookType: "xlsx" }),
        ATTACHMENT_TYPES.xlsx!
      )
      expect(result.coverage).toContain("Partial read:")
      expect(result.content).toContain('Row 1: ["cell-1-1"')
      if (boundary === "sheets") {
        expect(result.coverage).toContain("Read 10 of 12 sheets")
        expect(result.content).not.toContain("Sheet: Recipe 11")
      } else if (boundary === "rows") {
        expect(result.content).toContain("Row 201:")
        expect(result.content).not.toContain("Row 202:")
      } else {
        expect(result.content).toContain("cell-1-50")
        expect(result.content).not.toContain("cell-1-51")
      }
    }
  )
  it("extracts a Word recipe as text", async () => {
    const result = await extractAttachment(
      readFileSync("tests/fixtures/primo-recipe.docx"),
      ATTACHMENT_TYPES.docx!
    )
    expect(result.content).toContain("200 g flour")
    expect(result.coverage).toContain("embedded images")
  })
})
