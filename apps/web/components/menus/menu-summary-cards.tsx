import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { MetricCard } from "@/components/ui/metric-card"
import { formatSignedCents, formatSignedPoints } from "@/lib/format-delta"
import type { MenuSummary } from "@/lib/menu/engineering"
import { formatWholeCents, percentFormat } from "@/lib/money"

function percentOrDash(value: number | null) {
  return value === null ? "—" : percentFormat.format(value)
}

/** With Track variance on, each figure carries its move from the baseline. */
export function MenuSummaryCards({
  summary,
  original,
  trackVariance,
  currencyCode,
}: {
  summary: MenuSummary
  original: MenuSummary
  trackVariance: boolean
  currencyCode: string
}) {
  const pointChange =
    summary.menuCostPercent !== null && original.menuCostPercent !== null
      ? (summary.menuCostPercent - original.menuCostPercent) * 100
      : null
  const revenueChange = summary.revenueCents - original.revenueCents
  const profitChange = summary.profitCents - original.profitCents
  const uncosted = summary.uncostedCount

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <MetricCard
        label="Menu cost %"
        value={percentOrDash(summary.menuCostPercent)}
        badge={
          trackVariance && pointChange !== null && pointChange !== 0 ? (
            <Badge
              aria-label="Menu cost % vs original"
              variant={pointChange <= 0 ? "success" : "destructive"}
              className="whitespace-nowrap"
            >
              {formatSignedPoints(pointChange)}
            </Badge>
          ) : null
        }
        note={
          trackVariance
            ? `Original ${percentOrDash(original.menuCostPercent)}`
            : uncosted > 0
              ? uncosted === 1
                ? "1 item uncosted"
                : `${uncosted} items uncosted`
              : null
        }
      />
      <MetricCard
        label="Total revenue"
        value={formatWholeCents(summary.revenueCents, currencyCode)}
        badge={
          trackVariance && revenueChange !== 0 ? (
            <Badge
              aria-label="Total revenue vs original"
              variant={revenueChange >= 0 ? "success" : "destructive"}
              className="whitespace-nowrap"
            >
              {formatSignedCents(revenueChange, currencyCode)}
            </Badge>
          ) : null
        }
        note={
          trackVariance
            ? `Original ${formatWholeCents(original.revenueCents, currencyCode)}`
            : null
        }
      />
      <MetricCard
        label="Total profit"
        value={formatWholeCents(summary.profitCents, currencyCode)}
        badge={
          trackVariance && profitChange !== 0 ? (
            <Badge
              aria-label="Total profit vs original"
              variant={profitChange >= 0 ? "success" : "destructive"}
              className="whitespace-nowrap"
            >
              {formatSignedCents(profitChange, currencyCode)}
            </Badge>
          ) : null
        }
        note={
          trackVariance
            ? `Original ${formatWholeCents(original.profitCents, currencyCode)}`
            : null
        }
      />
    </div>
  )
}
