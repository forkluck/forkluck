/**
 * One read receipt, as the parse pipeline hands it to the reviewer. Three
 * component tests drive the reviewer through the inbox seed, so the shape they
 * all need lives here rather than three times over.
 */

import type { ExpenseCategoryRow } from "@/lib/backend/types"
import type {
  ExtractedLine,
  InvoiceLineEntry,
  InvoiceLineMatch,
  InvoiceParseResult,
} from "@/lib/invoice-import"

export const CATEGORIES: ExpenseCategoryRow[] = [
  {
    id: "cat-food",
    name: "Ingredients",
    isIngredient: true,
    isSupply: false,
    position: 0,
  },
  {
    id: "cat-other",
    name: "Repairs",
    isIngredient: false,
    isSupply: false,
    position: 1,
  },
]

export const INGREDIENTS = [
  { id: "ing-butter", name: "Butter", nonEdible: false },
  { id: "ing-flour", name: "Flour", nonEdible: false },
]

function raw(description: string): ExtractedLine {
  return {
    lineNumber: 1,
    sku: null,
    description,
    quantity: "1",
    unit: "CS",
    packSize: "24 lb",
    unitPrice: "21.59",
    lineAmount: "21.59",
    suggestedCategory: null,
    uncertain: false,
    uncertainReason: null,
    box: null,
  }
}

/** A line the probe couldn't answer on its own, with whatever it suggested. */
export function reviewMatch(
  overrides: Partial<Extract<InvoiceLineMatch, { kind: "review" }>> = {}
): InvoiceLineMatch {
  return {
    kind: "review",
    reason: "New item for this supplier",
    suggestedName: "Butter",
    suggestedPackAmount: 24,
    suggestedPackUnit: "lb",
    suggestedPriceCents: 2159,
    ingredientId: null,
    ...overrides,
  }
}

export function line(
  overrides: Partial<InvoiceLineEntry> = {}
): InvoiceLineEntry {
  const description = overrides.description ?? "BUTTER SALTED 24#"
  return {
    position: 1,
    sku: "1001",
    itemKey: "butter-24",
    description,
    quantity: 1,
    unit: "CS",
    packSize: "24 lb",
    unitPriceCents: 2159,
    lineAmountCents: 2159,
    categoryId: "cat-food",
    match: reviewMatch(),
    uncertain: false,
    reason: null,
    box: null,
    raw: raw(description),
    ...overrides,
  }
}

export function parseResult(
  overrides: Partial<InvoiceParseResult> = {}
): InvoiceParseResult {
  return {
    fileName: "wegmans-487155.pdf",
    part: { part: 0, pages: null, region: null },
    driveFileId: "drive-1",
    driveWebViewLink: null,
    extractionModel: "text-layer",
    escalated: false,
    extraction: null,
    supplier: "wegmans",
    supplierName: "Wegmans",
    documentType: "invoice",
    invoiceNumber: "487155",
    invoiceDate: "2026-08-09",
    dueDate: null,
    currency: "USD",
    totalCents: 2159,
    subtotalCents: null,
    taxCents: null,
    duplicate: false,
    existingInvoice: null,
    totalsMismatch: null,
    headerWarnings: [],
    categories: CATEGORIES,
    lines: [line()],
    ...overrides,
  }
}

/** What `loadReadyDriveDocuments` returns for one already-read receipt. */
export function readyDocument(
  result: InvoiceParseResult,
  mimeType = "application/pdf"
) {
  return { mimeType, result }
}

export const IMPORT_RECEIPT = {
  batchId: "batch-1",
  invoices: 1,
  duplicates: [] as string[],
  lines: 1,
  priceUpdated: 1,
  created: 1,
  updated: 0,
  ignored: 0,
  expenseOnly: 0,
}
