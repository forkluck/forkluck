import "server-only"

import {
  failDriveExtraction,
  getDriveFilesForWorkspace,
  probeInvoiceLinesForWorkspace,
  saveDriveExtraction,
} from "@/lib/backend/queries"
import type { DriveWatchFolder } from "@/lib/backend/types"
import { DriveServiceError } from "@/lib/google-drive-service"
import { extractionConfig } from "@/lib/invoice-extract"
import { InvoiceAiBudgetError, invoiceAiBudget } from "@/lib/invoice-ai-usage"
import { WHOLE_FILE_PART, type StoredDriveDocument } from "@/lib/invoice-import"
import {
  fetchDriveFileForExtraction,
  normalizeDocumentRead,
  prepareExtractionImage,
  readDocumentParts,
  readWithoutAi,
  type DocumentRead,
} from "@/lib/invoice-parse"

/**
 * Reading the receipts nobody asked for yet.
 *
 * The watcher registers what appears in a connected folder; this reads those
 * files with Forkluck's own engine and stores what it found, so the merchant
 * opens the inbox to documents already read rather than waiting on a spinner.
 * Nothing is imported here — a read is a proposal, and every line still goes
 * through the review dialog.
 *
 * One file may hold several documents — a scanned bundle of receipts, a photo
 * of three tickets — so a read stores a part per document. Finding them is
 * `readDocumentParts` in lib/invoice-parse.ts, the same reader the attended
 * pipeline uses; what is here is only what becomes a stored row.
 */

/** Files started per workspace per run — files, not the documents they turn
 * out to hold. Small on purpose: a tick is shared by every workspace, and the
 * next one is minutes away. */
const DEFAULT_PER_RUN = 5

/** How long a run may keep starting files. The 300 s per-file abort in
 * lib/invoice-extract.ts still bounds the one already running. */
const DEFAULT_BUDGET_MS = 240_000

export type DriveReadCounts = {
  /** Documents stored against a `ready` row; a bundle counts once per receipt
   * it turned out to hold. */
  read: number
  /** Files given up on. */
  failed: number
  /** Registered files this run fetched but never started, the budget having
   * run out; the next tick takes them. */
  skipped: number
}

function perRunFromEnv(): number {
  const configured = Number(process.env.DRIVE_READ_PER_RUN)
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_PER_RUN
}

/** What the row is told. A merchant sees this under "Couldn't read", so it is
 * the model's or Drive's own wording, never a stack. */
function readError(cause: unknown): string {
  return cause instanceof DriveServiceError
    ? cause.message
    : "Couldn't read that receipt."
}

/**
 * Read what every connected folder is holding.
 *
 * A workspace whose folder has never been listed in full is left alone: its
 * registry is not yet the folder, and reading half of it would spend money on
 * the wrong half first.
 */
export async function readNewDriveFiles({
  folders,
  budgetMs = DEFAULT_BUDGET_MS,
  perRun = perRunFromEnv(),
}: {
  folders: DriveWatchFolder[]
  budgetMs?: number
  perRun?: number
}): Promise<DriveReadCounts> {
  const counts: DriveReadCounts = { read: 0, failed: 0, skipped: 0 }
  const config = extractionConfig()
  if (config.engine === "anthropic") {
    // The bring-your-own-key engine reads with a credential that belongs to
    // the workspace and is only decryptable inside its own session.
    console.info(
      "Drive read skipped: the anthropic engine reads with each workspace's own key."
    )
    return counts
  }

  const deadline = Date.now() + budgetMs
  for (const folder of folders) {
    if (folder.registeredAt === null) continue
    if (Date.now() >= deadline) break
    const { files } = await getDriveFilesForWorkspace(
      folder.userId,
      "new",
      perRun
    )
    for (const row of files) {
      if (Date.now() >= deadline) {
        counts.skipped += 1
        continue
      }
      // The one place a file is given up on, so it is also the one place
      // the count moves. Django being unreachable leaves the row `new` and
      // the next tick reads it again.
      const fail = async (reason: string) => {
        counts.failed += 1
        try {
          await failDriveExtraction({
            userId: folder.userId,
            driveFileId: row.driveFileId,
            reason: reason.slice(0, 255),
          })
        } catch {}
      }
      try {
        const fetched = await fetchDriveFileForExtraction(
          row.driveFileId,
          folder.folderId
        )
        if ("error" in fetched) {
          await fail(fetched.error)
          continue
        }
        const file =
          fetched.kind === "image"
            ? await prepareExtractionImage(fetched)
            : fetched
        if ("error" in file) {
          await fail(file.error)
          continue
        }
        // The categories the prompt offers, the currency the document is
        // normalized against, and — the reason it runs before the model does —
        // whether this file has already become an invoice.
        const probe = await probeInvoiceLinesForWorkspace(folder.userId, {
          supplier: "unknown",
          lines: [],
          driveFileId: row.driveFileId,
        })
        if (probe.driveFileKnown) {
          await fail("Already imported")
          continue
        }
        // The free read first, as the attended path does: a standard Baldor
        // invoice ends here and the model is only paid for what the template
        // cannot read.
        const free = await readWithoutAi(fetched)
        if ("error" in free) {
          await fail(free.error)
          continue
        }
        const reads: DocumentRead[] | { error: string } = free.extraction
          ? [
              {
                part: WHOLE_FILE_PART,
                extraction: free.extraction,
                model: "text-layer",
                escalated: false,
              },
            ]
          : await readDocumentParts(
              file,
              free,
              probe.categories.map((category) => category.name),
              {
                engine: config.engine,
                model: config.model,
                apiKey: null,
                budget: invoiceAiBudget(
                  file.kind === "image" ? 1 : free.pageSizes.length,
                  folder.userId
                ),
              }
            )
        if (!Array.isArray(reads)) {
          await fail(reads.error)
          continue
        }

        // A bundle is worth storing even when one receipt in it is unreadable;
        // only a file where nothing could be read is a failure, and then it is
        // told the first reason.
        const parts: StoredPart[] = []
        let firstError: string | null = null
        for (const read of reads) {
          const normalized = normalizeDocumentRead(read, probe.currencyCode)
          if ("error" in normalized) {
            firstError ??= normalized.error
            continue
          }
          parts.push({
            part: read.part.part,
            document: {
              ...normalized,
              fileName: row.name,
              driveWebViewLink: row.webViewLink,
              extractionModel: read.model,
              escalated: read.escalated,
              extraction: read.extraction,
            },
            pageStart: read.part.pages?.start ?? null,
            pageEnd: read.part.pages?.end ?? null,
            region: read.part.region,
            model: read.model,
            escalated: read.escalated,
          })
        }
        if (parts.length === 0) {
          await fail(firstError ?? "Couldn't read that receipt.")
          continue
        }
        await saveDriveExtraction({
          userId: folder.userId,
          driveFileId: row.driveFileId,
          parts,
        })
        counts.read += parts.length
      } catch (cause) {
        if (cause instanceof InvoiceAiBudgetError) {
          // Keep the file new: an upgrade, the next month, or backend
          // recovery can resume it. No import or stored invoice is lost.
          counts.skipped += 1
          continue
        }
        await fail(readError(cause))
      }
    }
  }

  console.info(
    `Drive read: ${counts.read} read, ${counts.failed} failed, ${counts.skipped} left for the next run`
  )
  return counts
}

/** One part as `drive-extractions/` takes it: the normalized document, and
 * which pages or region of the file it was read from. */
type StoredPart = {
  part: number
  document: StoredDriveDocument
  pageStart: number | null
  pageEnd: number | null
  region: { x0: number; y0: number; x1: number; y1: number } | null
  model: string
  escalated: boolean
}
