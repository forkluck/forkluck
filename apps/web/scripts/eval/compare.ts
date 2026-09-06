import {
  parseMoneyToCents,
  parseQuantity,
  supplierKeyFromName,
  type ExtractedLine,
  type InvoiceExtraction,
} from "@/lib/invoice-import"

/**
 * Scoring for the receipt golden set: one hand-verified InvoiceExtraction
 * against one model (or template) read of the same file. Values are compared
 * after the same normalization the import applies (cents, trimmed codes,
 * supplier key), so a cosmetic difference the importer would ignore is not a
 * miss here either. Pure — the eval script owns file I/O and model calls.
 */

export type FieldResult = {
  field: string
  ok: boolean
  expected: string | null
  actual: string | null
}

export type LineResult = {
  position: number
  ok: boolean
  fields: FieldResult[]
}

export type DocumentComparison = {
  header: FieldResult[]
  lines: LineResult[]
  /** False when the read has more or fewer lines than the golden document. */
  lineCountMatches: boolean
  headerFieldAccuracy: number
  lineFieldAccuracy: number
  fullyCorrect: boolean
}

const cents = (value: string | null): string | null => {
  const parsed = parseMoneyToCents(value)
  return parsed === null ? null : String(parsed)
}
const code = (value: string | null): string | null =>
  value?.trim().toLowerCase() || null
const words = (value: string | null): string | null =>
  value
    ?.toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .trim() || null
const upper = (value: string | null): string | null =>
  value?.trim().toUpperCase() || null
const quantity = (value: string | null): string | null => {
  const parsed = parseQuantity(value)
  return parsed === null ? null : String(parsed)
}

function field(
  name: string,
  expected: string | null,
  actual: string | null
): FieldResult {
  return { field: name, ok: expected === actual, expected, actual }
}

/**
 * Fields a golden file may leave unstated. Unlike the rest of the header,
 * `null` here means "not hand-verified" rather than "the document prints
 * none", so a golden file written before the field existed is skipped instead
 * of failing. Fill the field in to start scoring it.
 */
const UNSCORED_WHEN_NULL: Array<
  [string, (invoice: InvoiceExtraction) => string | null]
> = [
  ["dueDate", (invoice) => invoice.dueDate?.trim() || null],
  ["subtotalAmount", (invoice) => cents(invoice.subtotalAmount)],
  ["taxAmount", (invoice) => cents(invoice.taxAmount)],
]

const UNSCORED_FIELDS = new Set(UNSCORED_WHEN_NULL.map(([name]) => name))

const HEADER_FIELDS: Array<
  [string, (invoice: InvoiceExtraction) => string | null]
> = [
  ["supplier", (invoice) => supplierKeyFromName(invoice.supplierName) || null],
  ["documentType", (invoice) => invoice.documentType],
  ["invoiceNumber", (invoice) => code(invoice.invoiceNumber)],
  ["invoiceDate", (invoice) => invoice.invoiceDate?.trim() || null],
  ["totalAmount", (invoice) => cents(invoice.totalAmount)],
  ["currency", (invoice) => upper(invoice.currency)],
  // A document that prints no fees and one that prints "0.00" agree.
  ["otherChargesAmount", (invoice) => cents(invoice.otherChargesAmount) ?? "0"],
  ...UNSCORED_WHEN_NULL,
]

const LINE_FIELDS: Array<[string, (line: ExtractedLine) => string | null]> = [
  ["sku", (line) => code(line.sku)],
  ["description", (line) => words(line.description)],
  ["quantity", (line) => quantity(line.quantity)],
  ["unit", (line) => upper(line.unit)],
  ["packSize", (line) => words(line.packSize)],
  ["unitPrice", (line) => cents(line.unitPrice)],
  ["lineAmount", (line) => cents(line.lineAmount)],
]

const ratio = (results: FieldResult[]): number =>
  results.length === 0 ? 1 : results.filter((r) => r.ok).length / results.length

export function compareExtraction(
  expected: InvoiceExtraction,
  actual: InvoiceExtraction
): DocumentComparison {
  // A golden "not usable" document is scored on that verdict alone.
  if (expected.notUsable) {
    const verdict = field(
      "notUsable",
      "flagged",
      actual.notUsable ? "flagged" : null
    )
    return {
      header: [verdict],
      lines: [],
      lineCountMatches: true,
      headerFieldAccuracy: verdict.ok ? 1 : 0,
      lineFieldAccuracy: 1,
      fullyCorrect: verdict.ok,
    }
  }
  const header = [
    field("notUsable", null, actual.notUsable ? "flagged" : null),
    ...HEADER_FIELDS.map(([name, read]) =>
      field(name, read(expected), read(actual))
    ),
  ].filter(
    (result) => !(UNSCORED_FIELDS.has(result.field) && result.expected === null)
  )
  const lines = expected.lines.map((expectedLine, position) => {
    const actualLine = actual.lines[position]
    const fields = LINE_FIELDS.map(([name, read]) =>
      field(name, read(expectedLine), actualLine ? read(actualLine) : null)
    )
    return { position, ok: fields.every((r) => r.ok), fields }
  })
  const lineCountMatches = expected.lines.length === actual.lines.length
  const lineFields = lines.flatMap((line) => line.fields)
  return {
    header,
    lines,
    lineCountMatches,
    headerFieldAccuracy: ratio(header),
    lineFieldAccuracy: ratio(lineFields),
    fullyCorrect:
      lineCountMatches && header.every((r) => r.ok) && lines.every((l) => l.ok),
  }
}

export type CaseOutcome = {
  name: string
  comparison: DocumentComparison | null
  /** The read reconciled arithmetically (normalizeInvoiceExtraction found no totals mismatch). */
  reconciled: boolean
  escalated: boolean
  error: string | null
  inputTokens: number
  outputTokens: number
  costUsd: number
  ms: number
}

export type EvalSummary = {
  documents: number
  failed: number
  fullyCorrect: number
  fullyCorrectRate: number
  headerFieldAccuracy: number
  lineFieldAccuracy: number
  reconciledRate: number
  escalatedRate: number
  costUsd: number
  meanMs: number
}

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length

export function summarize(outcomes: CaseOutcome[]): EvalSummary {
  const scored = outcomes.filter((o) => o.comparison !== null)
  const comparisons = scored.map((o) => o.comparison as DocumentComparison)
  const fullyCorrect = comparisons.filter((c) => c.fullyCorrect).length
  return {
    documents: outcomes.length,
    failed: outcomes.length - scored.length,
    fullyCorrect,
    fullyCorrectRate:
      outcomes.length === 0 ? 0 : fullyCorrect / outcomes.length,
    headerFieldAccuracy: mean(comparisons.map((c) => c.headerFieldAccuracy)),
    lineFieldAccuracy: mean(comparisons.map((c) => c.lineFieldAccuracy)),
    reconciledRate: mean(scored.map((o) => (o.reconciled ? 1 : 0))),
    escalatedRate: mean(outcomes.map((o) => (o.escalated ? 1 : 0))),
    costUsd: outcomes.reduce((sum, o) => sum + o.costUsd, 0),
    meanMs: mean(outcomes.map((o) => o.ms)),
  }
}
