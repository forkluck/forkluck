"use client"

import * as React from "react"
import { TriangleAlert } from "lucide-react"

import type { ExpenseCategoryRow } from "@/lib/backend/types"
import type { IngredientOption } from "@/components/ingredients/types"
import {
  invoiceTotalsMismatch,
  isPurchaseLine,
  parseMoneyToCents,
  type InvoiceLineEntry,
  type InvoiceParseResult,
  type LineBox,
} from "@/lib/invoice-import"
import {
  categoryIsIngredient,
  invoiceLineNeedsReview,
  lineAmountCentsOf,
  lineCostEntry,
  lineIsExpense,
  lineNeedsReview,
  receiptBlocker,
  receiptPayload,
  type InvoiceReviewMode,
} from "@/lib/invoice-review"
import { centsToDollarInput } from "@/lib/money"
import { isPackUnit, type PackUnitSlug } from "@/lib/unit-registry"

/** The payload arithmetic lives in `lib/invoice-review.ts` so it can be tested
 * without React; the reviewer reaches it through here. */
export {
  categoryIsIngredient,
  lineAmountCentsOf,
  lineCostEntry,
  lineIsExpense,
  lineNeedsReview,
  receiptBlocker,
  receiptPayload,
}

/** Raw bytes per kind. The server twins are `DRIVE_MAX_PDF_BYTES`
 * (lib/drive-folder.ts) and `MAX_IMAGE_UPLOAD_BYTES` (lib/import-limits.ts,
 * server-only, so not importable here). */
export const MAX_PDF_BYTES = 5_500_000
export const MAX_IMAGE_BYTES = 8_000_000

/** Review-line columns: one stack on phones, the handoff's grid from md. */
export const LINE_GRID =
  "gap-3 md:grid md:grid-cols-[minmax(0,1fr)_128px_136px_84px_96px]"

/** Column name repeated inside a stacked row; the header row takes over at md. */
export const LINE_LABEL = "text-2xs font-medium text-ink-soft md:hidden"

export const DOCUMENT_LABELS = {
  invoice: "Invoice",
  credit_memo: "Credit memo",
  receipt: "Receipt",
  refund: "Refund",
} as const

/** The one inline notice shape in this dialog: the handoff's yellow banner. */
export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-fill px-3.5 py-2.5 text-xs leading-[1.55] text-warning-foreground">
      <TriangleAlert
        className="mt-px size-4 shrink-0 text-warning"
        strokeWidth={1.8}
        aria-hidden="true"
      />
      {children}
    </p>
  )
}

const UPLOAD_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const

export type UploadType = (typeof UPLOAD_TYPES)[number]

const UPLOAD_TYPE_BY_EXTENSION: Record<string, UploadType> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
}

export const HEIC_MESSAGE =
  "iPhone HEIC photos aren't supported — set Camera → Formats to Most Compatible, or share as JPEG."

/**
 * What the parse pipeline will take, from the browser's MIME or — when it
 * reports none — the extension. HEIC is its own answer because the fix is on
 * the phone, not here.
 */
export function acceptedUploadType(file: {
  name: string
  type: string
}): UploadType | "heic" | null {
  const name = file.name.toLowerCase()
  if (
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    name.endsWith(".heic") ||
    name.endsWith(".heif")
  ) {
    return "heic"
  }
  const byMime = UPLOAD_TYPES.find((type) => type === file.type)
  if (byMime) return byMime
  return UPLOAD_TYPE_BY_EXTENSION[name.slice(name.lastIndexOf(".") + 1)] ?? null
}

export function maxUploadBytes(type: UploadType): number {
  return type === "application/pdf" ? MAX_PDF_BYTES : MAX_IMAGE_BYTES
}

export type QueueItem = {
  key: string
  fileName: string
  source: "drive" | "upload"
  status: "queued" | "loading" | "done" | "error"
  error: string | null
  driveFileId: string | null
  driveWebViewLink: string | null
  /** From the connected folder: the server fetches the bytes, the browser
   * never downloads them. The Picker path stays a browser download. */
  driveFetch: boolean
  /** What the bytes are, from the browser's MIME or Drive's. The parse of a
   * server-fetched file ignores it — that arm reads the type from Drive — but
   * the review pane needs it to know whether to draw a page or a photo. */
  mediaType: UploadType | null
  /** The bytes, once the browser has them: an upload, or a Picker download.
   * Null on the server-fetched arm, which never downloads them here. */
  file: File | null
  /** How many documents this file was read as — one normally, more when the
   * read found a bundle. Absent until the read comes back. */
  partCount?: number
}

/** Where the review pane gets one invoice's document. A file the browser
 * already holds becomes an object URL; a file in the connected folder is
 * streamed by the drive-file route, which re-checks the folder first. */
export type InvoiceDocument = {
  file: File | null
  driveFileId: string | null
  /** A file we stored at import time, streamed back by the document route. */
  documentKey: string | null
  mediaType: UploadType
  fileName: string
}

export type LineState = {
  key: string
  entry: InvoiceLineEntry
  /** Review input for the received quantity; blank means the document did not
   * state one. Kept as text so a partial decimal survives while typing. */
  quantity: string
  categoryId: string | null
  mode: InvoiceReviewMode
  /** Answered by another line of the same supplier item, not by a click. */
  propagated: boolean
  /** Where this line sits on the document, when the read could place it. */
  box: LineBox | null
  name: string
  amount: string
  /** A slug from the purchase vocabulary — a weight, a volume or a count. */
  unit: PackUnitSlug
  price: string
  ingredientId: string
  /** Review input (dollars) for a line amount the extractor couldn't read. */
  lineAmount: string
  /** Off means "apply this price, but don't teach the supplier catalogue this
   * item" — the import writes the cost and creates no SupplierItem. */
  remember: boolean
}

export type InvoiceState = {
  /** `${fileKey}#${part}`: a file holds several documents, and each one is a
   * block of its own in the reviewer. */
  key: string
  /** The queue row this block was read from, which is where its bytes are. */
  fileKey: string
  result: InvoiceParseResult
  supplierName: string
  invoiceNumber: string
  invoiceDate: string
  total: string
  includeDuplicate: boolean
  lines: LineState[]
  feedback?: { id: string; rating: "up" | "down"; note: string }
}

/** A report records draft text, including incomplete corrections. It is never
 * fed back into importing or ingredient prices. Names make staff review useful
 * even after the corresponding category or ingredient has been removed. */
export function receiptFeedbackSnapshot(
  invoice: InvoiceState,
  ingredients: IngredientOption[]
) {
  return {
    Supplier: invoice.supplierName,
    Number: invoice.invoiceNumber,
    Date: invoice.invoiceDate,
    Total: invoice.total,
    Currency: invoice.result.currency,
    "Second read": invoice.result.escalated,
    Part: invoice.result.part,
    Lines: invoice.lines.map((line) => ({
      Item: line.entry.description,
      Match: line.entry.match,
      Quantity: line.quantity,
      Category:
        invoice.result.categories.find(
          (category) => category.id === line.categoryId
        )?.name ?? "",
      Action: line.mode,
      Ingredient:
        ingredients.find((ingredient) => ingredient.id === line.ingredientId)
          ?.name ?? line.name,
      "Pack amount": line.amount,
      Unit: line.unit,
      Price: line.price,
      "Line amount":
        line.lineAmount ||
        (line.entry.lineAmountCents === null
          ? ""
          : centsToDollarInput(line.entry.lineAmountCents)),
      Remember: line.remember,
      Highlight: line.box,
    })),
  }
}

export function lineState(entry: InvoiceLineEntry, index: number): LineState {
  const review = entry.match.kind === "review" ? entry.match : null
  return {
    key: `${entry.itemKey || entry.description}-${index}`,
    entry,
    quantity: entry.quantity === null ? "" : String(entry.quantity),
    categoryId: entry.categoryId,
    mode: entry.match.kind === "review" ? "review" : "auto",
    propagated: false,
    box: entry.box,
    name: review?.suggestedName ?? "",
    amount:
      review?.suggestedPackAmount === null || review === null
        ? ""
        : String(review.suggestedPackAmount),
    unit: isPackUnit(review?.suggestedPackUnit ?? null)
      ? (review!.suggestedPackUnit as PackUnitSlug)
      : "lb",
    price:
      review?.suggestedPriceCents == null
        ? ""
        : centsToDollarInput(review.suggestedPriceCents),
    ingredientId: review?.ingredientId ?? "",
    lineAmount: "",
    remember: true,
  }
}

export function invoiceState(
  fileKey: string,
  result: InvoiceParseResult
): InvoiceState {
  // Reapply today's deterministic filter when opening a document the Drive
  // watcher normalized before that filter learned a new footer spelling.
  // This fixes the existing inbox as well as future reads.
  const purchaseLines = result.lines.filter((line) => isPurchaseLine(line.raw))
  const removedFooter = purchaseLines.length !== result.lines.length
  const resultWithPurchases = removedFooter
    ? {
        ...result,
        lines: purchaseLines,
        totalsMismatch:
          result.extraction !== null
            ? invoiceTotalsMismatch(
                result.totalCents,
                purchaseLines,
                parseMoneyToCents(result.extraction.otherChargesAmount) ?? 0
              )
            : invoiceTotalsMismatch(result.totalCents, purchaseLines) === null
              ? null
              : result.totalsMismatch,
      }
    : result
  return {
    key: `${fileKey}#${result.part.part}`,
    fileKey,
    result: resultWithPurchases,
    supplierName: result.supplierName,
    invoiceNumber: result.invoiceNumber,
    invoiceDate: result.invoiceDate ?? "",
    total:
      result.totalCents === null ? "" : centsToDollarInput(result.totalCents),
    includeDuplicate: false,
    lines: purchaseLines.map(lineState),
  }
}

/** What the row says it will do. The category has the last word: a line whose
 * final category isn't costable is an expense, whatever it matched. */
export function lineBadge(
  line: LineState,
  categories: ExpenseCategoryRow[]
): {
  label: string
  variant: "default" | "outline" | "success" | "warning"
} {
  if (line.mode === "ignored") {
    return {
      label: line.propagated ? "Same item" : "Ignored",
      variant: "outline",
    }
  }
  if (line.mode === "resolved") {
    return {
      label: line.propagated ? "Same item" : "Resolved",
      variant: "success",
    }
  }
  if (lineIsExpense(line, categories)) {
    return { label: "Expense", variant: "default" }
  }
  if (invoiceLineNeedsReview(line.mode)) {
    return { label: "Review", variant: "warning" }
  }
  switch (line.entry.match.kind) {
    case "update":
      return { label: "Price update", variant: "success" }
    case "new":
      return { label: "New product", variant: "success" }
    case "ignored":
      return { label: "Ignored", variant: "outline" }
    default:
      return { label: "Expense", variant: "default" }
  }
}
