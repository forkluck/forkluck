"use client"

import * as React from "react"

import { loadConnectorSyncRun } from "@/app/(app)/invoices/actions"
import type { ConnectorSyncRun } from "@/lib/backend/types"
import { useRefresh } from "@/hooks/use-refresh"

const POLL_INTERVAL_MS = 3_000

function active(run: ConnectorSyncRun | null): boolean {
  return run?.status === "queued" || run?.status === "running"
}

/** Polls a single durable connector run, then re-reads the catalog on settle. */
export function useConnectorRun(
  initial: ConnectorSyncRun | null
): ConnectorSyncRun | null {
  const { refresh } = useRefresh()
  const [watched, setWatched] = React.useState<ConnectorSyncRun | null>(null)
  const activeId = initial && active(initial) ? initial.id : null

  React.useEffect(() => {
    if (!activeId) return
    let stopped = false
    const timer = window.setInterval(() => {
      loadConnectorSyncRun(activeId)
        .then((next) => {
          if (stopped) return
          setWatched(next)
          if (active(next)) return
          window.clearInterval(timer)
          void refresh()
        })
        // A transient network interruption should not make a durable import
        // look failed. The next interval simply asks the service again.
        .catch(() => {})
    }, POLL_INTERVAL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [activeId, refresh])

  return watched && watched.id === initial?.id ? watched : initial
}
