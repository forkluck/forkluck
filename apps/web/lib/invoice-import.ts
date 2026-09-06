import { z } from "zod"

import type {
  ExpenseCategoryRow,
  InvoiceDocumentType,
} from "@/lib/backend/types"
import {
  invoiceLinePackPriceCents,
  resolveInvoiceLinePack,
} from "./invoice-line-cost"
import { normalizeIngredientName } from "./pricing"
import { normalizePackUnit, type PackUnitSlug } from "./unit-registry"

export { packUnitFromLabel } from "./invoice-line-cost"

/**
 * Pure invoice-import logic: the extraction schema Claude fills in, money and
 * pack normalization, and the merge with the Django line-status probe that
 * stamps each line for the review queue. Ambiguous values are surfaced for
 * review instead of guessed — the same principle as the spreadsheet import.
 * No AI SDK imports here; the Claude call lives in lib/invoice-extract.ts.
 */

// --- Extraction schema (Claude structured output + checked-in fixtures) -----

// Every field carries its own instruction: zodOutputFormat forwards .describe()
// text to the model, so this schema is the per-field prompt and there is one
// place a field's meaning is written.

/**
 * Where a line sits on the page it was read from, so the reviewer can point at
 * it on the document. `page` is 0-based; x/y are fractions of the page (or
 * photo) width and height, origin top-left, each 0..1.
 */
export type LineBox = {
  page: number
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Pixel size of one page as the reader saw it — a rasterized PDF page or a
 * prepared photo. Only used to normalize a box answered in pixels. */
export type PageSize = { width: number; height: number }

/**
 * Which document inside a file this result is. One file may print several
 * supplier documents — a scanned bundle of receipts, a photo of three tickets
 * side by side — and each is identified by the file plus this 0-based index.
 * A part is either a contiguous page range of a PDF (0-based, inclusive), a
 * region of the prepared photo (fractions from the top-left), or neither when
 * the whole file is the document.
 */
export type DocumentPart = {
  part: number
  pages: { start: number; end: number } | null
  region: { x0: number; y0: number; x1: number; y1: number } | null
}

/** The one document a normal file holds. */
export const WHOLE_FILE_PART: DocumentPart = {
  part: 0,
  pages: null,
  region: null,
}

/**
 * What a reader is told when a file holds several documents that could not be
 * separated: the count it saw, and the one thing that fixes it.
 */
export function bundleRefusal(count: number, kind: "photo" | "scan"): string {
  const documents = count > 0 ? `${count} receipts` : "several receipts"
  return kind === "photo"
    ? `This photo shows ${documents} and they could not be separated — take one photo per receipt.`
    : `This scan holds ${documents} and they could not be separated — save one file per receipt.`
}

/**
 * The schema asks a model that meets a bundle to refuse the file and say how
 * many documents it saw, rather than extracting one of them. This reads that
 * verdict back: the count when the reason prints one, 0 when it says "several"
 * without a number, and null when the file was refused for some other reason
 * (a menu, a bank statement) that splitting would not fix.
 */
export function multiDocumentCount(reason: string): number | null {
  if (!/receipt|invoice|document|ticket/i.test(reason)) return null
  const digits = reason.match(
    /\b(\d{1,3})\s+(?:separate\s+|different\s+)?(?:receipts|invoices|documents|tickets)\b/i
  )
  if (digits) return Number(digits[1])
  const words: Record<string, number> = {
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  }
  const word = reason.match(
    /\b(two|three|four|five|six|seven|eight|nine|ten)\s+(?:separate\s+|different\s+)?(?:receipts|invoices|documents|tickets)\b/i
  )
  if (word) return words[word[1].toLowerCase()]
  return /\b(multiple|several|more than one|bundle|many)\b/i.test(reason)
    ? 0
    : null
}

/** The single wording for a file the model refused to read. */
export function notUsableMessage(reason: string): string {
  return `This file doesn't look like a supplier invoice: ${reason}`
}

const lineBoxSchema = z.object({
  page: z.number(),
  x0: z.number(),
  y0: z.number(),
  x1: z.number(),
  y1: z.number(),
})

/**
 * The box as the model is asked for it. `bbox_2d` in a 0..1000 frame is the
 * name and unit Qwen3-VL grounds in; asked for the same rectangle as `box`
 * fractions it answered null for every line. The text-layer parser fills the
 * field with fractions, and normalizeBox reads either.
 *
 * The field is nullable but carries no `.default(null)`: a default reaches
 * the model as `"default": null` in the JSON schema, and it then takes it for
 * every line. Stored documents get the default from storedExtractedLineSchema.
 */
const extractedBoxSchema = z.object({
  page: z.number().describe("Page index from 0."),
  bbox_2d: z
    .array(z.number())
    .length(4)
    .describe(
      "[x0, y0, x1, y1] tightly enclosing this item's printed description and extended amount, in the 0-1000 coordinate system used for grounding, origin top-left. Include a separate quantity @ price row ONLY when it belongs to this item; exclude other items, their quantity rows, tax and totals."
    ),
})

export type ExtractedBox = z.infer<typeof extractedBoxSchema>

export const extractedLineSchema = z.object({
  lineNumber: z.number().int().describe("1-based position in the line table."),
  sku: z
    .string()
    .nullable()
    .describe(
      "The supplier's item/product code column when one exists (Baldor prints it as the Item code); null when the line has none."
    ),
  description: z.string().describe("Item description exactly as printed."),
  quantity: z
    .string()
    .nullable()
    .describe(
      'Quantity shipped as a decimal string exactly as printed, e.g. "3" or "12.5". Null when not printed; never default to 1, convert units or calculate an unprinted quantity. A separate quantity @ price row can belong to the following item: match its arithmetic to that item\'s printed amount.'
    ),
  unit: z
    .string()
    .nullable()
    .describe(
      'Order unit label as printed: "CS", "LB", "EA"…; null when the line prints none. The tax flag a till receipt prints after the price (F, B, T, N) is not a unit, and neither is the "@" of "2 @ 3.99".'
    ),
  packSize: z
    .string()
    .nullable()
    .describe(
      'Pack description as printed, e.g. "24 X 1 PT" or "10 LB". Null when absent. A receipt\'s quantity @ price row is not a pack description; put those values in quantity and unitPrice instead.'
    ),
  unitPrice: z
    .string()
    .nullable()
    .describe(
      'Unit price as a decimal string exactly as printed, e.g. "1,234.56". On a quantity @ price row, this is the price after @. Null when no unit price is printed; do not copy the extended line amount into this field. Negative on credit and returned-item lines; parenthesized amounts like (73.50) are negative — keep the parentheses.'
    ),
  lineAmount: z
    .string()
    .nullable()
    .describe(
      "Extended line amount as a decimal string exactly as printed, with the same sign and parenthesis rules as unitPrice."
    ),
  suggestedCategory: z
    .string()
    .nullable()
    .describe(
      "One of the category names offered in the prompt, or null when unsure."
    ),
  uncertain: z
    .boolean()
    .describe(
      "True when any value on this line couldn't be read confidently. Never invent a value: leave the unreadable field null instead."
    ),
  uncertainReason: z
    .string()
    .nullable()
    .describe("Short reason this line is uncertain, or null."),
  box: extractedBoxSchema
    .nullable()
    .describe("Where this line sits on its page. Null when unsure."),
})

export const invoiceExtractionSchema = z.object({
  supplierName: z.string().describe("Supplier's business name as printed."),
  documentType: z
    .enum(["invoice", "credit_memo", "receipt", "refund"])
    .describe("What kind of supplier document this is."),
  invoiceNumber: z
    .string()
    .nullable()
    .describe(
      "Document number as printed: the invoice number, or on a till receipt the receipt or transaction number (RCPT, TRANS), never the register or operator number (OP#). Null when there is none."
    ),
  invoiceDate: z
    .string()
    .nullable()
    .describe("Document date formatted YYYY-MM-DD, or null when not printed."),
  totalAmount: z
    .string()
    .nullable()
    .describe("Grand total as printed; negative for credit memos and refunds."),
  currency: z
    .string()
    .nullable()
    .describe("Three-letter ISO 4217 code as printed, or null if not printed."),
  otherChargesAmount: z
    .string()
    .nullable()
    .describe(
      "Printed tax, delivery and other fees charged outside the line table, summed into one decimal string; null when the document prints none."
    ),
  // The three below are read for the invoice record, not for arithmetic: the
  // totals check keeps using otherChargesAmount alone, so tax is never counted
  // twice.
  dueDate: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'The due date the document prints, formatted YYYY-MM-DD. Read it only when it is printed: payment terms like "Net 14" are not a due date, and a due date must never be computed from them. Null when none is printed.'
    ),
  subtotalAmount: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "The subtotal the document prints before tax and other charges, as a decimal string exactly as printed; null when it prints none. Never add anything up to produce it."
    ),
  taxAmount: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "The tax the document prints, as a decimal string exactly as printed. This is the tax that is already part of otherChargesAmount and of totalAmount — repeat it here, never add it to either of them a second time. Null when the document prints no tax."
    ),
  lines: z
    .array(extractedLineSchema)
    .describe("Every line item in the item table, in printed order."),
  notUsable: z
    .string()
    .nullable()
    .describe(
      "Set to a short explanation instead of guessing when this file is not a supplier purchase document at all, and leave lines empty. Also set this when the file contains more than one separate receipt or invoice (a scanned bundle) — say how many, and do not extract any of them."
    ),
})

export type InvoiceExtraction = z.infer<typeof invoiceExtractionSchema>
export type ExtractedLine = z.infer<typeof extractedLineSchema>

// --- Probe response (Django invoice-line-status) ----------------------------

export type InvoiceLineStatusItem = {
  index: number
  supplierItem: {
    id: string
    ingredientId: string
    ingredientName: string
    title: string
    rawSize: string
    packPriceCents: number
    packAmount: number
    packUnit: PackUnitSlug
    /** Grams in the pack, null when its unit carries no weight of its own. */
    packGrams: number | null
    isPreferred: boolean
  } | null
  ignored: boolean
  matchedIngredientId: string | null
  matchedIngredientName: string | null
  lastCategoryId: string | null
}

/** The invoice a document would repeat: the row behind `duplicate`, so the
 *  review screen can show this receipt beside what is already on file. */
export type ExistingInvoiceRef = {
  /** The Django row id — what `deleteInvoice` takes. */
  id: string
  publicId: string
  invoiceNumber: string
  invoiceDate: string | null
  totalCents: number
  lineCount: number
  importedAt: string
}

export type InvoiceLineStatus = {
  items: InvoiceLineStatusItem[]
  duplicate: boolean
  /** The already-imported invoice behind `duplicate`, null when there is
   *  none or when the probe was asked no invoice header. */
  existingInvoice: ExistingInvoiceRef | null
  categories: ExpenseCategoryRow[]
  /** Present only when the probe was asked about a Drive file id. */
  driveFileKnown?: boolean
}

// --- Review-queue shapes -----------------------------------------------------

export type InvoiceCostDefaults = {
  name: string
  packAmount: number
  packUnit: PackUnitSlug
  /** Grams in the pack, null when its unit carries no weight of its own. */
  packGrams: number | null
  packPriceCents: number
  rawSize: string
  preferred: boolean
  ingredientId: string | null
}

export type InvoiceLineMatch =
  | {
      kind: "update"
      supplierItemId: string
      ingredientName: string
      cost: InvoiceCostDefaults
    }
  | {
      kind: "new"
      matchedIngredientName: string | null
      cost: InvoiceCostDefaults
    }
  | {
      kind: "review"
      reason: string
      suggestedName: string
      suggestedPackAmount: number | null
      suggestedPackUnit: PackUnitSlug | null
      suggestedPriceCents: number | null
      ingredientId: string | null
    }
  | { kind: "ignored" }
  | { kind: "expense-only"; note: string | null }

export type InvoiceLineEntry = {
  position: number
  sku: string
  itemKey: string
  description: string
  quantity: number | null
  unit: string
  packSize: string
  unitPriceCents: number | null
  lineAmountCents: number | null
  categoryId: string | null
  match: InvoiceLineMatch
  uncertain: boolean
  reason: string | null
  /** Where this line sits on the document, null when the read couldn't place it. */
  box: LineBox | null
  raw: ExtractedLine
}

export type InvoiceParseResult = {
  fileName: string
  /** Which document inside the file this is; the whole file for a normal
   * one-invoice PDF or photo. */
  part: DocumentPart
  driveFileId: string | null
  driveWebViewLink: string | null
  /** What read this file: "text-layer" (free, deterministic) or an AI model id. */
  extractionModel: string
  /** True when the validator sent this file to a second, tier-3 read and that
   * read won. */
  escalated: boolean
  /** The raw read this result was built from, before any normalization or
   * correction — the template path produces one as the model path does. Null
   * only for a Drive document the watcher stored before the read was kept. */
  extraction: InvoiceExtraction | null
  supplier: string
  supplierName: string
  documentType: InvoiceDocumentType
  invoiceNumber: string
  invoiceDate: string | null
  /** Printed due date, null when the document printed none. */
  dueDate: string | null
  /** ISO code the document printed, or null when it printed none. */
  currency: string | null
  totalCents: number | null
  /** Printed subtotal before tax and charges; null when none was printed. */
  subtotalCents: number | null
  /** Printed tax, already inside `totalCents`; null when none was printed. */
  taxCents: number | null
  duplicate: boolean
  /** The invoice this one would repeat, when `duplicate`. */
  existingInvoice: ExistingInvoiceRef | null
  totalsMismatch: string | null
  headerWarnings: string[]
  categories: ExpenseCategoryRow[]
  lines: InvoiceLineEntry[]
}

// --- Money / date / unit parsing ---------------------------------------------

/**
 * "1,234.56" → 123456, "-12.34" → -1234, "(12.34)" → -1234, "$0.00" → 0.
 * Anything unreadable returns null so the line lands in review.
 */
export function parseMoneyToCents(value: string | null): number | null {
  if (value === null) return null
  let text = value.trim().replace(/[$\s]/g, "")
  if (!text) return null
  let negative = false
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true
    text = text.slice(1, -1)
  }
  if (text.startsWith("-")) {
    negative = true
    text = text.slice(1)
  }
  if (!/^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(text)) return null
  // "1.234" with no comma anywhere is a European thousands separator far more
  // often than a three-decimal price, and reading it as 123¢ is a silent 1000×
  // misread that clears every arithmetic gate. Defer to review instead.
  if (/^\d+\.\d{3}$/.test(text)) return null
  const amount = Number(text.replaceAll(",", ""))
  if (!Number.isFinite(amount)) return null
  const cents = Math.round(amount * 100)
  return negative ? -cents : cents
}

export function parseQuantity(value: string | null): number | null {
  if (value === null) return null
  const text = value.trim().replaceAll(",", "")
  if (!text) return null
  const amount = Number(text)
  return Number.isFinite(amount) ? amount : null
}

function parseIsoDate(value: string | null): string | null {
  if (value === null) return null
  const text = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const parsed = new Date(`${text}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return null
  return text
}

const SUPPLIER_SUFFIXES = new Set([
  "co",
  "company",
  "corp",
  "corporation",
  "inc",
  "incorporated",
  "llc",
  "ltd",
])

/**
 * Stable per-supplier key from the printed name, so "Baldor Specialty Foods
 * Inc." and "BALDOR SPECIALTY FOODS" land on the same supplier items. Baldor
 * collapses to the short "baldor" key the spreadsheet import already writes.
 */
export function supplierKeyFromName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word && !SUPPLIER_SUFFIXES.has(word))
  if (cleaned[0] === "baldor") return "baldor"
  return cleaned.join(" ").slice(0, 64).trim()
}

/**
 * The key one supplier product is remembered under: the printed item code,
 * else the normalized description behind a `desc:` prefix no code can
 * collide with. A line with neither has no memory and stays expense-only.
 * `supplier_item_key` in domains/shared/supplier_import.py is the Python twin
 * and must not drift; the shared cases live in
 * tests/fixtures/supplier-item-keys.json.
 */
export function supplierItemKey(sku: string, description: string): string {
  let code = sku.trim().toLowerCase().slice(0, 120)
  // A model reading a photo sometimes fills the code column with "0" or a
  // dash; treating that as a code would file every such line under one key.
  if (code && (!/[\p{L}\p{N}]/u.test(code) || /^0+$/.test(code))) code = ""
  if (code) return code
  const normalized = normalizeIngredientName(description)
  return normalized ? `desc:${normalized}`.slice(0, 120) : ""
}

// --- Normalization ------------------------------------------------------------

export type NormalizedInvoiceLine = {
  position: number
  sku: string
  /** Memory key for this supplier product; empty when the line has none. */
  itemKey: string
  description: string
  quantity: number | null
  unit: string
  packSize: string
  unitPriceCents: number | null
  lineAmountCents: number | null
  suggestedCategory: string | null
  uncertain: boolean
  reason: string | null
  /** Where this line sits on the document, null when the read couldn't place it. */
  box: LineBox | null
  raw: ExtractedLine
}

export type NormalizedInvoice = {
  supplier: string
  supplierName: string
  documentType: InvoiceDocumentType
  invoiceNumber: string
  invoiceDate: string | null
  /** Printed due date, null when the document printed none. */
  dueDate: string | null
  /** ISO code the document printed, or null when it printed none. */
  currency: string | null
  totalCents: number | null
  /** Printed subtotal before tax and charges; null when none was printed. */
  subtotalCents: number | null
  /** Printed tax, already inside `totalCents`; null when none was printed. */
  taxCents: number | null
  totalsMismatch: string | null
  headerWarnings: string[]
  lines: NormalizedInvoiceLine[]
}

/** How many invoices one import carries: the dialog's batch cap, and what the
 * inbox reads at a time. Django caps the same batch at 500 lines in total. */
export const MAX_IMPORT_INVOICES = 40

/**
 * A line as a stored document carries it. Documents stored before the box
 * moved to `bbox_2d` hold the fraction box the model was asked for then; it
 * is read back into the field it is now, so those documents still open.
 */
const storedExtractedLineSchema = extractedLineSchema.extend({
  box: z.preprocess((value) => {
    const legacy = lineBoxSchema.safeParse(value)
    return legacy.success
      ? {
          page: legacy.data.page,
          bbox_2d: [
            legacy.data.x0,
            legacy.data.y0,
            legacy.data.x1,
            legacy.data.y1,
          ],
        }
      : value
  }, extractedBoxSchema.nullable().default(null)),
})

const normalizedLineSchema = z.object({
  position: z.number().int(),
  sku: z.string(),
  itemKey: z.string(),
  description: z.string(),
  quantity: z.number().nullable(),
  unit: z.string(),
  packSize: z.string(),
  unitPriceCents: z.number().int().nullable(),
  lineAmountCents: z.number().int().nullable(),
  suggestedCategory: z.string().nullable(),
  uncertain: z.boolean(),
  reason: z.string().nullable(),
  // Documents the watcher stored before boxes were read carry none.
  box: lineBoxSchema.nullable().default(null),
  raw: storedExtractedLineSchema,
})

/**
 * What the Drive reader stores against a `ready` row: the normalized invoice
 * plus what a review block needs about the file. Django keeps it as opaque
 * JSON and hands it back untouched, so the inbox validates it here before
 * building a review block out of it.
 */
export const storedDriveDocumentSchema = z.object({
  supplier: z.string(),
  supplierName: z.string(),
  documentType: z.enum(["invoice", "credit_memo", "receipt", "refund"]),
  invoiceNumber: z.string(),
  invoiceDate: z.string().nullable(),
  // Documents the watcher stored before these three were read carry none.
  dueDate: z.string().nullable().default(null),
  currency: z.string().nullable(),
  totalCents: z.number().int().nullable(),
  subtotalCents: z.number().int().nullable().default(null),
  taxCents: z.number().int().nullable().default(null),
  totalsMismatch: z.string().nullable(),
  headerWarnings: z.array(z.string()),
  lines: z.array(normalizedLineSchema),
  fileName: z.string(),
  driveWebViewLink: z.string().nullable(),
  extractionModel: z.string(),
  escalated: z.boolean(),
  // Rows the watcher stored before the read was kept have none; they still
  // open, they just carry no read to label.
  extraction: invoiceExtractionSchema
    .extend({ lines: z.array(storedExtractedLineSchema) })
    .nullable()
    .default(null),
})

export type StoredDriveDocument = z.infer<typeof storedDriveDocumentSchema>

function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : ""
  const absolute = Math.abs(cents)
  return `${sign}$${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`
}

/** Totals block, payment slip and footer wording of a till receipt, matched at
 * the start of the description; a product never starts with these. */
const RECEIPT_FOOTER_PATTERN =
  /^(sub ?total|total|tax|balance|change|cash|credit ?card|debit ?card|visa|amex|american express|mastercard|discover|card number|auth:|aid:|code:|rcpt|op#|verified by pin|customer copy|thank you|approved)\b/i

/** Whether an extracted line is a purchase the import keeps. Shared with the
 * eval so a read is scored on what the importer would keep. */
export function isPurchaseLine(line: ExtractedLine): boolean {
  const description = line.description
    .trim()
    // Till receipts commonly decorate totals with rules or asterisks, for
    // example "**** BALANCE". Those marks are presentation, not part of the
    // label, and must not let the totals block masquerade as a purchase.
    .replace(/^[^\p{L}\p{N}]+/u, "")
  return (
    !RECEIPT_FOOTER_PATTERN.test(description) &&
    (line.quantity !== null ||
      line.unitPrice !== null ||
      line.lineAmount !== null)
  )
}

/** Reconcile a printed total against purchase lines and out-of-table charges. */
export function invoiceTotalsMismatch(
  totalCents: number | null,
  lines: readonly { lineAmountCents: number | null }[],
  otherChargesCents = 0
): string | null {
  if (
    totalCents === null ||
    lines.length === 0 ||
    lines.some((line) => line.lineAmountCents === null)
  ) {
    return null
  }
  const knownLineTotal = lines.reduce(
    (sum, line) => sum + (line.lineAmountCents ?? 0),
    0
  )
  if (Math.abs(knownLineTotal + otherChargesCents - totalCents) <= 50) {
    return null
  }
  return otherChargesCents === 0
    ? `Line items add up to ${formatCents(knownLineTotal)} but the invoice total reads ${formatCents(totalCents)}.`
    : `Line items plus ${formatCents(otherChargesCents)} of tax and fees add up to ${formatCents(knownLineTotal + otherChargesCents)} but the invoice total reads ${formatCents(totalCents)}.`
}

/**
 * A till receipt prints a tax flag after the price ("2.99 F") and an "@"
 * between count and price ("2 @ 3.99"), and the reader keeps taking those for
 * the unit column, as it takes a bare count for one. Anything without a
 * letter, or a lone letter the unit registry does not know, is not a unit.
 */
export function cleanUnit(unit: string): string {
  const trimmed = unit.trim()
  if (!/\p{L}/u.test(trimmed)) return ""
  if (trimmed.length === 1 && normalizePackUnit(trimmed) === null) return ""
  return trimmed
}

/** Matches Django's per-import line cap, so a legitimately long invoice reads
 * as too long here instead of "malformed" after the extraction is paid for. */
const MAX_INVOICE_LINES = 500

const YEAR_MS = 365 * 24 * 60 * 60 * 1000

const clampFraction = (value: number): number => Math.min(1, Math.max(0, value))

/**
 * A box the reader placed, as fractions of the page. The model answers
 * `bbox_2d` in per-mille and the text-layer parser in fractions, and a vision
 * model sometimes answers in pixels anyway, so an out-of-range box is rescaled
 * — by 1000 when every coordinate fits per-mille, otherwise by the page's own
 * pixel size when the caller knows it — and dropped when neither applies or
 * the result is not a real rectangle.
 */
function normalizeBox(
  box: ExtractedLine["box"],
  pageSizes: PageSize[] | undefined
): LineBox | null {
  if (box === null) return null
  if (!Number.isFinite(box.page)) return null
  const page = Math.trunc(box.page)
  if (page < 0) return null
  if (pageSizes && page >= pageSizes.length) return null
  let [x0, y0, x1, y1] = box.bbox_2d
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null
  const largest = Math.max(x0, y0, x1, y1)
  if (largest > 1) {
    const size = pageSizes?.[page]
    if (largest <= 1000) {
      x0 /= 1000
      y0 /= 1000
      x1 /= 1000
      y1 /= 1000
    } else if (size && size.width > 0 && size.height > 0) {
      x0 /= size.width
      x1 /= size.width
      y0 /= size.height
      y1 /= size.height
    } else {
      return null
    }
  }
  const clamped = {
    page,
    x0: clampFraction(x0),
    y0: clampFraction(y0),
    x1: clampFraction(x1),
    y1: clampFraction(y1),
  }
  if (clamped.x1 <= clamped.x0 || clamped.y1 <= clamped.y0) return null
  return clamped
}

/** Older model reads sometimes put a receipt's price row in packSize. It is
 * printed evidence, not a pack, and must still take part in the amount check. */
function receiptPricePrefix(line: ExtractedLine) {
  const match = line.packSize?.match(
    /^\s*(\d+(?:\.\d+)?)\s*@\s*\$?(\d+(?:\.\d+)?)\s*$/
  )
  return match ? { quantity: match[1], unitPrice: match[2] } : null
}

/** Wegmans prints a quantity/price prefix above the item it belongs to. Vision
 * models sometimes attach it to the preceding item. Move only a contradictory
 * pair that uniquely fits the next, unquantified item on the same page. Amounts,
 * descriptions and document boxes remain on their original rows. */
function alignWegmansQuantities(
  lines: ExtractedLine[],
  pageSizes?: PageSize[]
): ExtractedLine[] {
  const aligned = lines.map((line) => ({ ...line }))
  for (let index = 0; index < aligned.length - 1; index += 1) {
    const line = aligned[index]
    const next = aligned[index + 1]
    const prefix = receiptPricePrefix(line)
    const pair = prefix ?? line
    const quantity = parseQuantity(pair.quantity)
    const price = parseMoneyToCents(pair.unitPrice)
    const amount = parseMoneyToCents(line.lineAmount)
    const nextAmount = parseMoneyToCents(next.lineAmount)
    const sourceBox = normalizeBox(line.box, pageSizes)
    const nextBox = normalizeBox(next.box, pageSizes)
    if (
      quantity === null ||
      quantity <= 0 ||
      price === null ||
      price <= 0 ||
      amount === null ||
      amount <= 0 ||
      nextAmount === null ||
      nextAmount <= 0 ||
      next.quantity !== null ||
      next.unitPrice !== null ||
      (prefix &&
        line.quantity !== null &&
        parseQuantity(line.quantity) !== quantity) ||
      line.uncertain ||
      next.uncertain ||
      cleanUnit(line.unit ?? "") !== "" ||
      !sourceBox ||
      !nextBox ||
      sourceBox.page !== nextBox.page ||
      sourceBox.y0 >= nextBox.y0
    )
      continue
    const extended = quantity * price
    if (Math.abs(extended - amount) <= 2 || Math.abs(extended - nextAmount) > 2)
      continue
    next.quantity = pair.quantity
    next.unitPrice = pair.unitPrice
    line.quantity = null
    line.unitPrice = null
    // Older reads put the same price calculation in the pack field.
    if (prefix) line.packSize = null
  }
  return aligned
}

/** Deterministic post-extraction pass: parse everything, verify arithmetic,
 * and route anything unreadable to review instead of guessing. */
export function normalizeInvoiceExtraction(
  extraction: InvoiceExtraction,
  workspaceCurrencyCode?: string,
  /** Pixel size of each page the reader showed the model, when it knows one —
   * how a box answered in pixels is turned back into fractions. */
  pageSizes?: PageSize[]
): NormalizedInvoice | { error: string } {
  if (extraction.notUsable) {
    return { error: notUsableMessage(extraction.notUsable) }
  }
  if (extraction.lines.length > MAX_INVOICE_LINES) {
    return {
      error: `That invoice has ${extraction.lines.length} lines; the limit is ${MAX_INVOICE_LINES}.`,
    }
  }
  // Clamps below match the import contract's caps (zod .max in actions.ts and
  // Django's optional_text limits) so one overlong AI string can't fail a batch.
  const supplierName = extraction.supplierName.trim().slice(0, 120)
  if (!supplierName) {
    return { error: "Couldn't read a supplier name from this file." }
  }
  const supplier = supplierKeyFromName(supplierName)
  if (!supplier) {
    return { error: "Couldn't read a supplier name from this file." }
  }

  const headerWarnings: string[] = []
  const invoiceDate = parseIsoDate(extraction.invoiceDate)
  if (extraction.invoiceDate && invoiceDate === null) {
    headerWarnings.push(
      `Couldn't read the invoice date "${extraction.invoiceDate}".`
    )
  } else if (invoiceDate === null) {
    headerWarnings.push("No invoice date found — set one before importing.")
  } else {
    // The date is what invoice listing and period comparison sort on, and it is
    // editable in review, so an implausible one is a warning rather than a stop.
    const age = Date.now() - Date.parse(`${invoiceDate}T00:00:00Z`)
    if (age < -YEAR_MS) {
      headerWarnings.push(`The invoice date ${invoiceDate} is in the future.`)
    } else if (age > 10 * YEAR_MS) {
      headerWarnings.push(
        `The invoice date ${invoiceDate} is more than 10 years ago.`
      )
    }
  }
  const documentCurrency = extraction.currency?.trim().toUpperCase() || null
  if (
    documentCurrency !== null &&
    workspaceCurrencyCode !== undefined &&
    documentCurrency !== workspaceCurrencyCode
  ) {
    headerWarnings.push(
      `This document is priced in ${documentCurrency}, but the workspace records costs in ${workspaceCurrencyCode}.`
    )
  }
  const totalCents = parseMoneyToCents(extraction.totalAmount)
  if (totalCents === null) {
    headerWarnings.push("Couldn't read the invoice total.")
  }
  const isCredit =
    extraction.documentType === "credit_memo" ||
    extraction.documentType === "refund"
  if (isCredit && totalCents !== null && totalCents > 0) {
    headerWarnings.push(
      "A credit memo usually has a negative total — check the sign."
    )
  }

  // A model reading a till receipt tends to transcribe the totals block, the
  // card slip and the footer as lines. None of those is a purchase, and a
  // line with no number at all could only block the import, so both go.
  const purchaseLines = extraction.lines.filter(isPurchaseLine)
  const alignedLines =
    supplier === "wegmans" && extraction.documentType === "receipt"
      ? alignWegmansQuantities(purchaseLines, pageSizes)
      : purchaseLines
  const lines: NormalizedInvoiceLine[] = alignedLines.map((line, index) => {
    const quantity = parseQuantity(line.quantity)
    const unitPriceCents = parseMoneyToCents(line.unitPrice)
    const lineAmountCents = parseMoneyToCents(line.lineAmount)
    const prefix =
      extraction.documentType === "receipt" ? receiptPricePrefix(line) : null
    const prefixQuantity = prefix ? parseQuantity(prefix.quantity) : null
    const prefixPrice = prefix ? parseMoneyToCents(prefix.unitPrice) : null
    let reason = line.uncertain
      ? line.uncertainReason || "The model wasn't confident about this line."
      : null
    if (lineAmountCents === null) {
      reason = reason ?? `Couldn't read the amount "${line.lineAmount ?? ""}".`
    } else if (
      quantity !== null &&
      unitPriceCents !== null &&
      Math.abs(quantity * unitPriceCents - lineAmountCents) > 2
    ) {
      reason =
        reason ??
        `Amount ${formatCents(lineAmountCents)} doesn't match ${quantity} × ${formatCents(unitPriceCents)}.`
    } else if (
      prefixQuantity !== null &&
      prefixPrice !== null &&
      Math.abs(prefixQuantity * prefixPrice - lineAmountCents) > 2
    ) {
      reason ??=
        "The printed quantity and price do not match this item's amount. Check which item they belong to."
    }
    const sku = (line.sku ?? "").trim()
    const description = (line.description.trim() || `Line ${index + 1}`).slice(
      0,
      240
    )
    return {
      position: index,
      sku,
      itemKey: supplierItemKey(sku, description),
      description,
      quantity,
      unit: cleanUnit(line.unit ?? ""),
      packSize: (line.packSize ?? "").trim(),
      unitPriceCents,
      lineAmountCents,
      suggestedCategory: line.suggestedCategory?.trim() || null,
      uncertain: line.uncertain || reason !== null,
      reason,
      box: normalizeBox(line.box, pageSizes),
      raw: purchaseLines[index],
    }
  })

  // Tax, delivery and fees printed outside the item table are part of the
  // printed total, so they have to join the sum or a correct invoice never
  // reconciles.
  const otherChargesCents =
    parseMoneyToCents(extraction.otherChargesAmount) ?? 0
  const totalsMismatch = invoiceTotalsMismatch(
    totalCents,
    lines,
    otherChargesCents
  )

  return {
    supplier,
    supplierName,
    documentType: extraction.documentType,
    invoiceNumber: (extraction.invoiceNumber ?? "").trim(),
    invoiceDate,
    dueDate: parseIsoDate(extraction.dueDate),
    currency: documentCurrency,
    totalCents,
    subtotalCents: parseMoneyToCents(extraction.subtotalAmount),
    taxCents: parseMoneyToCents(extraction.taxAmount),
    totalsMismatch,
    headerWarnings,
    lines,
  }
}

// --- Stamping (merge with the Django probe) -----------------------------------

function titleCase(value: string): string {
  const lowered = value.toLowerCase()
  return lowered.charAt(0).toUpperCase() + lowered.slice(1)
}

function resolveCategoryId(
  line: NormalizedInvoiceLine,
  status: InvoiceLineStatusItem | undefined,
  categories: ExpenseCategoryRow[]
): string | null {
  if (status?.lastCategoryId) {
    if (categories.some((category) => category.id === status.lastCategoryId)) {
      return status.lastCategoryId
    }
  }
  if (line.suggestedCategory) {
    const suggestion = line.suggestedCategory.toLowerCase()
    const match = categories.find(
      (category) => category.name.toLowerCase() === suggestion
    )
    if (match) return match.id
  }
  return null
}

function reviewMatch(
  line: NormalizedInvoiceLine,
  status: InvoiceLineStatusItem | undefined,
  reason: string
): InvoiceLineMatch {
  const pack = resolveInvoiceLinePack(line)
  return {
    kind: "review",
    reason,
    suggestedName: titleCase(line.description).slice(0, 120),
    suggestedPackAmount: pack?.amount ?? null,
    suggestedPackUnit: pack?.unit ?? null,
    suggestedPriceCents: invoiceLinePackPriceCents(line),
    ingredientId: status?.matchedIngredientId ?? null,
  }
}

/**
 * What this line proposes to do to the pantry, from the item key and the
 * workspace's memory of it alone. The expense category has no say: a line is
 * resolvable before it is tagged, and the review step decides at confirm time
 * whether the resolution is sent as a cost entry.
 */
function matchLine(
  invoice: NormalizedInvoice,
  line: NormalizedInvoiceLine,
  status: InvoiceLineStatusItem | undefined
): InvoiceLineMatch {
  const costable =
    invoice.documentType === "invoice" || invoice.documentType === "receipt"
  if (!costable) {
    return { kind: "expense-only", note: null }
  }
  if (!line.itemKey) {
    return {
      kind: "expense-only",
      note: "Nothing on this line identifies the product, so it won't update prices.",
    }
  }
  if (status?.ignored) {
    return { kind: "ignored" }
  }
  if (line.reason !== null) {
    return reviewMatch(line, status, line.reason)
  }

  const packPriceCents = invoiceLinePackPriceCents(line)
  if (packPriceCents === null) {
    return reviewMatch(line, status, "Couldn't work out a pack price.")
  }
  if (packPriceCents <= 0) {
    return {
      kind: "expense-only",
      note: "Credit line — negative amounts never update prices.",
    }
  }

  const item = status?.supplierItem ?? null
  if (item) {
    const pack = resolveInvoiceLinePack(line)
    // The pack is compared in the unit it was bought in, not in grams: a case
    // of gallons has no grams to compare, and a unit that changed at all is a
    // different pack whatever the numbers say.
    if (pack && !pack.catchWeight) {
      if (pack.unit !== item.packUnit) {
        return reviewMatch(
          line,
          status,
          `Pack unit changed from ${item.packUnit} to ${pack.unit}.`
        )
      }
      if (
        item.packAmount > 0 &&
        Math.abs(pack.amount - item.packAmount) / item.packAmount > 0.01
      ) {
        return reviewMatch(
          line,
          status,
          `Pack size changed from ${item.rawSize || "the stored size"} to ${line.packSize}.`
        )
      }
    }
    const useParsedPack = pack !== null && pack.catchWeight
    return {
      kind: "update",
      supplierItemId: item.id,
      ingredientName: item.ingredientName,
      cost: {
        name: item.title,
        packAmount: useParsedPack ? pack.amount : item.packAmount,
        packUnit: useParsedPack ? pack.unit : item.packUnit,
        packGrams: useParsedPack ? pack.grams : item.packGrams,
        packPriceCents,
        rawSize: line.packSize || item.rawSize,
        preferred: item.isPreferred,
        ingredientId: item.ingredientId,
      },
    }
  }

  const pack = resolveInvoiceLinePack(line)
  if (!pack) {
    return reviewMatch(
      line,
      status,
      line.packSize
        ? `Couldn't read the pack size "${line.packSize}".`
        : "No pack size on this line."
    )
  }
  return {
    kind: "new",
    matchedIngredientName: status?.matchedIngredientName ?? null,
    cost: {
      name: (
        status?.matchedIngredientName ?? titleCase(line.description)
      ).slice(0, 120),
      packAmount: pack.amount,
      packUnit: pack.unit,
      packGrams: pack.grams,
      packPriceCents,
      rawSize: line.packSize || `${pack.amount} ${pack.unit}`,
      preferred: false,
      ingredientId: status?.matchedIngredientId ?? null,
    },
  }
}

/** Merges the normalized extraction with the Django probe into the
 * review-ready result the import dialog renders. */
export function buildInvoiceParseResult(
  file: {
    fileName: string
    driveFileId: string | null
    driveWebViewLink: string | null
    extractionModel: string
    escalated: boolean
    extraction: InvoiceExtraction | null
    /** Omitted by the callers that read one document per file. */
    part?: DocumentPart
  },
  invoice: NormalizedInvoice,
  status: InvoiceLineStatus
): InvoiceParseResult {
  const statusByIndex = new Map(status.items.map((item) => [item.index, item]))
  const lines: InvoiceLineEntry[] = invoice.lines.map((line) => {
    const lineStatus = statusByIndex.get(line.position)
    const categoryId = resolveCategoryId(line, lineStatus, status.categories)
    return {
      position: line.position,
      sku: line.sku,
      itemKey: line.itemKey,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      packSize: line.packSize,
      unitPriceCents: line.unitPriceCents,
      lineAmountCents: line.lineAmountCents,
      categoryId,
      match: matchLine(invoice, line, lineStatus),
      uncertain: line.uncertain,
      reason: line.reason,
      box: line.box,
      raw: line.raw,
    }
  })
  return {
    fileName: file.fileName,
    part: file.part ?? WHOLE_FILE_PART,
    driveFileId: file.driveFileId,
    driveWebViewLink: file.driveWebViewLink,
    extractionModel: file.extractionModel,
    escalated: file.escalated,
    extraction: file.extraction,
    supplier: invoice.supplier,
    supplierName: invoice.supplierName,
    documentType: invoice.documentType,
    currency: invoice.currency,
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    totalCents: invoice.totalCents,
    subtotalCents: invoice.subtotalCents,
    taxCents: invoice.taxCents,
    duplicate: status.duplicate,
    existingInvoice: status.existingInvoice,
    totalsMismatch: invoice.totalsMismatch,
    headerWarnings: invoice.headerWarnings,
    categories: status.categories,
    lines,
  }
}
