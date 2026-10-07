import "server-only"

import { createAnthropic } from "@ai-sdk/anthropic"
import Anthropic from "@anthropic-ai/sdk"
import {
  APICallError,
  NoObjectGeneratedError,
  generateObject,
  type LanguageModel,
  type ModelMessage,
} from "ai"
import { z } from "zod"

import {
  chooseExtraction,
  escalationHint,
  extractionFindings,
  needsEscalation,
} from "@/lib/invoice-escalation"
import {
  invoiceExtractionSchema,
  normalizeInvoiceExtraction,
  notUsableMessage,
  type InvoiceExtraction,
  type NormalizedInvoice,
  type PageSize,
} from "@/lib/invoice-import"

/**
 * The invoice pipeline's AI adapter. Everything upstream and downstream is
 * pure and tested against fixtures (tests/fixtures/invoices/), so swapping the
 * engine means changing only this module and re-running the eval.
 *
 * Who pays: the workspace's own Anthropic key, stored per workspace; a
 * workspace without one is told so instead of being read. Retries are
 * bounded; actual charges depend on provider pricing and usage.
 *
 * The Anthropic call runs through the `ai` SDK because @ai-sdk/anthropic 4.0
 * asks for Anthropic's native structured outputs (`structuredOutputMode:
 * "outputFormat"`) rather than emulating them with a JSON tool; only
 * `verifyAnthropicKey` still needs the Anthropic SDK, for `countTokens`.
 */

const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5"
/** The SDK counts a timeout as a transport failure, so a low retry budget is
 * what keeps a slow-but-successful invoice from being billed three times. */
const EXTRACTION_TIMEOUT_MS = 300_000
const EXTRACTION_MAX_RETRIES = 1
/** A PDF is read as page images: past four pages it is a bundle, not a
 * document this pipeline handles. */
const MAX_PDF_PAGES = 4
/** Rasterizing a scanned page: 2x so small receipt print stays legible, but
 * never past the longest edge the vision model accepts whole. */
const RASTER_SCALE = 2
const RASTER_MAX_EDGE_PX = 2576
/** Detection only has to see where one document ends and the next begins, so
 * its pass is cheap: half scale, and never more pages than this. */
const DETECTION_RASTER_SCALE = 0.5
const DETECTION_MAX_PAGES = 20

/** Deployment's two model tiers. Pure, so the eval script and the tests read
 * exactly what the parse path runs on. `INVOICE_ESCALATION_MODEL` unset means
 * a second, hinted read on the same model; empty disables the second pass. */
export function extractionConfig(): { model: string; escalationModel: string } {
  const model =
    process.env.INVOICE_EXTRACTION_MODEL?.trim() || ANTHROPIC_DEFAULT_MODEL
  const escalationModel = process.env.INVOICE_ESCALATION_MODEL
  return {
    model,
    escalationModel:
      escalationModel === undefined ? model : escalationModel.trim(),
  }
}

/** Document framing and a synthetic receipt example. Per-field rules live
 * on the schema's .describe() text, which the SDK forwards to the model. */
function buildPrompt(
  categoryNames: string[],
  hint: string | undefined
): string {
  return [
    "Transcribe this supplier document (an invoice, receipt, credit memo, or refund) exactly as printed, field by field, following each field's description.",
    "Lines are the purchased items only: skip subtotal, tax, total, payment and return rows, and skip pre-printed form text that has no quantity or amount next to it. A supplier's item code goes in sku, never in the description.",
    "Wegmans receipt layout: a standalone quantity @ unit-price row is a PREFIX for the NEXT item printed BELOW it, not a continuation of the previous item. Verify that quantity times unit price matches that next item's printed amount. Other till receipts can place this row before or after the item, so check both neighbors. Do not move or calculate the printed item amounts.",
    "Synthetic example, in printed order: SLICED TURKEY 5.49 F / 4 @ 1.50 / PEARS 6.00 F / LIME 0.79 F. The PEARS have quantity 4 and unitPrice 1.50; the turkey and lime have no printed quantity or unit price, so those fields are null. All three have unit null (F is a tax flag) and packSize null (4 @ 1.50 is a price calculation, not a pack).",
    "A separate quantity/price row belongs to only one item. If its placement remains ambiguous or its arithmetic matches neither neighbor, leave the disputed fields null and mark the affected line uncertain. Never invent a quantity of 1 or a unit that the receipt does not print.",
    "Highlight boxes must follow the same item ownership as quantities. In the synthetic example the turkey box encloses SLICED TURKEY 5.49 F only and ends ABOVE 4 @ 1.50; the pears box includes its 4 @ 1.50 prefix and PEARS 6.00 F. Never include a neighboring item's quantity row in a box.",
    "",
    `The category names you may choose from are: ${categoryNames.join(", ").slice(0, 8000)}.`,
    ...(hint ? ["", hint] : []),
  ].join("\n")
}

/** What the model is handed. The kind is decided upstream, from the MIME the
 * route validated or the one Drive reported; the SDK carries both a PDF and a
 * photo as a file part, distinguished by its media type. */
export type ExtractionFile =
  | { kind: "pdf"; mediaType: "application/pdf"; base64: string }
  | {
      kind: "image"
      mediaType: "image/jpeg" | "image/png" | "image/webp"
      base64: string
      /** Pixel size of these bytes, once prepareImage has measured them. The
       * prepared image is what the model sees and — since prepareImage applies
       * EXIF rotation and browsers auto-rotate an <img> the same way — also what
       * the reviewer sees, so a fraction of it needs no rotation math. */
      size?: PageSize
    }

export type ExtractionOptions = {
  model: string
  /** The workspace's Anthropic key. */
  apiKey: string
  /** Validator findings from a first read, appended to the prompt. */
  hint?: string
  /** The one document inside a multi-document PDF this read is for, as a
   * 0-based inclusive page range. The whole file when absent. */
  pages?: { start: number; end: number }
}

export type ExtractionRead = {
  extraction: InvoiceExtraction
  usage: { inputTokens: number; outputTokens: number }
  model: string
  /** Pixel size of each page the model was shown, when it is known — what
   * turns a box answered in pixels back into fractions. */
  pageSizes?: PageSize[]
}

function anthropicModel(options: {
  model: string
  apiKey: string
}): LanguageModel {
  return createAnthropic({ apiKey: options.apiKey })(options.model)
}

/** A scan longer than one document: refused by name, so the parser can say so
 * in the reader's words instead of "extraction failed". */
export class ScanTooLongError extends Error {}

type RasterOptions = {
  /** 0-based inclusive page range inside the file; the whole file by default. */
  pages?: { start: number; end: number }
  /** The low-resolution pass detection reads: half scale, capped at
   * {@link DETECTION_MAX_PAGES} pages, and never refused for being long — it
   * exists precisely to split a long scan up. */
  preview?: boolean
}

/** A PDF is read as page images, which is what gives each line a box the
 * viewer can draw and lets one range of a bundle be read on its own. The
 * canvas binary is imported here and nowhere else. */
async function rasterizePdf(base64: string, options: RasterOptions = {}) {
  const { getDocumentProxy, renderPageAsImage } = await import("unpdf")
  const pdf = await getDocumentProxy(
    new Uint8Array(Buffer.from(base64, "base64"))
  )
  // 1-based, the way pdf.js counts pages.
  const first = Math.max(1, (options.pages?.start ?? 0) + 1)
  const last = Math.min(
    pdf.numPages,
    (options.pages?.end ?? pdf.numPages - 1) + 1
  )
  const count = last - first + 1
  if (!options.preview && count > MAX_PDF_PAGES) {
    throw new ScanTooLongError(
      `This scan has ${count} pages; Forkluck reads up to ${MAX_PDF_PAGES} per document.`
    )
  }
  const end = options.preview
    ? Math.min(last, first + DETECTION_MAX_PAGES - 1)
    : last
  const parts = []
  const pageSizes: PageSize[] = []
  for (let page = first; page <= end; page += 1) {
    // 2x is what keeps the small print on a receipt legible; the cap only
    // bites on a page already larger than letter, which the model downsamples
    // anyway.
    const viewport = (await pdf.getPage(page)).getViewport({ scale: 1 })
    const longestEdge = Math.max(viewport.width, viewport.height)
    const scale = options.preview
      ? DETECTION_RASTER_SCALE
      : Math.min(RASTER_SCALE, RASTER_MAX_EDGE_PX / longestEdge)
    const png = await renderPageAsImage(pdf, page, {
      canvasImport: () => import("@napi-rs/canvas"),
      scale,
    })
    parts.push({
      type: "file" as const,
      data: Buffer.from(png).toString("base64"),
      mediaType: "image/png",
    })
    pageSizes.push({
      width: viewport.width * scale,
      height: viewport.height * scale,
    })
  }
  return { parts, pageSizes }
}

/** The message the model is sent, and the pixel size of each page it shows —
 * undefined for an image nothing has measured. */
async function userMessage(
  file: ExtractionFile,
  prompt: string,
  pages?: { start: number; end: number }
): Promise<{
  message: ModelMessage
  pageSizes?: PageSize[]
  pageImages?: string[]
}> {
  const rasterized =
    file.kind === "pdf" ? await rasterizePdf(file.base64, { pages }) : null
  const document = rasterized?.parts ?? [
    { type: "file" as const, data: file.base64, mediaType: file.mediaType },
  ]
  return {
    message: {
      role: "user",
      content: [...document, { type: "text", text: prompt }],
    },
    pageSizes:
      rasterized?.pageSizes ??
      (file.kind === "image" && file.size ? [file.size] : undefined),
    pageImages:
      rasterized?.parts.map((part) => part.data) ??
      (file.kind === "image" ? [file.base64] : undefined),
  }
}

/** Keep the visual evidence with a quantity that normalization reassigns.
 * Reuse the pixels already sent to the reader; no extra model call or render.
 * Numeric transcription stays intact for the normalizer and audit evidence. */
export async function alignReceiptHighlights(
  extraction: InvoiceExtraction,
  pageImages: string[] | undefined,
  pageSizes?: PageSize[]
): Promise<InvoiceExtraction> {
  if (!pageImages || extraction.documentType !== "receipt") return extraction
  const normalized = normalizeInvoiceExtraction(
    extraction,
    undefined,
    pageSizes
  )
  if ("error" in normalized || normalized.supplier !== "wegmans")
    return extraction
  const lines = [...extraction.lines]
  const refinedBottoms = new Map<number, number>()
  // Trim an item box that includes part of the following item's amount row
  // before adding any reassigned prefix above it.
  for (
    let position = 0;
    position < normalized.lines.length - 1;
    position += 1
  ) {
    const line = normalized.lines[position]
    const next = normalized.lines[position + 1]
    if (
      !line.box ||
      !next.box ||
      line.box.page !== next.box.page ||
      line.box.y0 >= next.box.y0 ||
      line.box.y1 <= next.box.y0 ||
      !pageImages[line.box.page]
    )
      continue
    try {
      const { receiptItemBottomBoundary } = await import("@/lib/image-prep")
      const bottom = await receiptItemBottomBoundary(
        Buffer.from(pageImages[line.box.page], "base64"),
        { ...line.box, y1: Math.max(line.box.y1, next.box.y1) }
      )
      if (bottom === null || bottom >= line.box.y1) continue
      const index = extraction.lines.indexOf(line.raw)
      refinedBottoms.set(index, bottom)
      lines[index] = {
        ...lines[index],
        box: {
          page: line.box.page,
          bbox_2d: [line.box.x0, line.box.y0, line.box.x1, bottom],
        },
      }
    } catch {
      // Keep the model's rectangle if its pixels cannot be checked.
    }
  }
  for (let index = 0; index < normalized.lines.length - 1; index += 1) {
    const source = normalized.lines[index]
    const next = normalized.lines[index + 1]
    // A changed quantity is the existing normalizer's verified prefix transfer.
    if (
      source.quantity !== null ||
      (source.raw.quantity === null && source.raw.packSize === null) ||
      next.quantity === null ||
      next.raw.quantity !== null ||
      !source.box ||
      !next.box
    )
      continue
    const pixels = pageImages[source.box.page]
    if (!pixels) continue
    try {
      const { receiptPrefixBoundary } = await import("@/lib/image-prep")
      const boundary = await receiptPrefixBoundary(
        Buffer.from(pixels, "base64"),
        { ...source.box, y1: Math.min(source.box.y1, next.box.y0) }
      )
      if (boundary === null || boundary >= next.box.y0) continue
      const sourceIndex = extraction.lines.indexOf(source.raw)
      const nextIndex = extraction.lines.indexOf(next.raw)
      lines[sourceIndex] = {
        ...lines[sourceIndex],
        box: {
          page: source.box.page,
          bbox_2d: [source.box.x0, source.box.y0, source.box.x1, boundary],
        },
      }
      lines[nextIndex] = {
        ...lines[nextIndex],
        box: {
          page: next.box.page,
          bbox_2d: [
            Math.min(source.box.x0, next.box.x0),
            boundary,
            Math.max(source.box.x1, next.box.x1),
            refinedBottoms.get(nextIndex) ?? next.box.y1,
          ],
        },
      }
    } catch {
      // A failed optional pixel check must not lose a successful transcription.
    }
  }
  return { ...extraction, lines }
}

export async function extractInvoice(
  file: ExtractionFile,
  categoryNames: string[],
  options: ExtractionOptions
): Promise<ExtractionRead | { error: string }> {
  const model = anthropicModel(options)
  const startedAt = performance.now()
  const signal = AbortSignal.timeout(EXTRACTION_TIMEOUT_MS)
  try {
    const { message, pageSizes, pageImages } = await userMessage(
      file,
      buildPrompt(categoryNames, options.hint),
      options.pages
    )
    const preparationMs = Math.round(performance.now() - startedAt)
    const modelStartedAt = performance.now()
    const result = await generateObject({
      model,
      schema: invoiceExtractionSchema,
      maxOutputTokens: 16000,
      maxRetries: EXTRACTION_MAX_RETRIES,
      abortSignal: signal,
      providerOptions: {
        anthropic: { structuredOutputMode: "outputFormat", effort: "medium" },
      },
      messages: [message],
    })
    const modelMs = Math.round(performance.now() - modelStartedAt)
    const extraction = await alignReceiptHighlights(
      result.object,
      pageImages,
      pageSizes
    )
    // One line per pass: what the read cost, and why the call stopped.
    console.info("invoice-extract", {
      model: options.model,
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      stopReason: result.finishReason,
      escalated: options.hint !== undefined,
      lines: result.object.lines.length,
      preparationMs,
      modelMs,
      elapsedMs: Math.round(performance.now() - startedAt),
    })
    const stopped = stopReasonError(result.finishReason)
    if (stopped) return stopped
    return {
      extraction,
      usage: {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      },
      model: options.model,
      pageSizes,
    }
  } catch (error) {
    if (signal.aborted) {
      return {
        error:
          "The AI reader took too long. Please retry or upload a clearer scan.",
      }
    }
    if (error instanceof ScanTooLongError) return { error: error.message }
    if (NoObjectGeneratedError.isInstance(error)) {
      return (
        stopReasonError(error.finishReason) ?? {
          error: "Extraction returned no usable data — try again.",
        }
      )
    }
    if (APICallError.isInstance(error)) {
      if (error.statusCode === 401 || error.statusCode === 403) {
        return {
          error:
            "Anthropic rejected your API key — check it under AI key on the Invoices page.",
        }
      }
      return {
        error: `Extraction failed (${error.statusCode ?? "network"}) — try again.`,
      }
    }
    return { error: "Extraction failed — try again." }
  }
}

/** Anthropic maps a refusal to `content-filter` and a truncated answer to
 * `length`; both are the model's own words about why it stopped. */
function stopReasonError(
  finishReason: string | undefined
): { error: string } | null {
  if (finishReason === "content-filter") {
    return { error: "The model declined to read this file." }
  }
  if (finishReason === "length") {
    return { error: "This document is too long to extract in one pass." }
  }
  return null
}

export type ExtractionRun = {
  normalized: NormalizedInvoice
  extraction: InvoiceExtraction
  model: string
  escalated: boolean
  usage: { inputTokens: number; outputTokens: number }
  /** Pixel size of each page the model was shown, for a caller that normalizes
   * this extraction again with the workspace's currency. */
  pageSizes?: PageSize[]
}

/**
 * Validator-gated escalation: the tier-2 read runs first, and only a document
 * whose arithmetic, header or lines did not check out earns a second read —
 * with the findings as a hint — on the tier-3 model, which by default is the
 * same model reading the same document better informed. Free of Django and of
 * the request pipeline so the eval script runs the same rule.
 *
 * Escalation only ever happens once, and a failed second pass keeps the first
 * read rather than failing the file.
 */
export async function extractWithEscalation(
  file: ExtractionFile,
  categoryNames: string[],
  options: {
    model: string
    apiKey: string
    /** One document's page range inside a multi-document PDF. */
    pages?: { start: number; end: number }
  }
): Promise<ExtractionRun | { error: string; notUsable?: string }> {
  const first = await extractInvoice(file, categoryNames, options)
  if ("error" in first) return first
  // A file the model refused stops here rather than in normalization, so the
  // caller can see the refusal's own words: "three receipts" is a file to
  // split, not a file to reject.
  if (first.extraction.notUsable) {
    return {
      error: notUsableMessage(first.extraction.notUsable),
      notUsable: first.extraction.notUsable,
    }
  }
  const firstNormalized = normalizeInvoiceExtraction(
    first.extraction,
    undefined,
    first.pageSizes
  )
  if ("error" in firstNormalized) return firstNormalized

  const escalationModel =
    process.env.INVOICE_ESCALATION_MODEL?.trim() ?? options.model
  const kept: ExtractionRun = {
    normalized: firstNormalized,
    extraction: first.extraction,
    model: first.model,
    escalated: false,
    usage: first.usage,
    pageSizes: first.pageSizes,
  }
  if (!escalationModel || !needsEscalation(firstNormalized)) return kept

  const second = await extractInvoice(file, categoryNames, {
    model: escalationModel,
    apiKey: options.apiKey,
    pages: options.pages,
    hint: escalationHint(extractionFindings(firstNormalized)),
  })
  if ("error" in second) return kept
  const secondNormalized = normalizeInvoiceExtraction(
    second.extraction,
    undefined,
    second.pageSizes
  )
  if ("error" in secondNormalized) return kept

  // Both passes were billed whichever read wins.
  const usage = {
    inputTokens: first.usage.inputTokens + second.usage.inputTokens,
    outputTokens: first.usage.outputTokens + second.usage.outputTokens,
  }
  const { pick } = chooseExtraction(firstNormalized, secondNormalized)
  return pick === "escalation"
    ? {
        normalized: secondNormalized,
        extraction: second.extraction,
        model: second.model,
        escalated: true,
        usage,
        pageSizes: second.pageSizes,
      }
    : { ...kept, usage }
}

// --- Detection: how many documents this file holds --------------------------

/** One document inside a file: a page range of a PDF, or a region of a photo
 * as fractions from the top-left. */
export type DetectedDocument =
  | { pageStart: number; pageEnd: number }
  | { region: { x0: number; y0: number; x1: number; y1: number } }

export type DetectionInput =
  | { kind: "pdf-text"; pages: string[] }
  | { kind: "pdf-scan"; base64: string }
  | {
      kind: "image"
      base64: string
      mediaType: "image/jpeg" | "image/png" | "image/webp"
    }

/** Flat and nullable rather than a union: one object shape per array element,
 * and a page range and a region are never both answered for the same file. */
const detectionSchema = z.object({
  documents: z
    .array(
      z.object({
        pageStart: z
          .number()
          .nullable()
          .describe(
            "First page of this document, counting from 0; null for a photo."
          ),
        pageEnd: z
          .number()
          .nullable()
          .describe(
            "Last page of this document, counting from 0; null for a photo."
          ),
        region: z
          .object({
            x0: z.number(),
            y0: z.number(),
            x1: z.number(),
            y1: z.number(),
          })
          .nullable()
          .describe(
            "For a photo: this receipt's rectangle as fractions of the image from the top-left corner (0 to 1). Null for a PDF."
          ),
      })
    )
    .describe("Every document in the file, in reading order."),
})

/** Only the first lines of a page matter for detection — a header is what
 * starts a new document — and the whole prompt has to stay small. */
const DETECTION_TEXT_LINES = 40

/**
 * How many documents a file holds, and where each one sits. Run only when
 * there is reason to believe there is more than one: a PDF of several pages,
 * or a photo the reader already refused as a bundle. One structured-output
 * call.
 */
export async function detectDocuments(
  input: DetectionInput,
  options: { model: string; apiKey: string }
): Promise<{ documents: DetectedDocument[] } | { error: string }> {
  const model = anthropicModel(options)
  const prompt = [
    "This file may hold more than one supplier document.",
    "List each document's page range (first and last page, 0-based) — or for a single photo, each receipt's region as fractions of the image from the top-left — in reading order.",
    "One entry when there is only one document.",
  ].join("\n")
  const content: Array<
    | { type: "text"; text: string }
    | { type: "file"; data: string; mediaType: string }
  > = []
  if (input.kind === "pdf-text") {
    content.push({
      type: "text",
      text: input.pages
        .map(
          (page, index) =>
            `--- page ${index} ---\n${page.split("\n").slice(0, DETECTION_TEXT_LINES).join("\n").slice(0, 4000)}`
        )
        .join("\n")
        .slice(0, 80_000),
    })
  } else if (input.kind === "pdf-scan") {
    const rasterized = await rasterizePdf(input.base64, { preview: true })
    content.push(...rasterized.parts)
  } else {
    content.push({
      type: "file",
      data: input.base64,
      mediaType: input.mediaType,
    })
  }
  content.push({ type: "text", text: prompt })
  try {
    const result = await generateObject({
      model,
      schema: detectionSchema,
      maxOutputTokens: 2000,
      maxRetries: EXTRACTION_MAX_RETRIES,
      abortSignal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
      messages: [{ role: "user", content }],
    })
    const documents: DetectedDocument[] = []
    for (const document of result.object.documents) {
      if (document.region) {
        documents.push({ region: document.region })
      } else if (document.pageStart !== null && document.pageEnd !== null) {
        documents.push({
          pageStart: Math.max(0, Math.trunc(document.pageStart)),
          pageEnd: Math.max(
            Math.trunc(document.pageStart),
            Math.trunc(document.pageEnd)
          ),
        })
      }
    }
    console.info("invoice-detect", {
      model: options.model,
      kind: input.kind,
      documents: documents.length,
    })
    return { documents }
  } catch {
    return { error: "Couldn't tell how many documents this file holds." }
  }
}

/** Cheap live check used before saving a key: count_tokens costs nothing and
 * fails fast on a typo'd or revoked key. */
export async function verifyAnthropicKey(
  apiKey: string
): Promise<{ ok: true } | { error: string }> {
  const client = new Anthropic({ apiKey, timeout: 15_000, maxRetries: 0 })
  try {
    // The default model: this verifies the key, not the configured model.
    await client.messages.countTokens({
      model: ANTHROPIC_DEFAULT_MODEL,
      messages: [{ role: "user", content: "ping" }],
    })
    return { ok: true }
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return {
        error: "Anthropic rejected that key — copy it again from the console.",
      }
    }
    if (error instanceof Anthropic.PermissionDeniedError) {
      return { error: "That key doesn't have access to the extraction model." }
    }
    return {
      error: "Couldn't verify that key — check your connection and try again.",
    }
  }
}
