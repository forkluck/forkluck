import type { PosConnectionRow } from "./backend/types"

const MINUTE = 60_000
const providerName = { square: "Square", shopify: "Shopify" } as const
const relativeTimeFormat = new Intl.RelativeTimeFormat("en", {
  numeric: "always",
})

const syncedFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
})

export function updatedLabel(minutes: number) {
  const wholeMinutes = Math.max(0, Math.round(minutes))
  if (wholeMinutes < 1) return "Updated just now"
  if (wholeMinutes < 60) {
    return `Updated ${relativeTimeFormat.format(-wholeMinutes, "minute")}`
  }
  const hours = Math.round(wholeMinutes / 60)
  if (hours < 24) {
    return `Updated ${relativeTimeFormat.format(-hours, "hour")}`
  }
  const days = Math.round(hours / 24)
  return `Updated ${relativeTimeFormat.format(-days, "day")}`
}

/**
 * Header status for the connected providers: errors win, and successful data
 * is only as fresh as the oldest active provider sync.
 */
export function connectionState(
  connections: PosConnectionRow[] | null,
  now: number | null
) {
  if (connections === null) {
    return {
      dot: "bg-line-strong",
      label: "Status unavailable",
      title: "Channel status could not be loaded",
    }
  }
  const broken = connections.find((row) => row.status === "needs_reconnect")
  if (broken) {
    return {
      dot: "bg-destructive",
      label: `${providerName[broken.provider]} disconnected`,
      title: `${providerName[broken.provider]} disconnected — reconnect in Settings`,
    }
  }
  const failing = connections.find((row) => row.lastError)
  if (failing) {
    return {
      dot: "bg-warning",
      label: "Sync incomplete",
      title: failing.lastError,
    }
  }
  if (connections.length === 0) {
    return {
      dot: "bg-line-strong",
      label: "No channels connected",
      title: "Connect Square or Shopify in Settings",
    }
  }

  const active = connections.filter((row) => row.status === "active")
  const unsynced = active.find((row) => {
    if (!row.lastSyncedAt) return true
    return !Number.isFinite(new Date(row.lastSyncedAt).getTime())
  })
  if (unsynced) {
    return {
      dot: "bg-warning",
      label: "Never synced",
      title: `${providerName[unsynced.provider]} has not completed a sync`,
    }
  }

  // Data is only as fresh as the stalest active provider. Using the newest
  // timestamp would make a recent Square sync hide an old Shopify sync.
  const oldest = active
    .map((row) => ({ row, timestamp: new Date(row.lastSyncedAt!).getTime() }))
    .sort((left, right) => left.timestamp - right.timestamp)[0]
  if (!oldest) {
    return {
      dot: "bg-line-strong",
      label: "No channels connected",
      title: "Connect Square or Shopify in Settings",
    }
  }
  const minutes =
    now === null
      ? null
      : Math.max(0, Math.floor((now - oldest.timestamp) / MINUTE))
  return {
    dot: "bg-success-dot",
    label: minutes === null ? "Last sync recorded" : updatedLabel(minutes),
    title: `${providerName[oldest.row.provider]} last synced ${syncedFormat.format(new Date(oldest.timestamp))} UTC`,
  }
}
