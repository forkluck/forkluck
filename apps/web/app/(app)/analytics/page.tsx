import type { Metadata } from "next"
import { cookies } from "next/headers"

import { OverviewDashboard } from "@/components/overview/overview-dashboard"
import { getSession, requireUser } from "@/lib/auth-session"
import {
  getDashboardOverview,
  getPosConnections,
  getSalesOverview,
} from "@/lib/backend/queries"
import { dateSearchParam, rangeEndSearchParam } from "@/lib/date-search-param"
import { PERIOD_COOKIE, rememberedPeriod } from "@/lib/date-presets"
import type { NetSalesTrend } from "@/lib/backend/types"

export const metadata: Metadata = {
  title: "Analytics",
}

function comparisonSearchParam(
  value: string | string[] | undefined
): NetSalesTrend["comparison"] {
  switch (value) {
    case "fifty_two_weeks_prior":
    case "prior_year":
      return value
    default:
      return "prior_day"
  }
}

export default async function AnalyticsPage({
  searchParams,
}: {
  // A repeated query parameter arrives as an array, so the guards below take
  // the shape Next.js actually delivers rather than the one a link would build.
  searchParams: Promise<{
    date?: string | string[]
    start?: string | string[]
    end?: string | string[]
    comparison?: string | string[]
  }>
}) {
  await requireUser()
  const session = await getSession()
  const salesFilters = await searchParams
  const requestedStartDate =
    dateSearchParam(salesFilters.start) ?? dateSearchParam(salesFilters.date)
  const remembered = requestedStartDate
    ? null
    : rememberedPeriod((await cookies()).get(PERIOD_COOKIE)?.value)
  const trendStartDate = requestedStartDate ?? remembered?.startDate
  const trendEndDate = remembered
    ? remembered.endDate
    : rangeEndSearchParam(trendStartDate, salesFilters.end)
  const trendComparison = comparisonSearchParam(salesFilters.comparison)
  const [dashboard, connections, sales] = await Promise.all([
    getDashboardOverview(),
    getPosConnections(),
    getSalesOverview(trendStartDate, trendEndDate, trendComparison),
  ])
  return (
    <OverviewDashboard
      recipeMetrics={dashboard.recipeMetrics}
      sales={sales}
      currencyCode={dashboard.currencyCode}
      connections={connections}
      priceMoves={dashboard.priceMoves}
      freePlan={session?.billing.plan === "free"}
    />
  )
}
