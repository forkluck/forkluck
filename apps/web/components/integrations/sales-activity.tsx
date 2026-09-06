"use client"

import * as React from "react"

import { retryPosSync, undoSalesImport } from "@/app/(app)/sales/actions"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toast"
import { useUndoImport } from "@/hooks/use-undo-import"
import type { PosSyncRun, SalesImportRow } from "@/lib/backend/types"
import { formatDateTime } from "@/lib/datetime"

const RUN_STATUS_LABELS: Record<PosSyncRun["status"], string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
}

/**
 * What the sales channels have done, in two lists: the batches that brought
 * lines in, each with the undo that removes them, and the sync passes behind
 * them, where a failed one can be started again. A list of rows on the table
 * rhythm — 14.5px name over a 12px sub-line.
 */
export function SalesActivity({
  imports,
  syncRuns,
}: {
  imports: SalesImportRow[]
  syncRuns: PosSyncRun[]
}) {
  const { timezone } = useBusinessSettings()
  const { armedId, pendingId, error, undo } = useUndoImport(undoSalesImport)
  const toast = useToast()
  const [retryingId, setRetryingId] = React.useState<string | null>(null)

  const retry = async (id: string) => {
    setRetryingId(id)
    const result = await retryPosSync(id)
    setRetryingId(null)
    if ("error" in result) {
      toast.add({
        title: "Couldn’t retry the sync",
        description: result.error,
        type: "error",
      })
      return
    }
    toast.add({
      title: "Sync started",
      description:
        "We’ll pull in your latest products and sales in the background. This can take a few minutes.",
    })
  }

  return (
    <div className="max-w-[760px]">
      <section aria-labelledby="sales-imports-heading">
        <h2
          id="sales-imports-heading"
          className="text-md font-semibold text-foreground"
        >
          Imports
        </h2>
        <p className="mt-1 text-base text-muted-foreground">
          Source files are kept for duplicate protection and undo. Only tracked
          products appear in Forkluck reporting.
        </p>
        {imports.length ? (
          <div className="mt-2.5 divide-y divide-muted overflow-hidden rounded-xl border border-border">
            {imports.map((item) => (
              <div
                key={item.id}
                className="grid gap-3 px-3.5 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-md">{item.fileName}</p>
                    {item.undoneAt ? (
                      <Badge variant="outline">Undone</Badge>
                    ) : (
                      <Badge>
                        {item.channel === "square" ? "Square" : "Shopify"}
                      </Badge>
                    )}
                    {item.source === "api" && !item.undoneAt ? (
                      <Badge variant="outline">Synced</Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-faint">
                    {formatDateTime(item.createdAt, timezone)} ·{" "}
                    {item.importedCount.toLocaleString()} source lines
                  </p>
                  <p className="mt-0.5 text-xs text-faint">
                    {item.duplicateCount} duplicates · {item.skippedCount}{" "}
                    skipped · {item.ignoredCount} ignored{" "}
                    {item.ignoredCount === 1 ? "SKU" : "SKUs"}
                  </p>
                </div>
                {item.canUndo ? (
                  <Button
                    type="button"
                    variant={armedId === item.id ? "destructive" : "outline"}
                    size="sm"
                    disabled={pendingId !== null}
                    onClick={() => void undo(item.id)}
                  >
                    {pendingId === item.id
                      ? "Undoing…"
                      : armedId === item.id
                        ? "Confirm undo"
                        : "Undo"}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2.5 rounded-xl border border-border px-4 py-8 text-center text-base text-muted-foreground">
            No sales imports yet.
          </p>
        )}
        {error ? (
          <p className="mt-2 text-base text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <section className="mt-[26px]" aria-labelledby="sync-runs-heading">
        <h2
          id="sync-runs-heading"
          className="text-md font-semibold text-foreground"
        >
          Sync runs
        </h2>
        <p className="mt-1 text-base text-muted-foreground">
          Each pass a channel made over its own products and sales.
        </p>
        {syncRuns.length ? (
          <div className="mt-2.5 divide-y divide-muted overflow-hidden rounded-xl border border-border">
            {syncRuns.map((run) => (
              <div
                key={run.id}
                className="grid gap-3 px-3.5 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-md">
                      {run.provider === "square" ? "Square" : "Shopify"}
                    </p>
                    <Badge
                      variant={
                        run.status === "failed"
                          ? "destructive"
                          : run.status === "succeeded"
                            ? "success"
                            : "outline"
                      }
                    >
                      {RUN_STATUS_LABELS[run.status]}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-faint">
                    Queued {formatDateTime(new Date(run.queuedAt), timezone)}
                    {run.finishedAt
                      ? ` · finished ${formatDateTime(new Date(run.finishedAt), timezone)}`
                      : ""}
                  </p>
                </div>
                {run.status === "failed" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={retryingId !== null}
                    onClick={() => void retry(run.id)}
                  >
                    {retryingId === run.id ? "Retrying…" : "Retry"}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2.5 rounded-xl border border-border px-4 py-8 text-center text-base text-muted-foreground">
            No sync runs yet.
          </p>
        )}
      </section>
    </div>
  )
}
