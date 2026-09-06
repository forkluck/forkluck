import type { ExpenseCategoryRow } from "@/lib/backend/types"
import {
  parseMoneyToCents,
  supplierKeyFromName,
  type DocumentPart,
  type InvoiceExtraction,
  type InvoiceLineEntry,
} from "@/lib/invoice-import"
import { dollarsToCents } from "@/lib/money"
import type { PackUnitSlug } from "@/lib/unit-registry"

export type InvoiceReviewMode =
  "auto" | "review" | "resolving" | "resolved" | "ignored"

export function invoiceLineNeedsReview(mode: InvoiceReviewMode): boolean {
  return mode === "review" || mode === "resolving"
}

export function modeAfterExpenseCategorySelection(input: {
  mode: InvoiceReviewMode
  itemKey: string
  categoryId: string | null
}): InvoiceReviewMode {
  if (
    !input.itemKey &&
    input.categoryId !== null &&
    invoiceLineNeedsReview(input.mode)
  ) {
    return "resolved"
  }
  return input.mode
}

/**
 * The category a line lands in once the reviewer picks the pantry item it
 * bought: a food ingredient files under the workspace's first costable food
 * category, a supply under its first supply category. A costable category of
 * the same kind stands, so a second food category the reviewer chose is kept;
 * a food category on a line that turns out to be a supply is not.
 */
export function categoryAfterItemPick(input: {
  categoryId: string | null
  nonEdible: boolean
  categories: readonly ExpenseCategoryRow[]
}): string | null {
  const current = input.categories.find(
    (category) => category.id === input.categoryId
  )
  if (current?.isIngredient && current.isSupply === input.nonEdible) {
    return input.categoryId
  }
  const wanted = input.categories.find((category) =>
    input.nonEdible
      ? category.isSupply
      : category.isIngredient && !category.isSupply
  )
  return wanted?.id ?? input.categoryId
}

// --- The receipt the reviewer imports ----------------------------------------

/**
 * The shapes below are structural, so the reviewer's own state passes straight
 * in — the same arrangement `lib/invoice-propagation.ts` uses.
 */
export type ReceiptLine = {
  entry: InvoiceLineEntry
  /** Editable received quantity; blank means the document stated none. */
  quantity: string
  categoryId: string | null
  mode: InvoiceReviewMode
  name: string
  amount: string
  unit: PackUnitSlug
  price: string
  ingredientId: string
  /** Review input (dollars) for a line amount the extractor couldn't read. */
  lineAmount: string
  /** Off writes the price without teaching the supplier catalogue the item. */
  remember: boolean
}

export type ReceiptInvoice = {
  result: {
    fileName: string
    /** Which document inside the file this receipt is; the whole file for a
     *  file holding one invoice. */
    part: DocumentPart
    driveFileId: string | null
    driveWebViewLink: string | null
    supplier: string
    supplierName: string
    documentType: "invoice" | "credit_memo" | "receipt" | "refund"
    dueDate: string | null
    currency: string | null
    subtotalCents: number | null
    taxCents: number | null
    extractionModel: string
    escalated: boolean
    extraction: InvoiceExtraction | null
    categories: ExpenseCategoryRow[]
  }
  supplierName: string
  invoiceNumber: string
  invoiceDate: string
  total: string
  lines: ReceiptLine[]
}

/** Just enough of an ingredient to keep a picked pantry match's own name. */
export type ReceiptIngredient = { id: string; name: string }

export type ReceiptCostEntry = {
  name: string
  packUnit: PackUnitSlug
  packAmount: number
  packPriceCents: number
  rawSize: string
  quantity: number | null
  preferred: boolean
  ingredientId: string | null
  /** False leaves the supplier catalogue alone: the price lands, and no
   * SupplierItem is created for the line. */
  remember: boolean
}

export function categoryIsIngredient(
  categories: readonly ExpenseCategoryRow[],
  categoryId: string | null
): boolean {
  return categories.some(
    (category) => category.id === categoryId && category.isIngredient
  )
}

/** A line filed under a category that can't carry a price is an expense, and
 * an expense has nothing left to resolve. An untagged line still asks: the
 * match is computed before the tagging, so review comes first. */
export function lineIsExpense(
  line: Pick<ReceiptLine, "categoryId">,
  categories: readonly ExpenseCategoryRow[]
): boolean {
  return (
    line.categoryId !== null &&
    !categoryIsIngredient(categories, line.categoryId)
  )
}

export function lineNeedsReview(
  line: Pick<ReceiptLine, "mode" | "categoryId">,
  categories: readonly ExpenseCategoryRow[]
): boolean {
  return invoiceLineNeedsReview(line.mode) && !lineIsExpense(line, categories)
}

/** Extracted line amount, or the reviewer's typed replacement when missing. */
export function lineAmountCentsOf(
  line: Pick<ReceiptLine, "entry" | "lineAmount">
): number | null {
  return line.entry.lineAmountCents ?? parseMoneyToCents(line.lineAmount)
}

/** The reviewed quantity sent to Django. Null is a deliberately blank field;
 * validity stays separate so malformed text cannot silently become blank. */
export function lineQuantityOf(
  line: Pick<ReceiptLine, "quantity">
): number | null {
  const value = line.quantity.trim()
  if (!value) return null
  const quantity = Number(value)
  return Number.isFinite(quantity) && Math.abs(quantity) <= 1_000_000
    ? quantity
    : null
}

export function lineQuantityIsValid(
  line: Pick<ReceiptLine, "quantity">
): boolean {
  return line.quantity.trim() === "" || lineQuantityOf(line) !== null
}

function resolvedCostEntry(
  line: ReceiptLine,
  ingredients: readonly ReceiptIngredient[]
): ReceiptCostEntry | null {
  const amount = Number(line.amount)
  const price = dollarsToCents(line.price)
  const quantity = lineQuantityOf(line)
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !price ||
    !line.entry.itemKey
  ) {
    return null
  }
  // A name travels with the price, so sending the typed line text for a picked
  // pantry match would rename that ingredient to the supplier's wording — and a
  // rename that collides with another ingredient fails the whole batch.
  const matched = line.ingredientId
    ? ingredients.find((ingredient) => ingredient.id === line.ingredientId)
    : undefined
  return {
    name: matched?.name ?? (line.name.trim() || line.entry.description),
    packUnit: line.unit,
    packAmount: amount,
    packPriceCents: price,
    rawSize: line.entry.packSize || `${amount} ${line.unit}`,
    quantity: quantity !== null && quantity > 0 ? quantity : null,
    preferred: false,
    ingredientId: line.ingredientId || null,
    remember: line.remember,
  }
}

export function lineCostEntry(
  line: ReceiptLine,
  ingredients: readonly ReceiptIngredient[]
): ReceiptCostEntry | null {
  if (line.mode === "resolved") return resolvedCostEntry(line, ingredients)
  if (line.mode !== "auto") return null
  const match = line.entry.match
  if (match.kind !== "update" && match.kind !== "new") return null
  const quantity = lineQuantityOf(line)
  // A category change in review can demote a cost line to expense-only.
  return {
    name: match.cost.name,
    packUnit: match.cost.packUnit,
    packAmount: match.cost.packAmount,
    packPriceCents: match.cost.packPriceCents,
    rawSize: match.cost.rawSize,
    quantity: quantity !== null && quantity > 0 ? quantity : null,
    preferred: match.cost.preferred,
    ingredientId: match.cost.ingredientId,
    remember: line.remember,
  }
}

/**
 * Why this one receipt can't be imported yet, in the words the batch import
 * used, or null when it can. Import is per receipt now, so a missing total on
 * one file no longer holds the other thirty-nine.
 */
export function receiptBlocker(invoice: ReceiptInvoice): string | null {
  const fileName = invoice.result.fileName
  if (!invoice.invoiceDate) return `${fileName} needs a date before importing.`
  if (parseMoneyToCents(invoice.total) === null) {
    return `${fileName} needs a readable total.`
  }
  if (invoice.lines.some((line) => lineAmountCentsOf(line) === null)) {
    return `${fileName}: enter the missing line amounts before importing.`
  }
  if (invoice.lines.some((line) => !lineQuantityIsValid(line))) {
    return `${fileName}: correct the invalid line quantities before importing.`
  }
  return null
}

export type ReceiptPayload = {
  fileName: string
  driveFileId: string | null
  /** Which document inside that Drive file this is: two receipts out of one
   *  scanned bundle become two invoices sharing a file id. */
  drivePart: number
  driveWebViewLink: string | null
  /** The file we stored at import time, when the browser held its bytes;
   * null for a receipt whose document stays in the connected folder. */
  documentKey: string | null
  supplier: string
  supplierName: string
  documentType: "invoice" | "credit_memo" | "receipt" | "refund"
  invoiceNumber: string | null
  invoiceDate: string
  /** Printed due date, null when the document printed none. */
  dueDate: string | null
  currencyCode: string | null
  totalCents: number
  /** Printed subtotal before tax and charges; null when none was printed. */
  subtotalCents: number | null
  /** Printed tax, already inside `totalCents`; null when none was printed. */
  taxCents: number | null
  extractionModel: string
  extraction: InvoiceExtraction | null
  escalated: boolean
  lines: Array<{
    sku: string
    description: string
    quantity: number | null
    unit: string
    packSize: string
    unitPriceCents: number | null
    lineAmountCents: number
    categoryId: string | null
    needsReview: boolean
    sourcePayload: Record<string, unknown>
    costEntry: ReceiptCostEntry | null
  }>
  ignored: Array<{
    supplier: string
    externalId: string
    name: string
    rawSize: string
  }>
}

/**
 * One reviewed receipt as the import action takes it. `receiptBlocker` has
 * already refused the receipts whose date, total or line amounts are missing,
 * so the arithmetic here has nothing left to fail on.
 */
export function receiptPayload(
  invoice: ReceiptInvoice,
  ingredients: readonly ReceiptIngredient[],
  documentKey: string | null = null
): ReceiptPayload {
  const categories = invoice.result.categories
  // File SupplierItems, ignores, and fingerprints under the reviewed
  // (possibly corrected) supplier name, not the originally extracted one.
  const supplierName =
    invoice.supplierName.trim() || invoice.result.supplierName
  const supplier = supplierKeyFromName(supplierName) || invoice.result.supplier
  return {
    fileName: invoice.result.fileName,
    driveFileId: invoice.result.driveFileId,
    drivePart: invoice.result.part.part,
    driveWebViewLink: invoice.result.driveWebViewLink,
    documentKey,
    supplier,
    supplierName,
    documentType: invoice.result.documentType,
    invoiceNumber: invoice.invoiceNumber.trim() || null,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.result.dueDate,
    currencyCode: invoice.result.currency,
    totalCents: parseMoneyToCents(invoice.total) ?? 0,
    subtotalCents: invoice.result.subtotalCents,
    taxCents: invoice.result.taxCents,
    extractionModel: invoice.result.extractionModel,
    // What the model read, sent as it came back: the corrections above are
    // the label on it.
    extraction: invoice.result.extraction,
    escalated: invoice.result.escalated,
    lines: invoice.lines.map((line) => {
      const costable = categoryIsIngredient(categories, line.categoryId)
      return {
        sku: line.entry.sku,
        description: line.entry.description,
        quantity: lineQuantityOf(line),
        unit: line.entry.unit,
        packSize: line.entry.packSize,
        unitPriceCents: line.entry.unitPriceCents,
        lineAmountCents: lineAmountCentsOf(line) ?? 0,
        categoryId: line.categoryId,
        needsReview: lineNeedsReview(line, categories),
        sourcePayload: { ...line.entry.raw } as Record<string, unknown>,
        costEntry: costable ? lineCostEntry(line, ingredients) : null,
      }
    }),
    ignored: invoice.lines
      .filter((line) => line.mode === "ignored" && line.entry.itemKey)
      .map((line) => ({
        supplier,
        externalId: line.entry.sku,
        name: line.entry.description,
        rawSize: line.entry.packSize,
      })),
  }
}
