import { deflateSync } from "node:zlib"

import { describe, expect, it, vi } from "vitest"

import { ImportTooComplexError, PDF_LIMITS } from "@/lib/import-limits"

/**
 * The PDF ceilings are ceilings on *decoding*, not on the finished result.
 * A content stream is compressed: a few kilobytes of FlateDecode can expand
 * into millions of text-showing operators, and reading a page's text content
 * as one array would materialize every one of them before a count could look
 * at the length. These fixtures are therefore real PDFs built here — hostile
 * ones are genuinely hostile, and the assertion is that extraction gives up
 * partway through rather than after the page has fully expanded.
 */

vi.mock("server-only", () => ({}))
// Reached only through `import-limits`; nothing on this path reads a workbook.
vi.mock("xlsx", () => ({ utils: {} }))

const { extractPdfTextLines } = await import("@/lib/pdf-text")

/**
 * A PDF whose FlateDecode content stream shows `text` `count` times per page.
 * Every page shares the one stream, so the upload stays small however much it
 * expands into.
 */
function operatorHeavyPdf(count: number, text = "x", pages = 1): string {
  const operators = ["BT", "/F1 8 Tf"]
  for (let index = 0; index < count; index += 1) {
    operators.push(
      `1 0 0 1 ${(index % 500) + 10} ${((index * 7) % 700) + 10} Tm`,
      `(${text}) Tj`
    )
  }
  operators.push("ET")
  const content = deflateSync(Buffer.from(operators.join("\n"), "latin1"))

  const contentRef = pages + 3
  const fontRef = pages + 4
  const kids = Array.from({ length: pages }, (_, index) => `${index + 3} 0 R`)
  const bodies: Array<string | null> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`,
    ...kids.map(
      () =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontRef} 0 R >> >> /Contents ${contentRef} 0 R >>`
    ),
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n")]
  const offsets: number[] = []
  let length = chunks[0].length
  bodies.forEach((body, index) => {
    offsets.push(length)
    const parts =
      body === null
        ? [
            Buffer.from(
              `${index + 1} 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`
            ),
            content,
            Buffer.from("\nendstream\nendobj\n"),
          ]
        : [Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`)]
    for (const part of parts) {
      chunks.push(part)
      length += part.length
    }
  })

  const table = offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")
  chunks.push(
    Buffer.from(
      `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${table}` +
        `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`
    )
  )

  return Buffer.concat(chunks).toString("base64")
}

describe("extractPdfTextLines", () => {
  it("reads an ordinary invoice-sized page into positioned lines", async () => {
    const result = await extractPdfTextLines(operatorHeavyPdf(200, "carrots"))

    expect(result.scanned).toBe(false)
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0]!.length).toBeGreaterThan(0)
    expect(result.pages[0]![0]!.text).toContain("carrots")
    // The page's own size, and enough geometry per line to place it on it.
    expect(result.pageSizes).toEqual([{ width: 612, height: 792 }])
    const line = result.pages[0]![0]!
    expect(line.page).toBe(0)
    expect(line.y).toBeGreaterThan(0)
    expect(line.height).toBeGreaterThan(0)
    expect(line.items[0]!.width).toBeGreaterThan(0)
  })

  it("reports a page with almost no text as scanned", async () => {
    const result = await extractPdfTextLines(operatorHeavyPdf(2, "ab"))

    expect(result.scanned).toBe(true)
  })

  it("refuses an operator-heavy page while it is still decoding", async () => {
    // Three times the fragment ceiling, from a few kilobytes of upload. The
    // limit has to bite mid-stream: waiting for the whole page would mean
    // building all 60,000 items first.
    const hostile = operatorHeavyPdf(3 * PDF_LIMITS.itemsPerPage)
    expect(Buffer.from(hostile, "base64").length).toBeLessThan(64 * 1024)

    const before = process.memoryUsage().heapUsed
    await expect(extractPdfTextLines(hostile)).rejects.toThrow(
      ImportTooComplexError
    )
    const growth = process.memoryUsage().heapUsed - before

    expect(growth).toBeLessThan(128 * 1024 * 1024)
  })

  it("names the page whose fragments overflow", async () => {
    await expect(
      extractPdfTextLines(operatorHeavyPdf(PDF_LIMITS.itemsPerPage + 500))
    ).rejects.toThrow(/Page 1 of that PDF has too many text fragments/)
  })

  it("refuses a document whose pages are each legal but total too much text", async () => {
    // Every page sits at the fragment ceiling, so only the running character
    // total across pages can catch this one.
    const result = extractPdfTextLines(
      operatorHeavyPdf(PDF_LIMITS.itemsPerPage, "y".repeat(128), 3)
    )

    await expect(result).rejects.toThrow(/too much text to process/)
  }, 30_000)
})
