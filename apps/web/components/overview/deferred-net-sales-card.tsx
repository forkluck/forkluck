"use client"

import * as React from "react"
import dynamic from "next/dynamic"

import { AnalyticsCard, CardLabel } from "@/components/overview/analytics-cards"
import type { Channel } from "@/components/overview/channel-filter"
import { periodNetSales } from "@/components/overview/trend"
import { Spinner } from "@/components/ui/spinner"
import type { CurrencyCode } from "@/lib/business-settings"
import { formatWholeCents } from "@/lib/money"
import type { NetSalesTrend } from "@/lib/backend/types"

const NetSalesCard = dynamic(() =>
  import("@/components/overview/net-sales-card").then(
    (module) => module.NetSalesCard
  )
)

/** Paint the headline now; hydrate the chart library after the first frame. */
export function DeferredNetSalesCard({
  trend,
  channel,
  currencyCode,
}: {
  trend: NetSalesTrend
  channel: Channel
  currencyCode: CurrencyCode
}) {
  const [ready, setReady] = React.useState(false)
  React.useEffect(() => {
    // A transition keeps the headline placeholder on screen while the chart
    // chunk loads, instead of tearing the whole card down to its fallback.
    const timer = window.setTimeout(
      () => React.startTransition(() => setReady(true)),
      100
    )
    return () => window.clearTimeout(timer)
  }, [])

  const totals = periodNetSales(trend, channel)
  // The headline is real server data, so it paints in the placeholder and again
  // under the local suspense fallback — only the chart area waits.
  const placeholder = (
    <AnalyticsCard
      className="min-h-[286px] px-4 pt-[22px] pb-[18px] sm:px-6"
      aria-label="Loading net sales chart"
    >
      <CardLabel>Net sales</CardLabel>
      <p className="mt-2 text-4xl leading-none font-semibold tracking-[-0.03em] tabular-nums">
        {formatWholeCents(totals.currentCents, currencyCode)}
      </p>
      <div className="mt-[26px] grid h-[188px] place-items-center">
        <Spinner label="Loading net sales chart" />
      </div>
    </AnalyticsCard>
  )

  if (!ready) return placeholder

  // `dynamic()` defaults to a Fragment, so on its own the chart chunk would
  // suspend up to the route's full-page loader. A local boundary keeps the
  // wait inside this card.
  return (
    <React.Suspense fallback={placeholder}>
      <NetSalesCard
        trend={trend}
        channel={channel}
        currencyCode={currencyCode}
      />
    </React.Suspense>
  )
}
