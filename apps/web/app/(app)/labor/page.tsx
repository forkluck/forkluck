import type { Metadata } from "next"
import { cookies } from "next/headers"

import { LaborEmptyState } from "@/components/labor/labor-empty-state"
import { LaborMetrics } from "@/components/labor/labor-metrics"
import { LaborWorkspace } from "@/components/labor/labor-workspace"
import { PageHeader, PageTitle, Page } from "@/components/ui/page"
import { requireUser } from "@/lib/auth-session"
import { dateSearchParam, rangeEndSearchParam } from "@/lib/date-search-param"
import {
  localDateKey,
  PERIOD_COOKIE,
  rememberedPeriod,
} from "@/lib/date-presets"
import {
  getBusinessSettings,
  getLaborOverview,
  getSalesOverview,
} from "@/lib/backend/queries"
import type { NetSalesTrend } from "@/lib/backend/types"

export const metadata: Metadata = {
  title: "Labor",
}

function comparisonSearchParam(
  value: string | string[] | undefined
): NetSalesTrend["comparison"] {
  switch (value) {
    case "prior_week":
    case "four_weeks_prior":
      return value
    // Links shared before Labor dropped the calendar-date comparisons.
    // `prior_day` becomes the weekday-aligned comparison that replaced it —
    // for a whole-week range the two resolve to the very same dates, and for a
    // partial week `prior_week` is what the reader was already assuming they
    // were looking at. `prior_year` has no weekday-aligned twin, so it falls
    // through to the default, which is itself a year back and does line up.
    case "prior_day":
      return "prior_week"
    // Labor defaults to a comparable prior period, normally anchored on the
    // same weekday 52 weeks earlier and shifted back when needed to avoid overlap.
    default:
      return "fifty_two_weeks_prior"
  }
}

/** Net sales over the selected period and the one it is measured against. */
function periodNetSales(trend: NetSalesTrend) {
  const points = trend.granularity === "day" ? trend.days : trend.hours
  return points.reduce(
    (totals, point) => ({
      currentCents:
        totals.currentCents +
        point.currentSquareCents +
        point.currentShopifyCents +
        point.currentManualCents,
      previousCents:
        totals.previousCents +
        point.previousSquareCents +
        point.previousShopifyCents +
        point.previousManualCents,
    }),
    { currentCents: 0, previousCents: 0 }
  )
}

export default async function LaborPage({
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
  const filters = await searchParams
  const requestedStartDate =
    dateSearchParam(filters.start) ?? dateSearchParam(filters.date)
  const remembered = requestedStartDate
    ? null
    : rememberedPeriod((await cookies()).get(PERIOD_COOKIE)?.value)
  const startDate = requestedStartDate ?? remembered?.startDate
  const endDate = remembered
    ? remembered.endDate
    : rangeEndSearchParam(startDate, filters.end)
  const comparison = comparisonSearchParam(filters.comparison)
  const [overview, settings] = await Promise.all([
    getLaborOverview(startDate, endDate, comparison),
    getBusinessSettings(),
  ])
  const hasShifts = overview.period.availableDates.length > 0

  // Labor as a share of net sales needs the sales for the same window, and the
  // window is only settled once the labor overview has resolved it. Sales are
  // context here, not the subject: if that call fails the share card says it
  // does not know, rather than taking the whole screen down with it.
  const sales =
    hasShifts && overview.period.start && overview.period.end
      ? await getSalesOverview(
          overview.period.start,
          overview.period.end,
          comparison,
          overview.period.timezone
        ).catch(() => null)
      : null
  const netSales = sales ? periodNetSales(sales.netSalesTrend) : null

  return (
    <Page>
      <PageHeader>
        <PageTitle>Labor</PageTitle>
      </PageHeader>

      {hasShifts ? (
        <>
          <LaborMetrics
            laborCostCents={overview.summary.totalLaborCostCents}
            priorLaborCostCents={overview.comparisonSummary.totalLaborCostCents}
            payrollTaxCents={overview.summary.payrollTaxCents}
            totalSeconds={overview.summary.totalSeconds}
            priorTotalSeconds={overview.comparisonSummary.totalSeconds}
            unpaidBreakSeconds={overview.summary.unpaidBreakSeconds}
            shiftCount={overview.employees.reduce(
              (total, employee) => total + employee.shiftCount,
              0
            )}
            netSalesCents={netSales?.currentCents ?? null}
            priorNetSalesCents={netSales?.previousCents ?? null}
            currencyCode={settings.currencyCode}
            comparison={comparison}
          />
          <LaborWorkspace
            employees={overview.employees}
            imports={overview.imports}
            overtime={overview.overtime}
            currencyCode={settings.currencyCode}
            startDate={overview.period.start!}
            endDate={overview.period.end!}
            comparison={overview.period.comparison}
            timeZone={overview.period.timezone}
            today={localDateKey(overview.period.timezone)}
          />
        </>
      ) : (
        <LaborEmptyState />
      )}
    </Page>
  )
}
