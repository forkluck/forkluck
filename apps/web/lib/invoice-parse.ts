import "server-only"

import { djangoAction } from "@/lib/backend/client"
import { invoiceAiBudget, type InvoiceAiBudget } from "@/lib/invoice-ai-usage"
import {
  getAiCredential,
  getBusinessSettings,
  getDriveFolder,
} from "@/lib/backend/queries"
import { DRIVE_MAX_IMAGE_BYTES, DRIVE_MAX_PDF_BYTES } from "@/lib/drive-folder"
import {
  DriveServiceError,
  assertFileInFolder,
  fetchDriveFileBytes,
} from "@/lib/google-drive-service"
import {
  detectDocuments,
  extractWithEscalation,
  extractionConfig,
  type ExtractionEngine,
  type ExtractionFile,
} from "@/lib/invoice-extract"
import {
  WHOLE_FILE_PART,
  buildInvoiceParseResult,
  bundleRefusal,
  multiDocumentCount,
  normalizeInvoiceExtraction,
  type DocumentPart,
  type InvoiceExtraction,
  type InvoiceLineStatus,
  type InvoiceParseResult,
  type NormalizedInvoice,
  type PageSize,
} from "@/lib/invoice-import"
import {
  parseInvoiceFromTextLines,
  type TemplateLine,
} from "@/lib/invoice-template"
import { cropImage, prepareImage } from "@/lib/image-prep"
import {
  ImportTooComplexError,
  MAX_IMAGE_UPLOAD_BYTES,
} from "@/lib/import-limits"
import { extractPdfTextLines } from "@/lib/pdf-text"

export type ParseInvoiceInput = {
  /** Uploaded bytes, or null: the file lives in the connected Drive folder
   * and the server fetches it here. */
  file: ExtractionFile | null
  fileName: string
  driveFileId: string | null
  driveWebViewLink: string | null
}

/**
 * Bytes for a file in a connected folder. The folder — not the id the caller
 * holds — is the authorization: a file the service account can read but this
 * workspace never connected is refused before it is fetched. Shared with the
 * unattended reader in lib/drive-read.ts, which has no session to look the
 * folder up with and passes the workspace's own.
 */
export async function fetchDriveFileForExtraction(
  driveFileId: string,
  folderId: string
): Promise<ExtractionFile | { error: string }> {
  try {
    await assertFileInFolder(driveFileId, folderId)
    const fetched = await fetchDriveFileBytes(driveFileId, (mimeType) =>
      mimeType === "application/pdf"
        ? DRIVE_MAX_PDF_BYTES
        : DRIVE_MAX_IMAGE_BYTES
    )
    const file = extractionFile(fetched.mimeType, fetched.base64)
    if (!file) {
      return {
        error:
          fetched.mimeType === "image/heic" || fetched.mimeType === "image/heif"
            ? "iPhone HEIC photos aren't supported — share it as JPEG."
            : "Forkluck reads PDFs and photos; that file is neither.",
      }
    }
    return file
  } catch (cause) {
    return {
      error:
        cause instanceof DriveServiceError
          ? cause.message
          : "Couldn't read that file from Google Drive.",
    }
  }
}

/** The same, for a file the browser only named: the session says which folder
 * this workspace connected. */
async function fetchConnectedDriveFile(
  driveFileId: string | null
): Promise<ExtractionFile | { error: string }> {
  if (!driveFileId) return { error: "That file couldn't be read." }
  try {
    const { folder } = await getDriveFolder()
    if (!folder) return { error: "No Drive folder is connected." }
    return await fetchDriveFileForExtraction(driveFileId, folder.folderId)
  } catch {
    return { error: "Couldn't read that file from Google Drive." }
  }
}

/**
 * A photo, upright and downscaled for the model. Anything the extractor is
 * handed goes through here first; a PDF needs nothing.
 */
export async function prepareExtractionImage(
  file: Extract<ExtractionFile, { kind: "image" }>
): Promise<ExtractionFile | { error: string }> {
  const raw = Buffer.from(file.base64, "base64")
  if (raw.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
    return { error: "That photo is larger than 8 MB." }
  }
  try {
    const prepared = await prepareImage(raw)
    return {
      kind: "image",
      mediaType: prepared.mediaType,
      base64: prepared.base64,
      size: { width: prepared.width, height: prepared.height },
    }
  } catch {
    return { error: "That photo couldn't be read — try a JPEG or PNG." }
  }
}

/**
 * What the workspace knows about the lines this document printed: existing
 * supplier items, the category each one was last filed under, and whether the
 * invoice is already on file. Run after every read — the attended one here,
 * and again when the inbox opens a document the watcher read hours ago, since
 * the answers move while the file waits.
 */
export function probeInvoiceLines(
  invoice: NormalizedInvoice,
  driveFileId: string | null
): Promise<InvoiceLineStatus> {
  return djangoAction<InvoiceLineStatus>("invoice-line-status", {
    supplier: invoice.supplier,
    lines: invoice.lines.map((line) => ({
      sku: line.sku,
      name: line.description,
    })),
    invoice:
      invoice.totalCents !== null
        ? {
            documentType: invoice.documentType,
            invoiceNumber: invoice.invoiceNumber || null,
            invoiceDate: invoice.invoiceDate,
            totalCents: invoice.totalCents,
          }
        : null,
    ...(driveFileId ? { driveFileId } : {}),
  })
}

export type FreeRead = {
  extraction: InvoiceExtraction | null
  scanned: boolean
  /** The PDF's own text lines and page sizes, kept so detection and a
   * per-document template read don't open the file a second time. Empty for a
   * photo. */
  pages: TemplateLine[][]
  pageSizes: PageSize[]
}

/**
 * Step 1 of the pipeline, the read that costs nothing: the PDF's own text
 * layer through the deterministic supplier template. Standard Baldor invoices
 * end here, attended or not. A photo has no text layer to try, a scan comes
 * back `scanned`, and a layout the template does not know comes back with no
 * extraction — all three are what the AI step is for. Two failures stop the
 * pipeline instead: a document past the complexity ceilings, and bytes pdf.js
 * cannot open as a PDF at all. Both are returned as errors so no caller pays
 * to send them to a model that would refuse them too.
 */
export async function readWithoutAi(
  file: ExtractionFile
): Promise<FreeRead | { error: string }> {
  if (file.kind === "image") {
    return { extraction: null, scanned: false, pages: [], pageSizes: [] }
  }
  try {
    const text = await extractPdfTextLines(file.base64)
    if (text.scanned) {
      return {
        extraction: null,
        scanned: true,
        pages: text.pages,
        pageSizes: text.pageSizes,
      }
    }
    return {
      extraction: parseInvoiceFromTextLines(text.pages, text.pageSizes),
      scanned: false,
      pages: text.pages,
      pageSizes: text.pageSizes,
    }
  } catch (cause) {
    if (cause instanceof ImportTooComplexError) return { error: cause.message }
    return { error: "That file isn't a readable PDF." }
  }
}

/** The MIME Drive reported, as the shape the extractor takes; null for
 * anything Forkluck can't read. */
function extractionFile(
  mediaType: string,
  base64: string
): ExtractionFile | null {
  if (mediaType === "application/pdf") return { kind: "pdf", mediaType, base64 }
  if (
    mediaType === "image/jpeg" ||
    mediaType === "image/png" ||
    mediaType === "image/webp"
  ) {
    return { kind: "image", mediaType, base64 }
  }
  return null
}

/**
 * The full parse pipeline for one file, free-first:
 *
 * 1. Text-layer extraction + the deterministic supplier template — no AI, no
 *    key, no cost. Standard Baldor invoices end here.
 * 2. Only when the template defers (unknown layout, scanned PDF, arithmetic
 *    that doesn't reconcile) does the AI come in. By default that is
 *    Forkluck's own engine, which needs nothing from the workspace; a
 *    deployment configured for the `anthropic` engine reads with the
 *    workspace's OWN key instead, and without one the file gets a clear error.
 *
 * A photo or scan has no step 1 to try and goes straight to step 2.
 *
 * One file may hold several documents — a scanned bundle of receipts, a photo
 * of three tickets — so the answer is a list; {@link readDocumentParts} is
 * what finds them, and when it is worth paying to look.
 *
 * Exposed through the /api/invoices/parse route handler rather than a server
 * action so a batch of files can parse concurrently (Next runs server
 * actions one at a time per client).
 */
export async function runInvoiceParse(
  input: ParseInvoiceInput
): Promise<{ documents: InvoiceParseResult[] } | { error: string }> {
  try {
    const file =
      input.file ?? (await fetchConnectedDriveFile(input.driveFileId))
    if ("error" in file) return file
    let aiFile = file
    if (file.kind === "image") {
      const prepared = await prepareExtractionImage(file)
      if ("error" in prepared) return prepared
      aiFile = prepared
    }
    const free = await readWithoutAi(file)
    if ("error" in free) return free

    const currency = workspaceCurrencyOnce()

    // The free path read the whole file as one invoice; nothing is left to
    // split, and no model has been paid.
    if (free.extraction) {
      const document = await buildDocument(input, currency, {
        part: WHOLE_FILE_PART,
        extraction: free.extraction,
        model: "text-layer",
        escalated: false,
      })
      return "error" in document ? document : { documents: [document] }
    }

    const config = extractionConfig()
    // Only the bring-your-own-key engine needs the workspace's credential;
    // on Forkluck's own engine an unconfigured server surfaces its own error
    // from extractInvoice instead.
    let apiKey: string | null = null
    if (config.engine === "anthropic") {
      const credential = await getAiCredential()
      if (!credential.key) {
        if (credential.configured) {
          return {
            error:
              "Your saved AI key can't be read — remove it and add it again.",
          }
        }
        if (file.kind === "image") {
          return {
            error:
              "Photos and scans need AI reading — connect an AI key (optional) to import them.",
          }
        }
        return {
          error: free.scanned
            ? "This looks like a scanned PDF. Forkluck reads digital invoices for free — for scans, connect an AI key (optional) and retry."
            : "Couldn't read this supplier's layout automatically yet. Connect an AI key (optional) to have AI read it.",
        }
      }
      apiKey = credential.key
    }
    // Fetch categories first so the AI prompt can offer them; the real
    // per-line probe runs after extraction, once supplier/SKUs are known.
    // The same call answers whether this Drive file is already imported —
    // re-running an import over the same folder must not pay to extract it
    // again just to be told it is a duplicate afterwards.
    const categories = await djangoAction<InvoiceLineStatus>(
      "invoice-line-status",
      input.driveFileId
        ? { supplier: "unknown", lines: [], driveFileId: input.driveFileId }
        : { supplier: "unknown", lines: [] }
    )
    if (categories.driveFileKnown) {
      return { error: "That Drive file has already been imported." }
    }
    const categoryNames = categories.categories.map((category) => category.name)
    const options = {
      engine: config.engine,
      model: config.model,
      apiKey,
      budget:
        config.engine === "qwen"
          ? invoiceAiBudget(file.kind === "image" ? 1 : free.pageSizes.length)
          : undefined,
    }

    const reads = await readDocumentParts(aiFile, free, categoryNames, options)
    if (!Array.isArray(reads)) return reads
    return await buildDocuments(input, currency, reads)
  } catch (error) {
    return {
      error:
        error instanceof Error && error.message
          ? error.message
          : "Couldn't parse that file.",
    }
  }
}

type AiOptions = {
  engine: ExtractionEngine
  model: string
  apiKey: string | null
  budget?: InvoiceAiBudget
}

/**
 * One document found inside a file, as the read that found it left it: the raw
 * extraction, which part of the file it came from, and what read it.
 */
export type DocumentRead = {
  part: DocumentPart
  extraction: InvoiceExtraction
  model: string
  escalated: boolean
  pageSizes?: PageSize[]
}

/**
 * Every document the AI can find in one file. Splitting costs an extra model
 * call, so it is only attempted where a bundle is possible: a multi-page PDF
 * the free path could not read as one invoice, and a photo the reader itself
 * refused as a bundle. One part is read at a time, never in parallel: each is
 * billed per call and the model endpoint rate-limits.
 *
 * A part that could not be read is dropped — a bundle is worth keeping when
 * one receipt in it is unreadable — and only a file where nothing came back is
 * an error, reported as the first one.
 *
 * The attended pipeline above and the unattended reader in lib/drive-read.ts
 * both find their documents here and normalize them with
 * {@link normalizeDocumentRead}.
 */
export function readDocumentParts(
  file: ExtractionFile,
  free: FreeRead,
  categoryNames: string[],
  options: AiOptions
): Promise<DocumentRead[] | { error: string }> {
  return file.kind === "image"
    ? readPhotoParts(file, categoryNames, options)
    : readPdfParts(file, free, categoryNames, options)
}

/**
 * A photo: one read, and only a reader that refused it as a bundle earns the
 * second call that splits it. Regions come back as fractions of the prepared
 * image — the pixels the model saw — so each crop lands where it pointed.
 */
async function readPhotoParts(
  file: Extract<ExtractionFile, { kind: "image" }>,
  categoryNames: string[],
  options: AiOptions
): Promise<DocumentRead[] | { error: string }> {
  const run = await extractWithEscalation(file, categoryNames, options)
  if (!("error" in run)) return [documentRead(WHOLE_FILE_PART, run)]

  const count = run.notUsable ? multiDocumentCount(run.notUsable) : null
  // Refused for some other reason — a menu, a bank statement — which splitting
  // would not fix.
  if (count === null) return { error: run.error }

  const detected = await detectDocuments(
    { kind: "image", base64: file.base64, mediaType: file.mediaType },
    options
  )
  // Asked to point at several receipts, the model sometimes answers the same
  // rectangle twice; importing one receipt twice is worse than refusing the
  // photo, so a repeated region counts once.
  const seen = new Set<string>()
  const regions =
    "error" in detected
      ? []
      : detected.documents.flatMap((document) => {
          if (!("region" in document)) return []
          const key = [
            document.region.x0,
            document.region.y0,
            document.region.x1,
            document.region.y1,
          ]
            .map((fraction) => fraction.toFixed(2))
            .join(",")
          if (seen.has(key)) return []
          seen.add(key)
          return [document.region]
        })
  if (regions.length < 2) return { error: bundleRefusal(count, "photo") }

  const prepared = Buffer.from(file.base64, "base64")
  const reads: DocumentRead[] = []
  let firstError: string | null = null
  for (const [index, region] of regions.entries()) {
    const crop = await cropImage(prepared, region)
    const one = await extractWithEscalation(
      {
        kind: "image",
        mediaType: crop.mediaType,
        base64: crop.base64,
        size: { width: crop.width, height: crop.height },
      },
      categoryNames,
      options
    )
    if ("error" in one) {
      firstError ??= one.error
      continue
    }
    reads.push(documentRead({ part: index, pages: null, region }, one))
  }
  return reads.length > 0
    ? reads
    : { error: firstError ?? bundleRefusal(count, "photo") }
}

/**
 * A PDF the free path could not read as one invoice. A file of several pages
 * is asked how many documents it holds first; one document (or an answer that
 * makes no sense) is the normal whole-file read, several are extracted one
 * range at a time — through the template when the pages carry text, through
 * the model otherwise.
 */
async function readPdfParts(
  file: ExtractionFile,
  free: FreeRead,
  categoryNames: string[],
  options: AiOptions
): Promise<DocumentRead[] | { error: string }> {
  const pageCount = free.pageSizes.length
  let ranges: Array<{ start: number; end: number }> = []
  if (pageCount > 1) {
    const detected = await detectDocuments(
      free.scanned
        ? { kind: "pdf-scan", base64: file.base64 }
        : {
            kind: "pdf-text",
            pages: free.pages.map((page) =>
              page.map((line) => line.text).join("\n")
            ),
          },
      options
    )
    if (!("error" in detected)) {
      ranges = detected.documents.flatMap((document) =>
        "pageStart" in document && document.pageStart < pageCount
          ? [
              {
                start: document.pageStart,
                end: Math.min(document.pageEnd, pageCount - 1),
              },
            ]
          : []
      )
    }
  }

  // One document, or nothing usable back: the file is read whole, exactly as
  // it was before any of this existed.
  if (ranges.length < 2) {
    const run = await extractWithEscalation(file, categoryNames, options)
    if ("error" in run) {
      const count = run.notUsable ? multiDocumentCount(run.notUsable) : null
      return {
        error: count === null ? run.error : bundleRefusal(count, "scan"),
      }
    }
    return [documentRead(WHOLE_FILE_PART, run)]
  }

  const reads: DocumentRead[] = []
  let firstError: string | null = null
  for (const [index, pages] of ranges.entries()) {
    const part = { part: index, pages, region: null }
    if (!free.scanned) {
      // The whole file's page sizes, not the slice's: a template line keeps
      // the page index it was read at, so its box stays absolute.
      const templated = parseInvoiceFromTextLines(
        free.pages.slice(pages.start, pages.end + 1),
        free.pageSizes
      )
      if (templated) {
        reads.push({
          part,
          extraction: templated,
          model: "text-layer",
          escalated: false,
        })
        continue
      }
    }
    const one = await extractWithEscalation(file, categoryNames, {
      ...options,
      pages,
    })
    if ("error" in one) {
      firstError ??= one.error
      continue
    }
    reads.push(documentRead(part, one))
  }
  return reads.length > 0
    ? reads
    : { error: firstError ?? "Couldn't read that file." }
}

/** Keeps only what a reviewed or stored document needs out of a model run. */
function documentRead(
  part: DocumentPart,
  run: {
    extraction: InvoiceExtraction
    model: string
    escalated: boolean
    pageSizes?: PageSize[]
  }
): DocumentRead {
  return {
    part,
    extraction: run.extraction,
    model: run.model,
    escalated: run.escalated,
    pageSizes: run.pageSizes,
  }
}

/**
 * One read as both the reviewer and the inbox hold it: the normalizer, plus
 * the page shift a ranged model read needs. A page range the model read on its
 * own was shown only its own pages, so it counted them from 0; the viewer
 * draws on the whole file. The text-layer path needs no shift — its lines
 * carry the page they were read at.
 */
export function normalizeDocumentRead(
  read: DocumentRead,
  workspaceCurrency?: string
): NormalizedInvoice | { error: string } {
  const normalized = normalizeInvoiceExtraction(
    read.extraction,
    workspaceCurrency,
    read.pageSizes
  )
  if ("error" in normalized) return normalized

  const offset = read.model === "text-layer" ? 0 : (read.part.pages?.start ?? 0)
  if (offset === 0) return normalized
  return {
    ...normalized,
    lines: normalized.lines.map((line) =>
      line.box
        ? { ...line, box: { ...line.box, page: line.box.page + offset } }
        : line
    ),
  }
}

/** The workspace's currency, fetched at most once per file however many
 * documents it turns out to hold. */
function workspaceCurrencyOnce(): () => Promise<string> {
  let pending: Promise<string> | null = null
  return () =>
    (pending ??= getBusinessSettings().then(
      (settings) => settings.currencyCode
    ))
}

/**
 * Every read built into the result the reviewer renders. A bundle is worth
 * importing even when one receipt in it is unreadable; only a bundle where
 * nothing could be read is an error, and then it is the first one.
 */
async function buildDocuments(
  input: ParseInvoiceInput,
  currency: () => Promise<string>,
  reads: DocumentRead[]
): Promise<{ documents: InvoiceParseResult[] } | { error: string }> {
  const documents: InvoiceParseResult[] = []
  let firstError: string | null = null
  for (const read of reads) {
    const one = await buildDocument(input, currency, read)
    if ("error" in one) {
      firstError ??= one.error
      continue
    }
    documents.push(one)
  }
  if (documents.length === 0) {
    return { error: firstError ?? "Couldn't read that file." }
  }
  return { documents }
}

/** One read, normalized and probed into the result the reviewer renders. */
async function buildDocument(
  input: ParseInvoiceInput,
  currency: () => Promise<string>,
  read: DocumentRead
): Promise<InvoiceParseResult | { error: string }> {
  // Only a document that printed its own currency needs the workspace's to
  // compare against; the template path never reads one.
  const document = normalizeDocumentRead(
    read,
    read.extraction.currency ? await currency() : undefined
  )
  if ("error" in document) return document

  // The pre-flight probe in runInvoiceParse already answered for this Drive
  // file, so the id is not asked about twice.
  const status = await probeInvoiceLines(document, null)

  return buildInvoiceParseResult(
    {
      fileName: input.fileName,
      part: read.part,
      driveFileId: input.driveFileId,
      driveWebViewLink: input.driveWebViewLink,
      extractionModel: read.model,
      escalated: read.escalated,
      extraction: read.extraction,
    },
    document,
    status
  )
}
