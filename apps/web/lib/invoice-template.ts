import type {
  ExtractedBox,
  InvoiceExtraction,
  PageSize,
} from "@/lib/invoice-import"

/**
 * Deterministic, template-based invoice parsing over a PDF's text layer — the
 * invoice2data idea (one template per supplier) implemented natively, so
 * standard invoices cost nothing to read and never touch an AI. The parser is
 * deliberately strict: every gate below must pass (columns found, every line
 * priced, quantity × unit price ≈ amount, lines sum to the printed total) or
 * it returns null and the caller falls back to review/AI. A wrong parse must
 * never come out of here — a deferred one is fine.
 *
 * Output is the same InvoiceExtraction shape the AI produces (money as
 * printed decimal strings), so everything downstream — normalization, the
 * Django probe, the review queue — is identical for both paths.
 */

export type TemplateLine = {
  text: string
  items: Array<{ x: number; width: number; text: string }>
  /** 0-based index of the page this line was read from. */
  page: number
  /** Baseline y in PDF space, which grows upward from the bottom-left. */
  y: number
  /** Tallest text item on the line. */
  height: number
}

const MONEY_PATTERN = /^\(?-?\$?\d[\d,]*\.\d{2}\)?$/
const DATE_PATTERN = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/
// Baldor document numbers: IV101-0027916481 invoices, CR101-… credit memos.
const BALDOR_NUMBER_PATTERN = /\b((IV|CR)\d{2,4}-\d{6,})\b/i
// "fee" needs both boundaries: COFFEE/TOFFEE end in "fee", FEED starts with it.
const NON_PRODUCT_PATTERN =
  /fuel|surcharge|deliver|freight|shipping|deposit|\bfee\b/i
// The same charges printed in the totals block instead of the item table.
// "\btax\b" deliberately misses "Nontaxable SubTotal", which is not a charge.
const HEADER_CHARGE_PATTERN =
  /\btax(es)?\b|surcharge|deliver|freight|shipping|\bfee\b/i
// Baldor embeds the pack in the description ("… 36X1 LB PLUGRA", "… 2.5 LB",
// "SCALLIONS 48 CT (4X12 CT)"). The last pack-looking token wins, whichever
// family it names — the importer costs a case of gallons or of pieces in the
// unit it was bought by, so there is nothing left to defer.
const PACK_IN_DESCRIPTION_PATTERN =
  /\b\d+(?:\.\d+)?\s*(?:X\s*\d+(?:\.\d+)?\s*)?(?:FL ?OZ|LBS?|OZ|KGS?|GAL|QT|PT|ML|L|G|CT|DOZ|DZ|EA|PK|CS)\b/gi

function packSizeFromDescription(description: string): string | null {
  const matches = [...description.matchAll(PACK_IN_DESCRIPTION_PATTERN)]
  if (matches.length === 0) return null
  return matches[matches.length - 1][0].toUpperCase()
}

function moneyToCents(token: string): number | null {
  let text = token.replace(/[$\s]/g, "")
  let negative = false
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true
    text = text.slice(1, -1)
  }
  if (text.startsWith("-")) {
    negative = true
    text = text.slice(1)
  }
  if (!/^\d[\d,]*\.\d{2}$/.test(text)) return null
  const cents = Math.round(Number(text.replaceAll(",", "")) * 100)
  return negative ? -cents : cents
}

/** Back to the printed decimal-string shape the extraction schema carries. */
function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? "-" : ""
  const absolute = Math.abs(cents)
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`
}

function isoDate(text: string): string | null {
  const match = text.match(DATE_PATTERN)
  if (!match) return null
  const month = Number(match[1])
  const day = Number(match[2])
  let year = Number(match[3])
  if (year < 100) year += 2000
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

/**
 * The money printed on the last line whose text carries `label` — Baldor's
 * totals block prints each label and its amount on one line ("Nontaxable
 * SubTotal 280.99"), sometimes sharing that line with unrelated boilerplate,
 * so the rightmost money on the line is the cell. Null when no line carries
 * the label or the label's line prints no money.
 */
function labelledAmount(lines: TemplateLine[], label: RegExp): number | null {
  let amount: number | null = null
  for (const line of lines) {
    if (!label.test(line.text)) continue
    const moneys = line.items
      .map((item) => item.text.trim())
      .filter((token) => MONEY_PATTERN.test(token))
    if (moneys.length === 0) continue
    amount = moneyToCents(moneys[moneys.length - 1])
  }
  return amount
}

type ColumnMap = {
  boundaries: number[]
  names: string[]
}

/** Locate the item-table header row and turn label positions into column
 * ranges (midpoints between labels), so each cell lands in one column even
 * when numbers are right-aligned. */
function findColumns(lines: TemplateLine[]): ColumnMap | null {
  for (const line of lines) {
    const lower = line.text.toLowerCase()
    if (!lower.includes("shipped") || !/descr/i.test(lower)) continue
    // Header labels can arrive merged ("Unit Price" as one text item) or
    // split ("Unit" + "Price"), and Baldor has both an "Item" column and an
    // "Item Description" column — hence the explicit look-ahead.
    const tokens = line.items.map((item) => ({
      x: item.x,
      label: item.text.toLowerCase().replace(/[^a-z.]/g, ""),
    }))
    const labels: Array<{ name: string; x: number }> = []
    for (let index = 0; index < tokens.length; index++) {
      const { x, label } = tokens[index]
      const next = tokens[index + 1]?.label
      if (label === "ordered") labels.push({ name: "ordered", x })
      else if (label === "shipped") labels.push({ name: "shipped", x })
      // Printed as "B.O" (no trailing dot) on real invoices.
      else if (label.replaceAll(".", "") === "bo")
        labels.push({ name: "bo", x })
      else if (label === "u/m" || label === "um") labels.push({ name: "um", x })
      else if (label === "item" && next === "description") {
        labels.push({ name: "description", x })
        index++
      } else if (label === "item") labels.push({ name: "item", x })
      else if (label === "itemdescription" || label.startsWith("descr"))
        labels.push({ name: "description", x })
      else if (label === "origin") labels.push({ name: "origin", x })
      else if (label === "unit" && next === "price") {
        labels.push({ name: "unitprice", x })
        index++
      } else if (label === "unitprice") labels.push({ name: "unitprice", x })
      else if (label === "extended" && next === "price") {
        labels.push({ name: "extended", x })
        index++
      } else if (label === "extendedprice" || label === "extended")
        labels.push({ name: "extended", x })
    }
    const names = labels.map((label) => label.name)
    if (
      names.includes("shipped") &&
      names.includes("item") &&
      names.includes("description") &&
      names.includes("extended")
    ) {
      const sorted = [...labels].sort((left, right) => left.x - right.x)
      const boundaries = sorted.map((label, index) =>
        index === 0 ? -Infinity : (sorted[index - 1].x + label.x) / 2
      )
      return { boundaries, names: sorted.map((label) => label.name) }
    }
  }
  return null
}

const clampFraction = (value: number): number => Math.min(1, Math.max(0, value))

/**
 * Where an item row sits on its page, in the field the model fills but as
 * fractions from the top-left, which normalizeBox reads as they are. The text
 * layer measures from the bottom-left and gives a baseline, so the top edge is
 * the baseline plus the tallest glyph and the bottom edge drops a quarter of
 * that below it for descenders. Null when the page's size is unknown.
 */
function boxForLine(
  line: TemplateLine,
  size: PageSize | undefined
): ExtractedBox | null {
  if (!size || size.width <= 0 || size.height <= 0) return null
  const left = Math.min(...line.items.map((item) => item.x))
  const right = Math.max(...line.items.map((item) => item.x + item.width))
  return {
    page: line.page,
    bbox_2d: [
      clampFraction(left / size.width),
      clampFraction(1 - (line.y + line.height) / size.height),
      clampFraction(right / size.width),
      clampFraction(1 - (line.y - 0.25 * line.height) / size.height),
    ],
  }
}

function columnFor(map: ColumnMap, x: number): string {
  let column = map.names[0]
  for (let index = 0; index < map.names.length; index++) {
    if (x >= map.boundaries[index]) column = map.names[index]
  }
  return column
}

function cells(map: ColumnMap, line: TemplateLine): Record<string, string> {
  const result: Record<string, string> = {}
  for (const item of line.items) {
    const column = columnFor(map, item.x)
    result[column] = result[column]
      ? `${result[column]} ${item.text}`
      : item.text
  }
  return result
}

/**
 * The Baldor Specialty Foods template. Returns null whenever anything about
 * the document doesn't line up — the caller treats null as "let the user's
 * optional AI key (or a future template) handle it".
 */
export function parseInvoiceFromTextLines(
  pages: TemplateLine[][],
  /** Each page's unscaled size, from the same read as `pages`. Without it the
   * emitted lines carry no box. */
  pageSizes: PageSize[] = []
): InvoiceExtraction | null {
  const lines = pages.flat()
  if (lines.length === 0) return null
  const allText = lines.map((line) => line.text).join("\n")

  if (!/baldor/i.test(allText)) return null

  const numberMatch = allText.match(BALDOR_NUMBER_PATTERN)
  if (!numberMatch) return null
  const invoiceNumber = numberMatch[1].toUpperCase()
  const documentType = invoiceNumber.startsWith("CR")
    ? "credit_memo"
    : "invoice"

  // Prefer the explicitly labeled date; degrade to any dated line. Money
  // correctness is protected by the arithmetic gates below, and the date is
  // editable in review either way.
  const dateLine =
    lines.find(
      (line) =>
        /invoice date|credit date/i.test(line.text) &&
        DATE_PATTERN.test(line.text)
    ) ??
    lines.find(
      (line) => /date/i.test(line.text) && DATE_PATTERN.test(line.text)
    ) ??
    lines.find((line) => DATE_PATTERN.test(line.text))
  const invoiceDate = dateLine ? isoDate(dateLine.text) : null
  if (!invoiceDate) return null

  const columns = findColumns(lines)
  if (!columns) return null

  // Rows between the header and the totals block that carry an extended
  // amount are line items; everything else (addresses, terms) has no money
  // in the extended column.
  const extractionLines: InvoiceExtraction["lines"] = []
  const itemRows = new Set<TemplateLine>()
  for (const line of lines) {
    const row = cells(columns, line)
    const extended = row.extended?.trim()
    if (!extended || !MONEY_PATTERN.test(extended)) continue
    if (/total|balance|remit|payment/i.test(line.text)) continue
    const description = row.description?.trim()
    const sku = row.item?.trim()
    if (!description || !sku || MONEY_PATTERN.test(sku)) continue
    itemRows.add(line)

    const quantity = row.shipped?.trim()
    const unitPrice = row.unitprice?.trim()
    extractionLines.push({
      lineNumber: extractionLines.length + 1,
      sku,
      description,
      quantity:
        quantity && /^-?\d[\d,]*(\.\d+)?$/.test(quantity) ? quantity : null,
      unit: row.um?.trim() || null,
      packSize: packSizeFromDescription(description),
      unitPrice: unitPrice && MONEY_PATTERN.test(unitPrice) ? unitPrice : null,
      lineAmount: extended,
      suggestedCategory: NON_PRODUCT_PATTERN.test(description)
        ? "Other"
        : "Ingredients",
      uncertain: false,
      uncertainReason: null,
      box: boxForLine(line, pageSizes[line.page]),
    })
  }
  if (extractionLines.length === 0) return null

  // Printed grand total: the last money on a "total"-ish line. Real Baldor
  // invoices print "Total Invoice"; keep the other wordings as fallbacks.
  let totalAmount: string | null = null
  for (const line of lines) {
    if (
      !/total invoice|invoice total|credit total|total due|amount due|balance due|^total\b/i.test(
        line.text.trim()
      )
    ) {
      continue
    }
    const moneys = line.items
      .map((item) => item.text.trim())
      .filter((text) => MONEY_PATTERN.test(text))
    if (moneys.length > 0) totalAmount = moneys[moneys.length - 1]
  }
  if (totalAmount === null) return null

  // Tax and fees printed in the totals block rather than the item table: part
  // of the printed total, so they must join the reconciliation below.
  let otherChargesCents = 0
  for (const line of lines) {
    if (itemRows.has(line)) continue
    const text = line.text.trim()
    if (!HEADER_CHARGE_PATTERN.test(text)) continue
    if (/total|balance|remit|payment|subtotal/i.test(text)) continue
    const moneys = line.items
      .map((item) => item.text.trim())
      .filter((token) => MONEY_PATTERN.test(token))
    if (moneys.length === 0) continue
    const amount = moneyToCents(moneys[moneys.length - 1])
    if (amount === null) return null
    otherChargesCents += amount
  }

  // Confidence gates — all arithmetic must reconcile or we defer.
  let lineSum = 0
  for (const line of extractionLines) {
    const amount = moneyToCents(line.lineAmount ?? "")
    if (amount === null) return null
    lineSum += amount
    if (line.quantity !== null && line.unitPrice !== null) {
      const quantity = Number(line.quantity.replaceAll(",", ""))
      const unitCents = moneyToCents(line.unitPrice)
      if (unitCents === null || !Number.isFinite(quantity)) return null
      if (Math.abs(quantity * unitCents - amount) > 2) return null
    }
  }
  const totalCents = moneyToCents(totalAmount)
  if (totalCents === null) return null
  if (Math.abs(lineSum + otherChargesCents - totalCents) > 50) return null
  if (documentType === "credit_memo" && totalCents > 0) {
    // Baldor prints credit totals in parentheses; a positive total on a CR
    // document means we misread something.
    return null
  }

  // Baldor prints its subtotal in two halves and its tax on its own line.
  // `\b` keeps "Taxable SubTotal" out of "Nontaxable SubTotal" and keeps both
  // subtotals out of the tax line. A document printing neither half reports no
  // subtotal rather than a computed one.
  const nontaxableCents = labelledAmount(lines, /nontaxable\s+subtotal/i)
  const taxableCents = labelledAmount(lines, /\btaxable\s+subtotal/i)
  const subtotalCents =
    nontaxableCents === null && taxableCents === null
      ? null
      : (nontaxableCents ?? 0) + (taxableCents ?? 0)
  const taxCents = labelledAmount(lines, /\btax\b/i)
  // Baldor prints payment terms ("Net 14"), not a due date. Computing one from
  // the terms would be a guess, so only a printed due date is read.
  const dueDateLine = lines.find(
    (line) => /due date/i.test(line.text) && DATE_PATTERN.test(line.text)
  )

  const supplierLine = lines.find((line) => /baldor/i.test(line.text))
  const supplierName =
    supplierLine?.items
      .map((item) => item.text)
      .find((text) => /baldor/i.test(text)) ?? "Baldor Specialty Foods Inc."

  return {
    supplierName,
    documentType,
    invoiceNumber,
    invoiceDate,
    totalAmount,
    // Nothing in the text layer tells us the printed currency reliably, so the
    // template stays silent rather than asserting one.
    currency: null,
    otherChargesAmount:
      otherChargesCents === 0 ? null : centsToDecimal(otherChargesCents),
    dueDate: dueDateLine ? isoDate(dueDateLine.text) : null,
    subtotalAmount:
      subtotalCents === null ? null : centsToDecimal(subtotalCents),
    taxAmount: taxCents === null ? null : centsToDecimal(taxCents),
    lines: extractionLines,
    notUsable: null,
  }
}
