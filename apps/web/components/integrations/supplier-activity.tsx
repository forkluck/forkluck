"use client"

import Link from "next/link"

import { useBusinessSettings } from "@/components/business-settings-provider"
import { Badge } from "@/components/ui/badge"
import type { ConnectorProvider, ConnectorSyncRun } from "@/lib/backend/types"
import { formatDateTime } from "@/lib/datetime"

const RUN_STATUS_LABELS: Record<ConnectorSyncRun["status"], string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
}

/**
 * Every pass a supplier connector has made over its documents. Price imports
 * are a different stack — a CSV upload and an invoice edit open the same batch
 * and share one undo — so they stay on Ingredients and are linked, not copied.
 */
export function SupplierActivity({
  runs,
  providers,
}: {
  runs: ConnectorSyncRun[]
  providers: ConnectorProvider[]
}) {
  const { timezone } = useBusinessSettings()
  const name = (providerKey: string) =>
    providers.find((provider) => provider.key === providerKey)?.displayName ??
    providerKey

  return (
    <section className="max-w-[760px]" aria-labelledby="supplier-runs-heading">
      <h2
        id="supplier-runs-heading"
        className="text-md font-semibold text-foreground"
      >
        Sync runs
      </h2>
      <p className="mt-1 text-base text-muted-foreground">
        Documents pulled from connected suppliers.{" "}
        <Link href="/ingredients" className="underline underline-offset-4">
          Price imports
        </Link>{" "}
        are undone on Ingredients.
      </p>
      {runs.length ? (
        <div className="mt-2.5 divide-y divide-muted overflow-hidden rounded-xl border border-border">
          {runs.map((run) => (
            <div key={run.id} className="px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-md">{name(run.providerKey)}</p>
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
                {run.startedAt
                  ? `Started ${formatDateTime(new Date(run.startedAt), timezone)}`
                  : `Queued ${formatDateTime(new Date(run.queuedAt), timezone)}`}
                {run.finishedAt
                  ? ` · finished ${formatDateTime(new Date(run.finishedAt), timezone)}`
                  : ""}
              </p>
              <p className="mt-0.5 text-xs text-faint">
                {run.progress.documentsImported} imported ·{" "}
                {run.progress.documentsSkipped} skipped ·{" "}
                {run.progress.linesNeedingReview} needing review
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2.5 rounded-xl border border-border px-4 py-8 text-center text-base text-muted-foreground">
          No supplier syncs yet.
        </p>
      )}
    </section>
  )
}
