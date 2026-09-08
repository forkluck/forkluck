"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { getSession, requireUser } from "@/lib/auth-session"
import { PACK_UNIT_SLUGS } from "@/lib/unit-registry"
import type {
  ConnectorConnection,
  ConnectorSyncRun,
  ExpenseCategoryRow,
  InvoiceDetail,
} from "@/lib/backend/types"
import { actionErrorMessage } from "@/lib/backend/action-error"
import { BackendRequestError, djangoAction } from "@/lib/backend/client"
import {
  getConnectorSyncRun,
  getDriveFiles,
  getDriveFolder,
} from "@/lib/backend/queries"
import { deleteDocument, isDocumentKeyOf } from "@/lib/document-store"
import { runDriveWatch, startDriveRead } from "@/lib/drive-watch"
import { parseDriveFolderId } from "@/lib/drive-folder"
import { DriveServiceError, getFolderMeta } from "@/lib/google-drive-service"
import { verifyAnthropicKey } from "@/lib/invoice-extract"
import {
  MAX_IMPORT_INVOICES,
  buildInvoiceParseResult,
  cleanUnit,
  invoiceExtractionSchema,
  storedDriveDocumentSchema,
  type InvoiceLineStatus,
  type InvoiceParseResult,
} from "@/lib/invoice-import"
import { probeInvoiceLines } from "@/lib/invoice-parse"

// PDF parsing lives in /api/invoices/parse (a route handler, so a batch of
// files can parse concurrently); these actions cover everything after review.

const feedbackSnapshotSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => {
    try {
      return JSON.stringify(value).length <= 64 * 1024
    } catch {
      return false
    }
  }, "Receipt feedback is too large.")

const receiptFeedbackSchema = z.object({
  id: z.string().uuid(),
  rating: z.enum(["up", "down"]),
  note: z.string().trim().max(2000),
  fileName: z.string().trim().min(1).max(255),
  supplierName: z.string().trim().max(120),
  model: z.string().trim().min(1).max(64),
  extraction: invoiceExtractionSchema.nullable(),
  original: feedbackSnapshotSchema,
  corrected: feedbackSnapshotSchema,
})

export type ReceiptFeedbackInput = z.infer<typeof receiptFeedbackSchema>

export async function saveReceiptFeedback(
  input: ReceiptFeedbackInput
): Promise<{ ok: true } | { error: string }> {
  const parsed = receiptFeedbackSchema.safeParse(input)
  if (!parsed.success) return { error: "Check your feedback and try again." }
  try {
    return await djangoAction<{ ok: true }>(
      "save-receipt-feedback",
      parsed.data
    )
  } catch (cause) {
    return {
      error: actionErrorMessage(
        cause,
        "Couldn't send feedback. Please try again."
      ),
    }
  }
}

const costEntrySchema = z.object({
  name: z.string().trim().min(1).max(120),
  // The purchase vocabulary, not weights alone: a case of gallons or of
  // pieces is priced in what it was bought by, and Django validates the same
  // list.
  packUnit: z.enum(PACK_UNIT_SLUGS),
  packAmount: z.number().positive().max(1000000),
  packPriceCents: z.number().int().min(1).max(100000000),
  rawSize: z.string().trim().min(1).max(120),
  quantity: z.number().min(0).max(1000000).nullable(),
  preferred: z.boolean(),
  ingredientId: z.string().uuid().nullable(),
  // Whether this pack joins the supplier's memory. False applies the price
  // and writes no SupplierItem, so the next invoice asks about the item
  // again; the reviewer's "Remember for {supplier}" checkbox sends it.
  remember: z.boolean().default(true),
})

const importLineSchema = z.object({
  sku: z.string().trim().max(120),
  description: z.string().trim().min(1).max(240),
  quantity: z.number().min(-1000000).max(1000000).nullable(),
  unit: z.string().trim().max(32),
  packSize: z.string().trim().max(120),
  unitPriceCents: z.number().int().min(-100000000).max(100000000).nullable(),
  lineAmountCents: z.number().int().min(-100000000).max(100000000),
  categoryId: z.string().uuid().nullable(),
  needsReview: z.boolean(),
  sourcePayload: z.record(z.string(), z.unknown()).default({}),
  costEntry: costEntrySchema.nullable(),
})

const ignoredEntrySchema = z.object({
  supplier: z.string().trim().min(1).max(64),
  // The printed code, blank on a receipt that prints none: Django derives the
  // key the skip list is stored under from this and the name together.
  externalId: z.string().trim().max(120),
  name: z.string().trim().min(1).max(200),
  rawSize: z.string().trim().max(120),
})

const importInvoiceSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  driveFileId: z.string().trim().min(1).max(128).nullable(),
  // Which document inside that Drive file this is: 0 for a file holding one
  // invoice, and the part's own index for a receipt out of a bundle, so two
  // invoices may share one file id.
  drivePart: z.number().int().min(0).max(39).default(0),
  driveWebViewLink: z.string().trim().url().max(500).nullable(),
  // The uploaded file this invoice was read from, kept on our side so the
  // invoice page can show it; null for a Drive file or a typed-in invoice.
  documentKey: z.string().trim().max(200).nullable().default(null),
  supplier: z.string().trim().min(1).max(64),
  supplierName: z.string().trim().min(1).max(120),
  documentType: z.enum(["invoice", "credit_memo", "receipt", "refund"]),
  invoiceNumber: z.string().trim().max(64).nullable(),
  invoiceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invoice date is required"),
  // Null when the document printed none of these; an absent figure is never
  // derived from the ones it did print.
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  taxCents: z
    .number()
    .int()
    .min(-100000000)
    .max(100000000)
    .nullable()
    .default(null),
  subtotalCents: z
    .number()
    .int()
    .min(-100000000)
    .max(100000000)
    .nullable()
    .default(null),
  // The currency the document printed; Django falls back to the workspace
  // code when null and refuses price updates from a foreign one.
  currencyCode: z.string().trim().length(3).nullable(),
  totalCents: z.number().int().min(-100000000).max(100000000),
  extractionModel: z.string().trim().min(1).max(64),
  // The raw read this invoice was made from, kept beside the merchant's
  // corrections as one labelled example. Null when there is nothing to keep.
  extraction: invoiceExtractionSchema.nullable(),
  escalated: z.boolean(),
  // Per-invoice cap matches the batch refine and Django's 500-line total cap.
  lines: z.array(importLineSchema).max(500),
  ignored: z.array(ignoredEntrySchema).max(200),
})

const importRequestSchema = z
  .object({
    invoices: z.array(importInvoiceSchema).min(1).max(40),
    // The currency the amounts carried while the user reviewed them. Django
    // refuses the import if the workspace has been converted since, rather
    // than stamping the rows with a currency nobody approved.
    reviewedCurrencyCode: z.string().trim().length(3),
  })
  .refine(
    (value) =>
      value.invoices.reduce((sum, invoice) => sum + invoice.lines.length, 0) <=
      500,
    { message: "An import can include at most 500 invoice lines" }
  )

export type ImportInvoicesReceipt = {
  batchId: string | null
  invoices: number
  duplicates: string[]
  lines: number
  priceUpdated: number
  created: number
  updated: number
  ignored: number
  expenseOnly: number
}

export async function importInvoices(
  input: z.input<typeof importRequestSchema>
): Promise<ImportInvoicesReceipt | { error: string }> {
  const parsed = importRequestSchema.safeParse(input)
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Import data looks malformed.",
    }
  }
  // A stored document belongs to one user; an id from the browser is not
  // authorization to attach someone else's file to an invoice.
  const user = await requireUser()
  for (const invoice of parsed.data.invoices) {
    if (invoice.documentKey && !isDocumentKeyOf(invoice.documentKey, user.id)) {
      return { error: "That file couldn't be attached." }
    }
  }
  try {
    return await djangoAction("import-invoices", parsed.data)
  } catch (error) {
    return {
      error: actionErrorMessage(error, "Couldn't import those invoices."),
    }
  }
}

// Hand entry sends the same line shape as an import, minus the fields only an
// extracted PDF has; the defaults keep Django's payload identical either way.
const manualLineSchema = importLineSchema.extend({
  id: z.string().uuid().nullable().optional(),
  sku: z.string().trim().max(120).default(""),
  quantity: z.number().min(-1000000).max(1000000).nullable().default(null),
  unit: z.string().trim().max(32).default(""),
  packSize: z.string().trim().max(120).default(""),
  unitPriceCents: z
    .number()
    .int()
    .min(-100000000)
    .max(100000000)
    .nullable()
    .default(null),
  categoryId: z.string().uuid().nullable().default(null),
  needsReview: z.boolean().default(false),
  costEntry: costEntrySchema.nullable().default(null),
})

const saveInvoiceSchema = z.object({
  // Absent for a new invoice; any invoice the workspace has can be edited.
  id: z.string().uuid().nullable().default(null),
  supplierName: z.string().trim().min(1, "Enter the supplier name.").max(120),
  invoiceNumber: z.string().trim().max(64).default(""),
  invoiceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the invoice date."),
  // Null when the document printed no terms.
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the due date.")
    .nullable()
    .default(null),
  // A credit memo or refund prints a negative total; Django refuses one on
  // any other document type, since it knows which kind this row is.
  totalCents: z.number().int().min(-100000000).max(100000000),
  taxCents: z.number().int().min(0).max(100000000).default(0),
  // The printed subtotal before tax and charges; null when unprinted.
  subtotalCents: z
    .number()
    .int()
    .min(-100000000)
    .max(100000000)
    .nullable()
    .default(null),
  notes: z.string().trim().max(2000).default(""),
  paymentMethod: z.string().trim().max(64).default(""),
  expectedEditVersion: z.number().int().min(0).optional(),
  lines: z.array(manualLineSchema).min(1, "Add at least one line.").max(500),
})

export type SaveInvoiceInput = z.input<typeof saveInvoiceSchema>

export async function saveInvoice(
  input: SaveInvoiceInput
): Promise<
  | { item: InvoiceDetail }
  | { error: string; code?: string; editVersion?: number }
> {
  const parsed = saveInvoiceSchema.safeParse(input)
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ?? "That invoice looks incomplete.",
    }
  }
  try {
    const result = await djangoAction<{ item: InvoiceDetail }>(
      "save-invoice",
      parsed.data
    )
    revalidatePath("/invoices")
    // A costed line re-prices its ingredient, which the dashboard totals read.
    revalidatePath("/ingredients")
    revalidatePath("/")
    return result
  } catch (error) {
    // The editor tells a refused stale write apart from every other failure.
    if (error instanceof BackendRequestError && error.code === "stale_write") {
      return {
        error: error.message,
        code: error.code,
        editVersion: error.editVersion,
      }
    }
    return { error: actionErrorMessage(error, "Couldn't save that invoice.") }
  }
}

// Resolving one line of an invoice already on file. Not an edit of the
// document, so it works on imported invoices too.
const reviewInvoiceLineSchema = z.object({
  lineId: z.string().uuid(),
  categoryId: z.string().uuid().nullish(),
  costEntry: costEntrySchema.nullish(),
})

export type ReviewInvoiceLineInput = z.input<typeof reviewInvoiceLineSchema>

export async function reviewInvoiceLine(
  input: ReviewInvoiceLineInput
): Promise<{ item: InvoiceDetail } | { error: string }> {
  const parsed = reviewInvoiceLineSchema.safeParse(input)
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "That line looks incomplete.",
    }
  }
  try {
    const result = await djangoAction<{ item: InvoiceDetail }>(
      "review-invoice-line",
      parsed.data
    )
    revalidatePath("/invoices")
    // A costed line re-prices its ingredient, which the dashboard totals read.
    revalidatePath("/ingredients")
    revalidatePath("/")
    return result
  } catch (error) {
    return { error: actionErrorMessage(error, "Couldn't save that line.") }
  }
}

export async function saveAnthropicKey(
  key: string
): Promise<{ configured: true; hint: string } | { error: string }> {
  await requireUser()
  const parsed = z
    .string()
    .trim()
    .min(20, "That doesn't look like an Anthropic API key")
    .max(300)
    .startsWith("sk-ant-", "That doesn't look like an Anthropic API key")
    .safeParse(key)
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  // Verify against the live API before storing — a free count_tokens call
  // catches typos and revoked keys at save time instead of mid-import.
  const verified = await verifyAnthropicKey(parsed.data)
  if ("error" in verified) return verified

  try {
    return await djangoAction("save-anthropic-key", { key: parsed.data })
  } catch (error) {
    return { error: actionErrorMessage(error, "Couldn't save that key.") }
  }
}

export async function deleteAnthropicKey(): Promise<
  { ok: true } | { error: string }
> {
  try {
    return await djangoAction("delete-anthropic-key", {})
  } catch (error) {
    return { error: actionErrorMessage(error, "Couldn't remove that key.") }
  }
}

export async function listExpenseCategories(): Promise<ExpenseCategoryRow[]> {
  await requireUser()
  const status = await djangoAction<InvoiceLineStatus>("invoice-line-status", {
    supplier: "unknown",
    lines: [],
  })
  return status.categories
}

async function deleteOneInvoice(id: string) {
  const answer = await djangoAction<{ ok: true; documentKey: string | null }>(
    "delete-invoice",
    { id }
  )
  if (answer.documentKey) {
    // The invoice is gone either way; a stranded blob is not worth an error.
    await deleteDocument(answer.documentKey).catch((cause) => {
      console.error("Couldn't delete stored invoice document", cause)
    })
  }
}

export async function deleteInvoice(
  id: string
): Promise<{ ok: true } | { error: string }> {
  try {
    await deleteOneInvoice(z.string().uuid().parse(id))
    // Also purges the client's copy of the list the detail page leaves for.
    revalidatePath("/invoices")
    return { ok: true }
  } catch (error) {
    return { error: actionErrorMessage(error, "Couldn't delete that invoice.") }
  }
}

/** Every selected invoice in turn, one revalidation at the end; see
 *  deleteRecipes in the recipes actions. */
export async function deleteInvoices(
  ids: string[]
): Promise<{ ok: true } | { error: string; deleted: number }> {
  const parsed = z.array(z.string().uuid()).min(1).max(200).safeParse(ids)
  if (!parsed.success)
    return { error: "Invoice ids look malformed.", deleted: 0 }
  let deleted = 0
  try {
    for (const id of parsed.data) {
      await deleteOneInvoice(id)
      deleted += 1
    }
    return { ok: true }
  } catch (error) {
    return {
      error: actionErrorMessage(error, "Couldn't delete those invoices."),
      deleted,
    }
  } finally {
    if (deleted) revalidatePath("/invoices")
  }
}

/* -------------------------------------------------------------------------- */
/* Supplier connector service                                                  */
/* -------------------------------------------------------------------------- */

// These actions deliberately accept only public connector references. The
// service owns supplier credentials and verifies the authenticated Forkluck
// subject on every request; browser code never gets a supplier secret.
const connectorProviderKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/, "Unknown supplier connector.")

const connectorConnectionIdSchema = z.uuid("Unknown supplier connection.")

const connectorAuthorizationSchema = z.object({
  state: z.string().trim().min(16).max(2_000),
  code: z.string().trim().min(1).max(2_000),
})

function revalidateConnectorReads() {
  revalidatePath("/invoices")
  revalidatePath("/integrations/suppliers/connections")
  revalidatePath("/integrations/suppliers/activity")
}

/** Starts the short-lived, connector-hosted authorization flow. */
export async function connectConnector(
  providerKey: string
): Promise<{ authorizationUrl: string } | { error: string }> {
  await requireUser()
  const parsed = connectorProviderKeySchema.safeParse(providerKey)
  if (!parsed.success) return { error: "Unknown supplier connector." }
  try {
    return await djangoAction<{ authorizationUrl: string }>(
      "connect-connector",
      { providerKey: parsed.data }
    )
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t start that connection."),
    }
  }
}

/** Exchanges the provider's one-time callback code on the server only. */
export async function completeConnectorAuthorization(input: {
  state: string
  code: string
}): Promise<{ connection: ConnectorConnection } | { error: string }> {
  await requireUser()
  const parsed = connectorAuthorizationSchema.safeParse(input)
  if (!parsed.success) return { error: "That connection link is invalid." }
  try {
    const result = await djangoAction<{ connection: ConnectorConnection }>(
      "complete-connector-authorization",
      parsed.data
    )
    revalidateConnectorReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t finish that connection."),
    }
  }
}

export async function enqueueConnectorSync(
  connectionId: string
): Promise<{ run: ConnectorSyncRun } | { error: string }> {
  await requireUser()
  const parsed = connectorConnectionIdSchema.safeParse(connectionId)
  if (!parsed.success) return { error: "Unknown supplier connection." }
  try {
    const result = await djangoAction<{ run: ConnectorSyncRun }>(
      "enqueue-connector-sync",
      { connectionId: parsed.data }
    )
    revalidateConnectorReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t start the supplier sync."),
    }
  }
}

export async function disconnectConnector(
  connectionId: string
): Promise<{ ok: true } | { error: string }> {
  await requireUser()
  const parsed = connectorConnectionIdSchema.safeParse(connectionId)
  if (!parsed.success) return { error: "Unknown supplier connection." }
  try {
    const result = await djangoAction<{ ok: true }>("disconnect-connector", {
      connectionId: parsed.data,
    })
    revalidateConnectorReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t disconnect that supplier."),
    }
  }
}

/** One durable, provider-neutral import run for client-side progress polling. */
export async function loadConnectorSyncRun(
  id: string
): Promise<ConnectorSyncRun> {
  await requireUser()
  return getConnectorSyncRun(connectorConnectionIdSchema.parse(id))
}

/* -------------------------------------------------------------------------- */
/* Google Drive receipts folder                                               */
/* -------------------------------------------------------------------------- */

// The service account reads only what has been shared with it, and Django
// stores only ids and names. Bytes are fetched inside /api/invoices/parse,
// after the file's ancestry has been checked against the stored folder.

function revalidateDriveReads() {
  revalidatePath("/invoices")
  revalidatePath("/integrations/suppliers/connections")
}

function driveErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof DriveServiceError
    ? cause.message
    : actionErrorMessage(cause, fallback)
}

export async function connectDriveFolder(
  link: string
): Promise<
  { folder: { folderId: string; folderName: string } } | { error: string }
> {
  await requireUser()
  const parsed = z.string().trim().max(500).safeParse(link)
  const folderId = parsed.success ? parseDriveFolderId(parsed.data) : null
  if (!folderId) {
    return { error: "That doesn't look like a Google Drive folder link." }
  }
  try {
    // Reading the folder first means a folder nobody shared is refused here,
    // not on the first import attempt.
    const meta = await getFolderMeta(folderId)
    const result = await djangoAction<{
      folder: { folderId: string; folderName: string }
    }>("connect-drive-folder", {
      folderId: meta.id,
      folderName: meta.name,
    })
    revalidateDriveReads()
    // registeredAt is null now, so this lists the new folder in full. A
    // failure is the timer's problem, and the card shows what went wrong.
    await runDriveWatch()
    // The listing above registered the folder's files; reading them is the
    // timer's job, started now so the first receipts are ready before it ticks.
    void startDriveRead()
    return result
  } catch (cause) {
    return { error: driveErrorMessage(cause, "Couldn't connect that folder.") }
  }
}

export async function disconnectDriveFolder(): Promise<
  { ok: true } | { error: string }
> {
  try {
    const result = await djangoAction<{ ok: true }>(
      "disconnect-drive-folder",
      {}
    )
    revalidateDriveReads()
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn't disconnect that folder."),
    }
  }
}

const skipDriveFilesSchema = z.object({
  files: z
    .array(
      z.object({
        driveFileId: z.string().trim().min(1).max(128),
        fileName: z.string().trim().max(255).default(""),
        reason: z.string().trim().max(32).default(""),
        // One document out of a bundle; null skips the whole file, which is
        // what "Never offer this file" sends.
        part: z.number().int().min(0).max(39).nullable().default(null),
      })
    )
    .min(1)
    .max(200),
})

export async function skipDriveFiles(
  input: z.input<typeof skipDriveFilesSchema>
): Promise<{ ok: true } | { error: string }> {
  const parsed = skipDriveFilesSchema.safeParse(input)
  if (!parsed.success) return { error: "Those files look malformed." }
  try {
    const result = await djangoAction<{ ok: true }>(
      "skip-drive-files",
      parsed.data
    )
    revalidateDriveReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn't skip those files.") }
  }
}

export async function unskipDriveFile(
  driveFileId: string
): Promise<{ ok: true } | { error: string }> {
  const parsed = z.string().trim().min(1).max(128).safeParse(driveFileId)
  if (!parsed.success) return { error: "Unknown file." }
  try {
    const result = await djangoAction<{ ok: true }>("unskip-drive-file", {
      driveFileId: parsed.data,
    })
    revalidateDriveReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn't restore that file.") }
  }
}

/**
 * Poll Drive now rather than waiting for the timer. The watcher is a
 * singleton, so this may join a run already in progress; either way the
 * registry is current by the time it answers.
 */
export async function checkDriveNow(): Promise<
  { ok: true; newCount: number } | { error: string }
> {
  await requireUser()
  const session = await getSession()
  if (!session?.billing.entitlements.invoiceAi) {
    return { error: "Invoice reading isn't included on your plan." }
  }
  const { folder } = await getDriveFolder()
  if (!folder) return { error: "No Drive folder is connected." }
  const result = await runDriveWatch()
  revalidateDriveReads()
  if (!result.ok) {
    return { error: result.error ?? "Couldn't check that folder." }
  }
  // Reading what the poll registered takes minutes and the merchant is
  // waiting on this call, so it is left running behind the answer.
  void startDriveRead()
  // The count is this workspace's; the poll was everyone's.
  const { count } = await getDriveFiles("new", 1)
  return { ok: true, newCount: count }
}

/** Put a file the watcher failed on back in line; the next poll reads it. */
export async function retryDriveFile(
  driveFileId: string
): Promise<{ ok: true } | { error: string }> {
  const parsed = z.string().trim().min(1).max(128).safeParse(driveFileId)
  if (!parsed.success) return { error: "Unknown file." }
  try {
    const result = await djangoAction<{ ok: true }>("retry-drive-file", {
      driveFileId: parsed.data,
    })
    revalidateDriveReads()
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn't retry that file.") }
  }
}

/** One receipt the watcher read, ready for the review dialog. `result.part`
 *  says which document inside the file it is — the whole file normally, one
 *  page range or photo region out of a bundle. */
export type ReadyDriveDocument = {
  result: InvoiceParseResult
  /** What Drive says the file is, so the document pane knows whether to draw
   * a page or a photo. */
  mimeType: string
}

/**
 * The inbox: every receipt the watcher has read and nobody has confirmed.
 *
 * A file holds one document normally and several when the reader found a
 * bundle in it, so the blocks are its `ready` parts — a part already imported
 * or skipped has been decided on and is not offered again.
 *
 * The stored document is what the model read; what the workspace knows about
 * it — categories, matched supplier items, whether the invoice is already on
 * file — is probed fresh here, because a document can sit `ready` for days
 * while those answers move. A stored document the schema no longer
 * recognizes is reported, not thrown: one bad row must not close the inbox.
 */
export async function loadReadyDriveDocuments(): Promise<
  | { documents: ReadyDriveDocument[]; readyCount: number; unreadable: number }
  | { error: string }
> {
  await requireUser()
  const session = await getSession()
  if (!session?.billing.entitlements.invoiceAi) {
    return { error: "Invoice reading isn't included on your plan." }
  }
  try {
    const { files, count } = await getDriveFiles("ready", MAX_IMPORT_INVOICES)
    // The dialog reviews one document at a time and the import caps the batch,
    // so a folder of bundles fills the inbox by document, not by file.
    const parts = files
      .flatMap((row) =>
        row.parts
          .filter((part) => part.status === "ready")
          .map((part) => ({ row, part }))
      )
      .slice(0, MAX_IMPORT_INVOICES)
    const stored = parts.flatMap(({ row, part }) => {
      const parsed = storedDriveDocumentSchema.safeParse(part.document)
      if (!parsed.success) return []
      // Documents stored before the reader learned that a till receipt's tax
      // flag is not a unit still carry one; cleaned here rather than re-read.
      const document = {
        ...parsed.data,
        lines: parsed.data.lines.map((line) => ({
          ...line,
          unit: cleanUnit(line.unit),
        })),
      }
      return [{ row, part, document }]
    })
    const documents = await Promise.all(
      stored.map(async ({ row, part, document }) => {
        const {
          fileName,
          driveWebViewLink,
          extractionModel,
          escalated,
          extraction,
          ...invoice
        } = document
        const status = await probeInvoiceLines(invoice, row.driveFileId)
        return {
          mimeType: row.mimeType,
          result: buildInvoiceParseResult(
            {
              fileName,
              part: {
                part: part.part,
                pages:
                  part.pageStart === null || part.pageEnd === null
                    ? null
                    : { start: part.pageStart, end: part.pageEnd },
                region: part.region,
              },
              driveFileId: row.driveFileId,
              driveWebViewLink,
              extractionModel,
              escalated,
              extraction,
            },
            invoice,
            status
          ),
        }
      })
    )
    return {
      documents,
      readyCount: count,
      unreadable: parts.length - stored.length,
    }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn't open the inbox.") }
  }
}
