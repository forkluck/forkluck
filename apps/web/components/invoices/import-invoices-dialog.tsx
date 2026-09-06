"use client"

import * as React from "react"

import {
  importInvoices,
  deleteInvoice,
  loadReadyDriveDocuments,
  skipDriveFiles,
  type ImportInvoicesReceipt,
} from "@/app/(app)/invoices/actions"
import { listSuppliers } from "@/app/(app)/settings/actions"
import { AiKeyDialog } from "@/components/invoices/ai-key-dialog"
import { DocumentViewer } from "@/components/invoices/document-viewer"
import { DuplicateCompare } from "@/components/invoices/duplicate-compare"
import { ImportFilesPanel } from "@/components/invoices/import-files-panel"
import { ReceiptPager } from "@/components/invoices/receipt-pager"
import { ReceiptReview } from "@/components/invoices/receipt-review"
import {
  HEIC_MESSAGE,
  MAX_PDF_BYTES,
  Notice,
  acceptedUploadType,
  invoiceState,
  maxUploadBytes,
  receiptBlocker,
  receiptPayload,
  type InvoiceDocument,
  type InvoiceState,
  type LineState,
  type QueueItem,
  type UploadType,
} from "@/components/invoices/receipt-state"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { IngredientOption } from "@/components/ingredients/types"
import { readAsBase64 } from "@/lib/client-file"
import {
  parseMoneyToCents,
  type InvoiceParseResult,
} from "@/lib/invoice-import"
import { applyLineChange } from "@/lib/invoice-propagation"
import { useRefresh } from "@/hooks/use-refresh"
import {
  GoogleDriveError,
  downloadDriveFile,
  getDriveAccessToken,
  invalidateDriveToken,
  type GoogleDriveConfig,
  type PickedDriveFile,
} from "@/lib/google-drive"

const CONCURRENCY = 3

/** Which of the dialog's three screens is up. */
type ImportScreen = "files" | "reading" | "review"

/** Either the bytes, or — for a file in the connected folder — its id alone,
 * which the server resolves against that folder before fetching it. */
type ParseRequest =
  | {
      base64: string
      mediaType: UploadType
      fileName: string
      driveFileId: string | null
      driveWebViewLink: string | null
    }
  | { driveFileId: string; fileName: string; driveWebViewLink: string | null }

/** One file, one or more documents: a scan or a photo can hold a pile of
 * receipts, and each one comes back as its own result. */
async function parseInvoiceFile(
  input: ParseRequest
): Promise<{ documents: InvoiceParseResult[] } | { error: string }> {
  try {
    const response = await fetch("/api/invoices/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    return (await response.json()) as
      { documents: InvoiceParseResult[] } | { error: string }
  } catch {
    // A proxy timeout or interrupted stream is not a JSON parsing problem
    // the merchant can fix. The receipt has not been imported at this point.
    return {
      error:
        "The connection ended before the receipt was ready. Nothing was imported. Please retry.",
    }
  }
}

/** Every receipt imported in this sitting, as one total. */
function sumReceipts(receipts: ImportInvoicesReceipt[]): ImportInvoicesReceipt {
  return receipts.reduce<ImportInvoicesReceipt>(
    (total, receipt) => ({
      batchId: receipt.batchId ?? total.batchId,
      invoices: total.invoices + receipt.invoices,
      duplicates: [...total.duplicates, ...receipt.duplicates],
      lines: total.lines + receipt.lines,
      priceUpdated: total.priceUpdated + receipt.priceUpdated,
      created: total.created + receipt.created,
      updated: total.updated + receipt.updated,
      ignored: total.ignored + receipt.ignored,
      expenseOnly: total.expenseOnly + receipt.expenseOnly,
    }),
    {
      batchId: null,
      invoices: 0,
      duplicates: [],
      lines: 0,
      priceUpdated: 0,
      created: 0,
      updated: 0,
      ignored: 0,
      expenseOnly: 0,
    }
  )
}

function ReceiptView({
  receipt,
  onDone,
}: {
  receipt: ImportInvoicesReceipt
  onDone: () => void
}) {
  return (
    <div className="rounded-xl border border-border p-5">
      <Badge variant="success">Import complete</Badge>
      <h3 className="mt-3 text-xl leading-none font-semibold tracking-[-0.01em]">
        {receipt.invoices} invoice{receipt.invoices === 1 ? "" : "s"} saved
      </h3>
      <p className="mt-2 text-base leading-[1.55] text-muted-foreground">
        {receipt.priceUpdated > 0
          ? "Price updates are in the ingredients Import history and can be undone there. "
          : ""}
        {receipt.duplicates.length > 0
          ? `Skipped as already imported: ${receipt.duplicates.join(", ")}.`
          : ""}
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-3 border-y border-muted py-3 text-center sm:grid-cols-4">
        {[
          ["Lines", receipt.lines],
          ["Price updates", receipt.priceUpdated],
          ["Expense only", receipt.expenseOnly],
          ["Ignored", receipt.ignored],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs font-medium text-muted-foreground">
              {label}
            </dt>
            <dd className="tabular mt-1.5 text-xl leading-none font-semibold">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <Button type="button" className="mt-4" onClick={onDone}>
        Done
      </Button>
    </div>
  )
}

function ImportBody({
  config,
  driveConnectHref,
  ingredients,
  onIngredientCreated,
  initialFiles,
  inbox,
  byok,
  aiKeyConfigured,
  aiKeyHint,
  onDone,
  onScreenChange,
}: {
  config: GoogleDriveConfig | null
  driveConnectHref: string | null
  ingredients: IngredientOption[]
  /** A catalog ingredient adopted from a resolve drawer; the screen's list
   * learns it so every line can pick it. */
  onIngredientCreated?: (ingredient: IngredientOption) => void
  initialFiles: File[] | null
  /** Opened on the receipts the watcher has already read, rather than empty. */
  inbox: boolean
  byok: boolean
  aiKeyConfigured: boolean
  aiKeyHint: string | null
  onDone: () => void
  /** Which screen is up, so the dialog around this body can size itself. */
  onScreenChange: (screen: ImportScreen) => void
}) {
  // Sent with the import so Django can refuse it if a currency conversion
  // landed while these amounts were on screen.
  const { currencyCode } = useBusinessSettings()
  const [queue, setQueue] = React.useState<QueueItem[]>([])
  const [invoices, setInvoices] = React.useState<InvoiceState[]>([])
  // Receipts pile up: import is per file now, and the totals are shown once
  // the last one has left the list.
  const [receipts, setReceipts] = React.useState<ImportInvoicesReceipt[]>([])
  const [index, setIndex] = React.useState(0)
  // The line whose box the document pane draws, remembered with the
  // receipt it belongs to so paging to the next one starts clean.
  const [selected, setSelected] = React.useState<{
    receiptKey: string
    lineKey: string
  } | null>(null)
  /** The reviewer is the screen; Files is somewhere the merchant goes back to. */
  const [showFiles, setShowFiles] = React.useState(false)
  /** The inbox is still being opened: nothing to show yet, but not empty. */
  const [seeding, setSeeding] = React.useState(inbox)
  const [error, setError] = React.useState<string | null>(null)
  const [reconnectNeeded, setReconnectNeeded] = React.useState(false)
  const [importingKey, setImportingKey] = React.useState<string | null>(null)
  /** The receipt Django refused as an exact duplicate, kept where it was. */
  const [skippedKey, setSkippedKey] = React.useState<string | null>(null)
  // Stored-file keys by receipt, so a retried import reuses the upload.
  const storedKeysRef = React.useRef(new Map<string, string>())
  const [dragging, setDragging] = React.useState(false)
  const pendingRef = React.useRef<Array<() => Promise<void>>>([])
  const runningRef = React.useRef(0)
  // Keys with a job queued or running, so re-enqueues (Retry double-click,
  // the reconnect sweep) can't push duplicate jobs for the same item.
  const activeKeysRef = React.useRef<Set<string>>(new Set())
  const keyRef = React.useRef(0)
  const [supplierNames, setSupplierNames] = React.useState<string[]>([])
  // What the inbox could not fit or could not open, once it has been read.
  const [inboxNotice, setInboxNotice] = React.useState<string | null>(null)

  // The names the workspace already buys under, so a corrected supplier lands
  // on the supplier that exists instead of creating a near-duplicate.
  React.useEffect(() => {
    let cancelled = false
    void listSuppliers()
      .then((rows) => {
        if (!cancelled) setSupplierNames(rows.map((row) => row.name))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  /** The document for one invoice block. A block carries the key of the queue
   * row it was read from, so the bytes (or the Drive id) come straight off it
   * — several blocks of one bundle all read the same file. */
  const documentSourceFor = (fileKey: string): InvoiceDocument | null => {
    const item = queue.find((row) => row.key === fileKey)
    if (!item || !item.mediaType) return null
    if (!item.file && !(item.driveFetch && item.driveFileId)) return null
    return {
      file: item.file,
      driveFileId: item.file ? null : item.driveFileId,
      // Nothing is stored yet while the receipt is being reviewed; the bytes
      // in hand are what the pane draws.
      documentKey: null,
      mediaType: item.mediaType,
      fileName: item.fileName,
    }
  }

  const patchQueue = (key: string, patch: Partial<QueueItem>) => {
    setQueue((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item))
    )
  }

  function pump() {
    while (runningRef.current < CONCURRENCY && pendingRef.current.length > 0) {
      const job = pendingRef.current.shift()
      if (!job) break
      runningRef.current += 1
      void job().finally(() => {
        runningRef.current -= 1
        pump()
      })
    }
  }

  function processItem(item: QueueItem) {
    if (activeKeysRef.current.has(item.key)) return
    setError(null)
    activeKeysRef.current.add(item.key)
    // Mark the item queued synchronously so its Retry button disappears
    // before the job actually starts.
    patchQueue(item.key, { status: "queued", error: null })
    pendingRef.current.push(async () => {
      patchQueue(item.key, { status: "loading" })
      try {
        let request: ParseRequest
        if (item.driveFetch) {
          if (!item.driveFileId) throw new Error("File is gone — add it again.")
          request = {
            driveFileId: item.driveFileId,
            fileName: item.fileName,
            driveWebViewLink: item.driveWebViewLink,
          }
        } else {
          let base64: string
          if (item.source === "upload") {
            if (!item.file) throw new Error("File is gone — add it again.")
            base64 = await readAsBase64(item.file)
          } else {
            if (!config) throw new Error("Google Drive isn't configured.")
            const download = await downloadDriveFile(
              item.driveFileId ?? "",
              config.clientId
            )
            if (download.bytes > MAX_PDF_BYTES) {
              throw new Error("This PDF is larger than 5 MB.")
            }
            base64 = download.base64
            // Keep the bytes: the review pane shows this document from an
            // object URL instead of downloading it again.
            patchQueue(item.key, {
              file: new File([download.blob], item.fileName, {
                type: item.mediaType ?? "application/pdf",
              }),
            })
          }
          request = {
            base64,
            mediaType: item.mediaType ?? "application/pdf",
            fileName: item.fileName,
            driveFileId: item.driveFileId,
            driveWebViewLink: item.driveWebViewLink,
          }
        }
        const result = await parseInvoiceFile(request)
        if ("error" in result) throw new Error(result.error)
        patchQueue(item.key, {
          status: "done",
          partCount: result.documents.length,
        })
        // A retry replaces this file's blocks rather than doubling them.
        setInvoices((current) => [
          ...current.filter((row) => row.fileKey !== item.key),
          ...result.documents.map((document) =>
            invoiceState(item.key, document)
          ),
        ])
      } catch (cause) {
        if (
          cause instanceof GoogleDriveError &&
          cause.code === "unauthorized"
        ) {
          setReconnectNeeded(true)
        }
        patchQueue(item.key, {
          status: "error",
          error:
            cause instanceof Error
              ? cause.message
              : "Something went wrong — retry.",
        })
      } finally {
        activeKeysRef.current.delete(item.key)
      }
    })
    pump()
  }

  const addItems = (
    items: Array<Omit<QueueItem, "key" | "status" | "error">>
  ) => {
    const queued = items.map((item) => {
      keyRef.current += 1
      return {
        ...item,
        key: `file-${keyRef.current}`,
        status: "queued" as const,
        error: null,
      }
    })
    setQueue((current) => [...current, ...queued])
    for (const item of queued) processItem(item)
  }

  const addUploads = (files: FileList | File[] | null) => {
    if (!files) return
    setError(null)
    const accepted: Array<Omit<QueueItem, "key" | "status" | "error">> = []
    for (const file of Array.from(files)) {
      const mediaType = acceptedUploadType(file)
      if (mediaType === "heic") {
        setError(HEIC_MESSAGE)
        continue
      }
      if (!mediaType) {
        setError(`${file.name} isn't a PDF or a photo.`)
        continue
      }
      if (file.size > maxUploadBytes(mediaType)) {
        setError(
          mediaType === "application/pdf"
            ? `${file.name} is larger than 5 MB.`
            : `${file.name} is larger than 8 MB.`
        )
        continue
      }
      // Picking a failed file again is a retry of its existing queue entry.
      // Active and completed files still must not be extracted twice.
      const existing = queue.find(
        (item) => item.fileName === file.name && item.file?.size === file.size
      )
      if (existing?.status === "error") {
        processItem(existing)
        continue
      }
      if (
        existing ||
        accepted.some(
          (item) => item.fileName === file.name && item.file?.size === file.size
        )
      ) {
        continue
      }
      accepted.push({
        fileName: file.name,
        source: "upload",
        driveFileId: null,
        driveWebViewLink: null,
        driveFetch: false,
        mediaType,
        file,
      })
    }
    if (accepted.length > 0) addItems(accepted)
  }

  // Files dropped on the page open this dialog already loaded. The body is
  // remounted per open, so this runs once; the queueing is deferred a tick
  // because an effect body must not push state synchronously.
  React.useEffect(() => {
    if (!initialFiles || initialFiles.length === 0) return
    const timer = window.setTimeout(() => addUploads(initialFiles), 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFiles])

  const addDriveFiles = (files: PickedDriveFile[]) => {
    setError(null)
    const accepted: Array<Omit<QueueItem, "key" | "status" | "error">> = []
    for (const file of files) {
      const mediaType = acceptedUploadType({
        name: file.name,
        type: file.mimeType ?? "",
      })
      if (mediaType === "heic") {
        setError(HEIC_MESSAGE)
        continue
      }
      if (!mediaType) {
        setError(`${file.name} isn't a PDF or a photo.`)
        continue
      }
      if (
        file.sizeBytes !== null &&
        file.sizeBytes > maxUploadBytes(mediaType)
      ) {
        setError(
          mediaType === "application/pdf"
            ? `${file.name} is larger than 5 MB.`
            : `${file.name} is larger than 8 MB.`
        )
        continue
      }
      const existing = queue.find((item) => item.driveFileId === file.id)
      if (existing?.status === "error") {
        processItem(existing)
        continue
      }
      if (existing || accepted.some((item) => item.driveFileId === file.id)) {
        continue
      }
      accepted.push({
        fileName: file.name,
        source: "drive",
        driveFileId: file.id,
        driveWebViewLink: file.url,
        driveFetch: false,
        mediaType,
        file: null,
      })
    }
    if (accepted.length > 0) addItems(accepted)
  }

  /**
   * The inbox: the receipts the watcher has already read, seeded as review
   * blocks the rest of this dialog treats exactly like a file it just parsed.
   */
  const seedInbox = async () => {
    const result = await loadReadyDriveDocuments()
    if ("error" in result) {
      setError(result.error)
      setSeeding(false)
      return
    }
    // Several documents can come out of one file, and they share its queue
    // row: one file, one set of bytes, however many receipts were in it.
    const files = new Map<
      string,
      { item: QueueItem; results: InvoiceParseResult[] }
    >()
    for (const document of result.documents) {
      const fileKey = document.result.driveFileId ?? document.result.fileName
      let entry = files.get(fileKey)
      if (!entry) {
        keyRef.current += 1
        const mediaType = acceptedUploadType({
          name: document.result.fileName,
          type: document.mimeType,
        })
        entry = {
          item: {
            key: `file-${keyRef.current}`,
            fileName: document.result.fileName,
            source: "drive",
            status: "done",
            error: null,
            driveFileId: document.result.driveFileId,
            driveWebViewLink: document.result.driveWebViewLink,
            // The bytes never came here: the document pane streams them from
            // the folder, as for a file this dialog asked the server to parse.
            driveFetch: true,
            mediaType: mediaType === "heic" ? null : mediaType,
            file: null,
          },
          results: [],
        }
        files.set(fileKey, entry)
      }
      entry.results.push(document.result)
    }
    const seeded = [...files.values()].map((entry) => ({
      ...entry,
      // Parts already imported or skipped are not offered again, so the file's
      // length is the highest part still here, not how many are on screen.
      item: {
        ...entry.item,
        partCount: Math.max(
          ...entry.results.map((parsed) => parsed.part.part + 1)
        ),
      },
    }))
    setQueue((current) => [...current, ...seeded.map((entry) => entry.item)])
    setInvoices((current) => [
      ...current,
      ...seeded.flatMap((entry) =>
        entry.results.map((parsed) => invoiceState(entry.item.key, parsed))
      ),
    ])
    const notices = [
      // Documents against documents: `readyCount` is every receipt waiting,
      // and a bundle of them can arrive in one file.
      result.readyCount > result.documents.length
        ? `Showing ${result.documents.length} of ${result.readyCount} — import these and open the inbox again.`
        : null,
      result.unreadable > 0
        ? `${result.unreadable} stored read${result.unreadable === 1 ? "" : "s"} couldn't be opened.`
        : null,
    ].filter(Boolean)
    setInboxNotice(notices.length > 0 ? notices.join(" ") : null)
    setSeeding(false)
  }

  // Opened from "Review": these documents are already read, so the dialog
  // fills itself. Deferred a tick because an effect must not push state
  // synchronously; the body is remounted per open, so this runs once.
  React.useEffect(() => {
    if (!inbox) return
    const timer = window.setTimeout(() => void seedInbox(), 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Stop offering this — the skip list is what keeps a linen bill out of
   * every later listing. `part` null is the whole file; a number is one
   * document out of a bundle, leaving the rest of the file on offer. */
  const skipDriveFile = async (
    driveFileId: string,
    fileName: string,
    reason: string,
    part: number | null = null
  ) => {
    const result = await skipDriveFiles({
      files: [{ driveFileId, fileName, reason, part }],
    })
    if ("error" in result) {
      setError(result.error)
      return false
    }
    return true
  }

  const skipQueued = async (item: QueueItem) => {
    if (!item.driveFileId) return
    if (await skipDriveFile(item.driveFileId, item.fileName, "")) {
      setQueue((current) => current.filter((row) => row.key !== item.key))
    }
  }

  const reconnect = async () => {
    if (!config) return
    try {
      invalidateDriveToken()
      await getDriveAccessToken(config.clientId)
      setReconnectNeeded(false)
      for (const item of queue) {
        if (item.source === "drive" && item.status === "error") {
          processItem(item)
        }
      }
    } catch (cause) {
      setError(
        cause instanceof GoogleDriveError
          ? cause.message
          : "Couldn't reconnect to Google Drive."
      )
    }
  }

  const changeInvoice = (key: string, patch: Partial<InvoiceState>) => {
    setInvoices((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row))
    )
  }

  const changeLine = (
    key: string,
    lineKey: string,
    patch: Partial<LineState>
  ) => {
    setInvoices((current) => applyLineChange(current, key, lineKey, patch))
  }

  /** One block out of the list. The file behind it goes too, but only once
   * its last block has left: a bundle's other receipts still need the bytes. */
  const removeInvoice = (key: string) => {
    const going = invoices.find((row) => row.key === key)
    setInvoices((current) => current.filter((row) => row.key !== key))
    if (
      going &&
      !invoices.some((row) => row.key !== key && row.fileKey === going.fileKey)
    ) {
      setQueue((current) =>
        current.filter((item) => item.key !== going.fileKey)
      )
    }
    setSkippedKey((current) => (current === key ? null : current))
  }

  /** Out of this batch. A document from the connected folder is also taken off
   * the folder's offer list, so the next poll doesn't hand it back. */
  const skipInvoice = async (invoice: InvoiceState) => {
    const driveFileId = invoice.result.driveFileId
    if (!driveFileId) {
      removeInvoice(invoice.key)
      return
    }
    const skipped = await skipDriveFile(
      driveFileId,
      invoice.result.fileName,
      "",
      invoice.result.part.part
    )
    if (skipped) removeInvoice(invoice.key)
  }

  /** The whole file, however many receipts were read out of it. */
  const neverOfferFile = async (invoice: InvoiceState) => {
    const driveFileId = invoice.result.driveFileId
    if (!driveFileId) return
    if (!(await skipDriveFile(driveFileId, invoice.result.fileName, ""))) return
    setInvoices((current) =>
      current.filter((row) => row.fileKey !== invoice.fileKey)
    )
    setQueue((current) =>
      current.filter((item) => item.key !== invoice.fileKey)
    )
    setSkippedKey((current) => (current === invoice.key ? null : current))
  }

  const busyCount = queue.filter(
    (item) => item.status === "queued" || item.status === "loading"
  ).length

  /** One receipt, imported on its own. Returns whether it left the list. */
  /**
   * Keep the bytes the browser holds, so the invoice page can show the
   * document later: an upload or a Picker download lives nowhere else. Null
   * when there is nothing to store; a store that fails throws.
   */
  const storeUploadedFile = async (
    invoice: InvoiceState
  ): Promise<string | null> => {
    const item = queue.find((row) => row.key === invoice.fileKey)
    if (!item?.file || invoice.result.driveFileId) return null
    // An import Django refused (a duplicate, say) comes back through here
    // once the merchant has changed something; the file is already kept.
    const kept = storedKeysRef.current.get(invoice.key)
    if (kept) return kept
    const response = await fetch("/api/invoices/document", {
      method: "POST",
      body: item.file,
      headers: {
        "x-file-name": item.fileName,
        "content-type": item.mediaType ?? "application/pdf",
      },
    })
    if (!response.ok) throw new Error("store failed")
    const stored = (await response.json()) as { key?: string }
    if (!stored.key) throw new Error("store failed")
    storedKeysRef.current.set(invoice.key, stored.key)
    return stored.key
  }

  const importOne = async (invoice: InvoiceState): Promise<boolean> => {
    setError(null)
    setSkippedKey(null)
    const blocker = receiptBlocker(invoice)
    if (blocker) {
      setError(blocker)
      return false
    }
    setImportingKey(invoice.key)
    try {
      let documentKey: string | null = null
      try {
        documentKey = await storeUploadedFile(invoice)
      } catch {
        setError("Couldn't keep the file — try again.")
        return false
      }
      const result = await importInvoices({
        invoices: [receiptPayload(invoice, ingredients, documentKey)],
        reviewedCurrencyCode: currencyCode,
      })
      if ("error" in result) {
        setError(result.error)
        return false
      }
      if (result.duplicates.includes(invoice.result.fileName)) {
        // Django refused it as identical to an invoice already saved: leave it
        // on screen with the reason rather than pretending it went in.
        setSkippedKey(invoice.key)
        return false
      }
      setReceipts((current) => [...current, result])
      removeInvoice(invoice.key)
      return true
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "Couldn't import that invoice — try again."
      )
      return false
    } finally {
      setImportingKey(null)
    }
  }

  /** The already-imported invoice goes, this one takes its place. */
  const replaceInvoice = async (invoice: InvoiceState, existingId: string) => {
    setError(null)
    const deleted = await deleteInvoice(existingId)
    if ("error" in deleted) {
      setError(deleted.error)
      return
    }
    const next = { ...invoice, includeDuplicate: true }
    changeInvoice(invoice.key, { includeDuplicate: true })
    if (!(await importOne(next))) {
      setError(
        "The old invoice was deleted but this one didn't import — press Import to try again."
      )
    }
  }

  // The list shrinks under the cursor as receipts leave, so the position is
  // clamped where it is read rather than chased with an effect.
  const position =
    invoices.length === 0 ? 0 : Math.min(index, invoices.length - 1)
  const current = invoices[position] ?? null

  // Arrow-key paging lives in the pager, next to the buttons it stands in for.

  // What is on screen decides how big the dialog around it is: files are
  // chosen in a modest one, a receipt is reviewed in the full one, and the
  // wait between the two is spent in the full one so nothing jumps twice.
  const reading = seeding || (invoices.length === 0 && busyCount > 0)
  const screen: ImportScreen =
    showFiles || (!current && !reading)
      ? "files"
      : !current
        ? "reading"
        : "review"
  React.useEffect(() => {
    onScreenChange(screen)
  }, [screen, onScreenChange])

  if (invoices.length === 0 && receipts.length > 0) {
    return <ReceiptView receipt={sumReceipts(receipts)} onDone={onDone} />
  }

  if (screen === "reading") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <Spinner size="md" label="" />
        <p role="status" className="text-md text-muted-foreground">
          {seeding
            ? "Opening the inbox…"
            : `Reading ${busyCount} of ${queue.length} file${queue.length === 1 ? "" : "s"}…`}
        </p>
        {!seeding ? (
          <p className="text-xs text-muted-foreground">
            Scanned receipts can take a few minutes to read and check.
          </p>
        ) : null}
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    )
  }

  if (screen === "files") {
    return (
      <>
        {/* The long copy belongs where files are chosen; the reviewer's own
            screen has the receipt to look at instead. */}
        <DialogDescription>
          Add supplier invoice PDFs and receipt photos from Google Drive or your
          computer. Standard invoices are read for free on this server; anything
          it can&apos;t read automatically is read by{" "}
          {byok ? "your own AI key" : "Forkluck's AI"}. You review every receipt
          before anything is saved: ingredient lines update your supplier
          prices, everything else is tracked as spend.
        </DialogDescription>
        <ImportFilesPanel
          config={config}
          driveConnectHref={driveConnectHref}
          dragging={dragging}
          onDragging={setDragging}
          onUploads={(files) => {
            setShowFiles(false)
            addUploads(files)
          }}
          onDriveFiles={addDriveFiles}
          onError={setError}
          reconnectNeeded={reconnectNeeded}
          onReconnect={() => void reconnect()}
          queue={queue}
          busyCount={busyCount}
          onRetryQueued={processItem}
          onSkipQueued={(item) => void skipQueued(item)}
          inboxNotice={inboxNotice}
          error={error}
          busy={importingKey !== null}
          byok={byok}
          aiKeyConfigured={aiKeyConfigured}
          aiKeyHint={aiKeyHint}
          reviewCount={invoices.length}
          onReview={() => setShowFiles(false)}
          onCancel={onDone}
        />
      </>
    )
  }

  const documentSource = documentSourceFor(current.fileKey)
  const part = current.result.part
  const partCount =
    queue.find((row) => row.key === current.fileKey)?.partCount ?? 1
  // A photo receipt's boxes were read off its crop; the pane draws the whole
  // photo, so they are put back where they sit in it.
  const region = part.region
  const documentBoxes = current.lines.flatMap((line) =>
    line.box
      ? [
          {
            key: line.key,
            box: region
              ? {
                  page: line.box.page,
                  x0: region.x0 + line.box.x0 * (region.x1 - region.x0),
                  x1: region.x0 + line.box.x1 * (region.x1 - region.x0),
                  y0: region.y0 + line.box.y0 * (region.y1 - region.y0),
                  y1: region.y0 + line.box.y1 * (region.y1 - region.y0),
                }
              : line.box,
            label: line.entry.description,
          },
        ]
      : []
  )
  const selectedLineKey =
    selected && selected.receiptKey === current.key ? selected.lineKey : null
  const selectLine = (lineKey: string) =>
    setSelected({ receiptKey: current.key, lineKey })
  const existing = current.result.existingInvoice
  const showDuplicate =
    current.result.duplicate && !current.includeDuplicate && existing !== null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ReceiptPager
        title={current.supplierName || current.result.fileName}
        subtitle={`${current.invoiceNumber || current.result.fileName}${
          partCount > 1 ? ` · part ${part.part + 1} of ${partCount}` : ""
        }`}
        position={position + 1}
        count={invoices.length}
        filesCount={queue.length}
        readingLabel={
          busyCount > 0
            ? `Reading ${busyCount} of ${queue.length} file${queue.length === 1 ? "" : "s"}…`
            : null
        }
        busy={importingKey !== null}
        blocker={receiptBlocker(current)}
        importing={importingKey === current.key}
        isDriveFile={current.result.driveFileId !== null}
        onPrev={() => setIndex(Math.max(0, position - 1))}
        onNext={() => setIndex(Math.min(invoices.length - 1, position + 1))}
        onShowFiles={() => setShowFiles(true)}
        onImport={() => void importOne(current)}
        onSkip={() => void skipInvoice(current)}
        onNeverOffer={
          current.result.driveFileId ? () => void neverOfferFile(current) : null
        }
      >
        {/* Keeps the optional AI fallback reachable once the reviewer has
            taken the screen. Nothing to offer when Forkluck's AI reads. */}
        {byok ? (
          <AiKeyDialog
            configured={aiKeyConfigured}
            hint={aiKeyHint}
            trigger={<Button type="button" variant="ghost" />}
          />
        ) : null}
      </ReceiptPager>

      <div className="grid min-h-0 flex-1 gap-3 pt-3 md:grid-cols-[minmax(0,1fr)_640px]">
        <div className="min-h-0">
          {documentSource ? (
            <DocumentViewer
              source={documentSource}
              boxes={documentBoxes}
              pages={part.pages}
              region={region}
              selectedKey={selectedLineKey}
              onSelect={selectLine}
            />
          ) : null}
        </div>
        <div className="flex min-h-0 flex-col gap-3">
          {showDuplicate && existing ? (
            <DuplicateCompare
              current={{
                invoiceNumber: current.invoiceNumber,
                invoiceDate: current.invoiceDate,
                totalCents: parseMoneyToCents(current.total),
                lineCount: current.lines.length,
              }}
              existing={existing}
              currencyCode={currencyCode}
              busy={importingKey !== null}
              onKeepExisting={() => void skipInvoice(current)}
              onReplace={() => void replaceInvoice(current, existing.id)}
            />
          ) : null}
          {skippedKey === current.key ? (
            <Notice>Skipped: an identical invoice already exists</Notice>
          ) : null}
          {error ? (
            <p className="text-base text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <ReceiptReview
            invoice={current}
            ingredients={ingredients}
            onIngredientCreated={onIngredientCreated}
            supplierNames={supplierNames}
            onChange={changeInvoice}
            onChangeLine={changeLine}
            selectedKey={selectedLineKey}
            onSelectLine={selectLine}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * The upload flow behind New invoice > Upload PDF. Controlled, so
 * a drop anywhere on the page can open it with the files already queued.
 */
export function ImportInvoicesDialog({
  config,
  driveConnectHref,
  ingredients,
  onIngredientCreated,
  ingredientsStatus,
  onRetryIngredients,
  open,
  onOpenChange,
  initialFiles = null,
  inbox = false,
  byok,
  aiKeyConfigured,
  aiKeyHint,
}: {
  config: GoogleDriveConfig | null
  driveConnectHref: string | null
  ingredients: IngredientOption[]
  /** A catalog ingredient adopted from a resolve drawer; the screen's list
   * learns it so every line can pick it. */
  onIngredientCreated?: (ingredient: IngredientOption) => void
  /** The pantry list is fetched as the dialog opens. The box opens at its
   * size at once and holds a spinner until the list is in, rather than a
   * small box growing into it. */
  ingredientsStatus: "loading" | "ready" | "error"
  onRetryIngredients: () => void
  open: boolean
  onOpenChange: (open: boolean) => void
  initialFiles?: File[] | null
  /** Open on the receipts the Drive watcher has already read. */
  inbox?: boolean
  /** The deployment reads with the workspace's own Anthropic key rather than
   * Forkluck's AI. */
  byok: boolean
  aiKeyConfigured: boolean
  aiKeyHint: string | null
}) {
  const { refresh } = useRefresh()
  // A modest box while files are chosen, the full one once a receipt is being
  // read or reviewed. The first frame of an open already knows which: the
  // inbox and a page-level drop go straight to reading.
  const initialScreen: ImportScreen =
    inbox || (initialFiles?.length ?? 0) > 0 ? "reading" : "files"
  const [screen, setScreen] = React.useState<ImportScreen>(initialScreen)
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setScreen(initialScreen)
  }

  // Done closes the dialog itself, so the refresh cannot hang off the
  // Dialog's own onOpenChange: that one never fires for a close the body asks
  // for. Both ways out go through here instead.
  const close = () => {
    // Reading can consume AI pages even if nothing was saved.
    void refresh()
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true)
        else close()
      }}
    >
      <DialogContent
        size={screen === "files" ? "lg" : "full"}
        className={cn(
          "transition-[max-width] duration-300",
          screen !== "files" && "flex h-[calc(100dvh-2rem)] flex-col sm:p-7"
        )}
      >
        <DialogHeader>
          <DialogTitle>Import invoices</DialogTitle>
        </DialogHeader>
        {ingredientsStatus === "ready" ? (
          <ImportBody
            key={open ? "open" : "closed"}
            config={config}
            driveConnectHref={driveConnectHref}
            ingredients={ingredients}
            onIngredientCreated={onIngredientCreated}
            initialFiles={initialFiles}
            inbox={inbox}
            byok={byok}
            aiKeyConfigured={aiKeyConfigured}
            aiKeyHint={aiKeyHint}
            onDone={close}
            onScreenChange={setScreen}
          />
        ) : ingredientsStatus === "error" ? (
          <div className="space-y-4">
            <p className="text-md leading-5 text-muted-foreground">
              We couldn’t load the pantry list. Try again before continuing so
              imported lines can be matched safely.
            </p>
            <Button onClick={onRetryIngredients}>Try again</Button>
          </div>
        ) : (
          // About the files screen's height, so the swap to it is a swap and
          // not a growth; the full box is a column and the spinner fills it.
          <div className="grid min-h-96 flex-1 place-items-center">
            <Spinner label="Loading ingredients" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
