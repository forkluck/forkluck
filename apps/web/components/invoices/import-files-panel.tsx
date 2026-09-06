"use client"

import * as React from "react"
import Link from "next/link"
import { CloudUpload, RotateCcw } from "lucide-react"

import { AiKeyDialog } from "@/components/invoices/ai-key-dialog"
import { GoogleDrivePickerButton } from "@/components/invoices/google-drive-picker"
import type { QueueItem } from "@/components/invoices/receipt-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { GoogleDriveConfig, PickedDriveFile } from "@/lib/google-drive"
import { cn } from "@/lib/utils"

/**
 * Where receipts come from: the dropzone, and the files this batch is
 * reading. A connected Drive folder is read on its own and reviewed from the
 * inbox, so it has no place here. Presentation only — every piece of state and
 * every handler belongs to the dialog body, which is where the job pump lives.
 */
export function ImportFilesPanel({
  config,
  driveConnectHref,
  dragging,
  onDragging,
  onUploads,
  onDriveFiles,
  onError,
  reconnectNeeded,
  onReconnect,
  queue,
  busyCount,
  onRetryQueued,
  onSkipQueued,
  inboxNotice,
  error,
  busy,
  byok,
  aiKeyConfigured,
  aiKeyHint,
  reviewCount,
  onReview,
  onCancel,
}: {
  config: GoogleDriveConfig | null
  driveConnectHref: string | null
  dragging: boolean
  onDragging: (dragging: boolean) => void
  onUploads: (files: FileList | File[] | null) => void
  onDriveFiles: (files: PickedDriveFile[]) => void
  onError: (message: string) => void
  reconnectNeeded: boolean
  onReconnect: () => void
  queue: QueueItem[]
  busyCount: number
  onRetryQueued: (item: QueueItem) => void
  onSkipQueued: (item: QueueItem) => void
  inboxNotice: string | null
  error: string | null
  /** An import is in flight, so the pickers must not add to the batch. */
  busy: boolean
  byok: boolean
  aiKeyConfigured: boolean
  aiKeyHint: string | null
  /** Receipts waiting in the reviewer; 0 hides the way back to it. */
  reviewCount: number
  onReview: () => void
  onCancel: () => void
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
      <div
        className={cn(
          "flex flex-col items-center gap-2 rounded-xl border-[1.5px] border-dashed border-border px-6 py-7 text-center",
          dragging && "border-line-strong bg-fill-soft"
        )}
        onDragOver={(event) => {
          event.preventDefault()
          onDragging(true)
        }}
        onDragLeave={() => onDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          onDragging(false)
          onUploads(event.dataTransfer.files)
        }}
      >
        <CloudUpload
          className="size-5 text-muted-foreground"
          strokeWidth={1.6}
          aria-hidden="true"
        />
        <p className="text-md leading-5 font-medium text-foreground">
          Drop invoice PDFs or receipt photos here
        </p>
        <p className="text-sm text-muted-foreground">
          PDF up to 5 MB, photo up to 8 MB
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <GoogleDrivePickerButton
            config={config}
            disabled={busy}
            onFiles={onDriveFiles}
            onError={onError}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp"
            multiple
            className="hidden"
            onChange={(event) => {
              onUploads(event.target.files)
              event.target.value = ""
            }}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
          >
            Choose files
          </Button>
        </div>
        {config ? (
          <p className="mt-1 text-xs leading-[1.55] text-faint">
            In Drive, open the month folder and select the PDFs inside it.
            Folders themselves can&apos;t be imported.
          </p>
        ) : null}
        {driveConnectHref ? (
          <p className="mt-1 text-xs leading-[1.55] text-faint">
            Receipts in a Google Drive folder?{" "}
            <Link href={driveConnectHref} className="underline">
              Connect the folder
            </Link>{" "}
            once and every receipt dropped in it is read for you.
          </p>
        ) : null}
      </div>

      {reconnectNeeded ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning-border bg-warning-fill px-3.5 py-2.5 text-xs text-warning-foreground">
          Google Drive access expired mid-import.
          <Button type="button" size="sm" onClick={onReconnect}>
            Reconnect Google Drive
          </Button>
        </div>
      ) : null}

      {queue.length > 0 ? (
        <div className="rounded-xl border border-border">
          <p className="border-b border-border px-3.5 py-2.5 text-xs font-medium text-muted-foreground">
            {busyCount > 0
              ? `Reading ${busyCount} of ${queue.length} file${queue.length === 1 ? "" : "s"}…`
              : `${queue.length} file${queue.length === 1 ? "" : "s"}`}
          </p>
          <ul className="max-h-40 overflow-auto">
            {queue.map((item) => (
              <li
                key={item.key}
                className="flex items-center gap-2 border-b border-muted px-3.5 py-2 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate text-base">
                  {item.fileName}
                </span>
                {item.status === "error" ? (
                  <>
                    <span className="truncate text-xs text-destructive">
                      {item.error}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => onRetryQueued(item)}
                    >
                      <RotateCcw strokeWidth={1.8} aria-hidden="true" />
                      Retry
                    </Button>
                    {item.driveFetch ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => onSkipQueued(item)}
                      >
                        Skip this file in future
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <Badge
                    variant={item.status === "done" ? "success" : "default"}
                    size="row"
                  >
                    {item.status === "done"
                      ? "Parsed"
                      : item.status === "loading"
                        ? "Reading…"
                        : "Queued"}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {inboxNotice ? (
        <p className="text-xs text-muted-foreground">{inboxNotice}</p>
      ) : null}

      {error ? (
        <p className="text-base text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        {/* Keeps the optional AI fallback reachable. Nothing to offer when
            Forkluck's own AI does the reading. */}
        {byok ? (
          <AiKeyDialog
            configured={aiKeyConfigured}
            hint={aiKeyHint}
            trigger={
              <Button type="button" variant="ghost" className="mr-auto" />
            }
          />
        ) : null}
        <Button
          type="button"
          variant="outline"
          className={byok ? undefined : "mr-auto"}
          onClick={onCancel}
        >
          Cancel
        </Button>
        {reviewCount > 0 ? (
          <Button type="button" onClick={onReview}>
            Review {reviewCount} receipt{reviewCount === 1 ? "" : "s"}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
