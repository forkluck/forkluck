"use client"

import * as React from "react"
import { RefreshCw } from "lucide-react"

import { enqueuePosSync, loadPosSyncRun } from "@/app/(app)/sales/actions"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toast"
import type { PosConnectionRow, PosSyncRun } from "@/lib/backend/types"
import { connectionState } from "@/lib/connection-status"
import { queueHeaderConnections } from "@/lib/header-refresh"
import { cn } from "@/lib/utils"
import { useRefresh } from "@/hooks/use-refresh"
import { useBusinessSettings } from "@/components/business-settings-provider"

/** How fresh the channel data is, with a button that queues a sync. */
export function SyncStatus({
  connections,
}: {
  connections: PosConnectionRow[] | null
}) {
  const { refresh } = useRefresh()
  const { timezone } = useBusinessSettings()
  const toast = useToast()
  // The server-safe first paint uses an exact sync title. Once mounted, the
  // clock switches the visible label to a relative age and advances it.
  const [now, setNow] = React.useState<number | null>(null)
  const [refreshing, startRefresh] = React.useTransition()
  const [watched, setWatched] = React.useState<PosSyncRun[]>([])

  React.useEffect(() => {
    const initial = window.setTimeout(() => setNow(Date.now()), 0)
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [])

  const queueSync = () =>
    startRefresh(async () => {
      try {
        const { runs, failures } = await queueHeaderConnections(
          connections,
          enqueuePosSync
        )
        setWatched(runs)
        if (runs.length > 0) {
          toast.add({
            title: "Syncing in the background",
            description: "We’ll refresh your numbers when it finishes.",
          })
        }
        for (const failure of failures) {
          const provider = failure.provider === "square" ? "Square" : "Shopify"
          toast.add({
            title: `${provider} sync failed`,
            description: failure.error,
            type: "error",
          })
        }
      } catch {
        toast.add({
          title: "Couldn’t start the sync",
          description: "Refresh the page and try again.",
          type: "error",
        })
      }
      void refresh().then(() => setNow(Date.now()))
    })

  // Watch the queued runs so the button stays down until the sync finishes,
  // then reload the route once for the fresh timestamp.
  const watchedIds = watched.map((run) => run.id).join(",")
  React.useEffect(() => {
    if (!watchedIds) return
    let stopped = false
    const timer = window.setInterval(() => {
      Promise.all(watchedIds.split(",").map((id) => loadPosSyncRun(id)))
        .then((runs) => {
          if (stopped) return
          const active = runs.filter(
            (run): run is PosSyncRun =>
              run !== null &&
              (run.status === "queued" || run.status === "running")
          )
          if (active.length > 0) {
            setWatched(active)
            return
          }
          window.clearInterval(timer)
          setWatched([])
          void refresh()
          setNow(Date.now())
          if (runs.some((run) => run?.status === "failed")) {
            toast.add({
              title: "Sync failed",
              description:
                "Some channels didn’t finish syncing. Try refreshing again.",
              type: "error",
            })
          } else if (
            runs.length > 0 &&
            runs.every((run) => run?.status === "succeeded")
          ) {
            toast.add({
              title: "Sync complete",
              description: "Your data is up to date.",
            })
          }
        })
        .catch(() => {})
    }, 3_000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [watchedIds, refresh, toast])

  const connection = connectionState(connections, now, timezone)
  const syncing = refreshing || watched.length > 0
  const canRefresh = Boolean(
    connections?.some((connection) => connection.status === "active")
  )

  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span title={connection.title} className="flex items-center gap-[7px]">
        <span
          aria-hidden="true"
          className={cn("size-[7px] shrink-0 rounded-full", connection.dot)}
        />
        <span aria-live="polite" className="whitespace-nowrap">
          {connection.label}
        </span>
      </span>
      {/* Nothing to pull from until a channel is connected. */}
      {canRefresh ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={queueSync}
          aria-busy={syncing}
          disabled={syncing}
        >
          <RefreshCw
            className={cn(syncing && "animate-spin")}
            strokeWidth={1.8}
            aria-hidden="true"
          />
          Force refresh
        </Button>
      ) : null}
    </div>
  )
}
