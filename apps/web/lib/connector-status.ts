import type {
  ConnectorConnection,
  ConnectorProvider,
  ConnectorSyncRun,
} from "@/lib/backend/types"

const MINUTE = 60_000

const relativeTimeFormat = new Intl.RelativeTimeFormat("en", {
  numeric: "always",
})

export type ConnectorRowState =
  | "not_connected"
  | "connecting"
  | "connected"
  | "needs_reconnect"
  | "syncing"
  | "sync_failed"

export type ConnectorBadge = {
  label: string
  variant: "success" | "warning" | "secondary"
}

export type ConnectorRow = {
  state: ConnectorRowState
  badge: ConnectorBadge | null
  statusLine: string
  primary: "connect" | "reconnect" | "sync" | "retry" | null
  canSync: boolean
}

export function relativeAgo(at: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / MINUTE))
  if (minutes < 1) return "just now"
  if (minutes < 60) return relativeTimeFormat.format(-minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (hours < 24) return relativeTimeFormat.format(-hours, "hour")
  return relativeTimeFormat.format(-Math.round(hours / 24), "day")
}

function active(run: ConnectorSyncRun | null): boolean {
  return run?.status === "queued" || run?.status === "running"
}

/**
 * The connector service returns intentionally generic errors. Keep the
 * rendered state generic too: a supplier's internal login details must never
 * turn into customer-visible Forkluck copy.
 */
export function connectorRow(
  provider: ConnectorProvider,
  connection: ConnectorConnection | null,
  now: Date
): ConnectorRow {
  if (!connection || connection.status === "disconnected") {
    return {
      state: "not_connected",
      badge: null,
      statusLine: provider.description,
      primary: "connect",
      canSync: false,
    }
  }

  const run = connection.latestRun
  if (
    connection.status === "needs_reconnect" ||
    connection.status === "error"
  ) {
    return {
      state: "needs_reconnect",
      badge: { label: "Needs attention", variant: "warning" },
      statusLine:
        connection.lastError ?? "Reconnect this supplier to resume importing.",
      primary: "reconnect",
      canSync: false,
    }
  }

  if (connection.status === "connecting") {
    return {
      state: "connecting",
      badge: { label: "Connecting", variant: "secondary" },
      statusLine: "Finish the supplier sign-in to begin importing.",
      primary: null,
      canSync: false,
    }
  }

  if (active(run)) {
    const imported = run?.progress.documentsImported ?? 0
    return {
      state: "syncing",
      badge: {
        label: run?.status === "queued" ? "Queued" : "Syncing",
        variant: "secondary",
      },
      statusLine:
        imported > 0
          ? `Importing documents · ${imported} imported so far.`
          : "Importing supplier documents.",
      primary: null,
      canSync: false,
    }
  }

  if (run?.status === "failed" || run?.status === "cancelled") {
    return {
      state: "sync_failed",
      badge: { label: "Last import failed", variant: "warning" },
      statusLine:
        run.error ??
        (run.status === "cancelled"
          ? "The last import was cancelled. Try again."
          : "The last import stopped before it finished. Try again."),
      primary: "retry",
      canSync: true,
    }
  }

  return {
    state: "connected",
    badge: { label: "Connected", variant: "success" },
    statusLine: connection.lastSyncedAt
      ? `Last synced ${relativeAgo(connection.lastSyncedAt, +now)}.`
      : "Connected · No documents imported yet.",
    primary: "sync",
    canSync: true,
  }
}
