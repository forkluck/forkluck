import "server-only"

import { getDocumentProxy } from "unpdf"

import { ImportTooComplexError, PDF_LIMITS } from "@/lib/import-limits"
import type { PageSize } from "@/lib/invoice-import"
import type { TemplateLine } from "@/lib/invoice-template"

/**
 * Text-layer extraction for digitally generated invoice PDFs (the normal
 * case — supplier systems emit real text, not scans), using unpdf's
 * serverless build of Mozilla's pdf.js. Positions come back with each text
 * item so the template parser can reconstruct table columns. Costs nothing
 * and never leaves the box; OCR/AI is only for scans and unknown layouts.
 */

export type PdfTextResult = {
  /** True when the PDF has (almost) no text layer — a scan or photo print. */
  scanned: boolean
  pages: TemplateLine[][]
  /** Each page's unscaled size, so a line's geometry can be read as fractions
   * of the page the reviewer is looking at. Parallel to `pages`. */
  pageSizes: PageSize[]
}

type RawItem = {
  str?: string
  transform?: number[]
  width?: number
  height?: number
}

type PageItem = {
  text: string
  x: number
  y: number
  width: number
  height: number
}

const LINE_Y_TOLERANCE = 2.5
const MIN_CHARS_PER_PAGE = 40

/**
 * Read one page's text items in stream chunks, counting against
 * {@link PDF_LIMITS} as each chunk lands.
 *
 * `getTextContent()` would resolve a single array holding every operator's
 * output, so a page that expands into millions of fragments is fully
 * materialized before any count can look at it. Reading the same content as a
 * stream lets a hostile page be abandoned after its first chunk: cancelling
 * the reader stops pdf.js decoding the rest.
 */
async function readPageItems(
  page: { streamTextContent(): ReadableStream },
  pageNumber: number,
  charsSoFar: number,
  signal?: AbortSignal
): Promise<PageItem[]> {
  const reader = (
    page.streamTextContent() as ReadableStream<{ items: RawItem[] }>
  ).getReader()
  const items: PageItem[] = []
  let itemCount = 0
  let totalChars = charsSoFar
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener("abort", cancel, { once: true })

  try {
    for (;;) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      if (done) break

      itemCount += value.items.length
      if (itemCount > PDF_LIMITS.itemsPerPage) {
        throw new ImportTooComplexError(
          `Page ${pageNumber} of that PDF has too many text fragments to process.`
        )
      }

      for (const item of value.items) {
        if (typeof item.str !== "string" || !item.transform) continue
        const text = item.str.trim()
        if (text === "") continue
        totalChars += text.length
        if (totalChars > PDF_LIMITS.totalCharacters) {
          throw new ImportTooComplexError(
            "That PDF contains too much text to process."
          )
        }
        items.push({
          text,
          x: item.transform[4],
          y: item.transform[5],
          width: item.width ?? 0,
          // pdf.js reports height 0 for some fonts; transform[3] is the glyph
          // scale, which is the font size in those cases.
          height: item.height || Math.abs(item.transform[3]),
        })
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel)
    // pdf.js requires a reason: cancelling is what stops it decoding the rest.
    await reader.cancel(new Error("text extraction stopped")).catch(() => {})
  }

  return items
}

export async function extractPdfTextLines(
  base64: string,
  options: { maxPages?: number; signal?: AbortSignal } = {}
): Promise<PdfTextResult> {
  options.signal?.throwIfAborted()
  const data = new Uint8Array(Buffer.from(base64, "base64"))
  const pdf = await getDocumentProxy(data)

  try {
    // Full invoice reads reject oversized documents. A bounded Primo excerpt
    // reads only its requested prefix and reports the omitted pages.
    const pageLimit = Math.min(pdf.numPages, options.maxPages ?? pdf.numPages)
    if (pageLimit > PDF_LIMITS.pages) {
      throw new ImportTooComplexError(
        `That PDF has ${pdf.numPages} pages; the limit is ${PDF_LIMITS.pages}.`
      )
    }

    const pages: TemplateLine[][] = []
    const pageSizes: PageSize[] = []
    let totalChars = 0

    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber++) {
      options.signal?.throwIfAborted()
      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      pageSizes.push({ width: viewport.width, height: viewport.height })
      const items = await readPageItems(
        page,
        pageNumber,
        totalChars,
        options.signal
      )
      totalChars += items.reduce((sum, item) => sum + item.text.length, 0)

      // Cluster items into visual lines by y (PDF origin is bottom-left, so
      // higher y = higher on the page), then order items left to right.
      const lines: Array<{
        y: number
        height: number
        items: Array<{ x: number; width: number; text: string }>
      }> = []
      for (const item of items.sort((left, right) => right.y - left.y)) {
        const cell = { x: item.x, width: item.width, text: item.text }
        const line = lines.find(
          (candidate) => Math.abs(candidate.y - item.y) <= LINE_Y_TOLERANCE
        )
        if (line) {
          line.items.push(cell)
          line.height = Math.max(line.height, item.height)
        } else {
          lines.push({ y: item.y, height: item.height, items: [cell] })
        }
      }
      pages.push(
        lines.map((line) => {
          const ordered = [...line.items].sort(
            (left, right) => left.x - right.x
          )
          return {
            text: ordered.map((item) => item.text).join(" "),
            items: ordered,
            page: pageNumber - 1,
            y: line.y,
            height: line.height,
          }
        })
      )
    }

    return {
      scanned: totalChars < MIN_CHARS_PER_PAGE * Math.max(1, pages.length),
      pages,
      pageSizes,
    }
  } finally {
    await pdf.cleanup()
  }
}
