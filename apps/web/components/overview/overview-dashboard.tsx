"use client"

import { useRouter } from "next/navigation"
import * as React from "react"

import {
  AnalyticsCard,
  CardLabel,
  CardMetric,
  CardNote,
  ProgressRail,
} from "@/components/overview/analytics-cards"
import {
  ChannelFilter,
  type Channel,
} from "@/components/overview/channel-filter"
import { DeferredNetSalesCard } from "@/components/overview/deferred-net-sales-card"
import { HomePlanBadge } from "@/components/overview/home-plan-badge"
import {
  PriceMovesCard,
  type PriceMove,
} from "@/components/overview/price-moves-card"
import { TopProductsCard } from "@/components/overview/top-products-card"
import {
  hasPrimeCostComparison,
  periodNetSales,
  primeCostState,
} from "@/components/overview/trend"
import { ComparisonFilter } from "@/components/period-filter"
import { DateRangeFilter } from "@/components/ui/date-range-filter"
import { LoadingRegion } from "@/components/ui/loading-region"
import { MetricCard } from "@/components/ui/metric-card"
import { MetricComparisonBadge } from "@/components/ui/metric-comparison-badge"
import { SyncStatus } from "@/components/sync-status"
import { Page, PageTitle } from "@/components/ui/page"
import type { CurrencyCode } from "@/lib/business-settings"
import { formatWholeCents, percentFormat } from "@/lib/money"
import { salesComparisonOptions } from "@/lib/period-comparison"
import type {
  DashboardOverview,
  NetSalesTrend,
  PosConnectionRow,
  SalesOverview,
} from "@/lib/backend/types"

/**
 * Analytics: the default screen. Three rows of cards over one period, and the
 * period is the only control on the page — a Date pill and the comparison it
 * is measured against, both written straight to the URL so the view is
 * shareable and survives a reload.
 *
 * Analytics is the one screen whose title block is not the app's default: the
 * handoff puts its two pills 12px under the h1 and 24px above the cards, where
 * every other screen runs 20px to a toolbar and 16px to its table.
 */
export function OverviewDashboard({
  recipeMetrics,
  sales,
  currencyCode,
  connections,
  priceMoves,
  freePlan = false,
}: {
  recipeMetrics: DashboardOverview["recipeMetrics"]
  sales: SalesOverview
  currencyCode: CurrencyCode
  connections: PosConnectionRow[]
  priceMoves: PriceMove[]
  freePlan?: boolean
}) {
  const router = useRouter()
  // The period change is a navigation to the same page; the cards below dim
  // and the pill spins until the new figures arrive.
  const [periodPending, startPeriod] = React.useTransition()
  const [selectedChannel, setSelectedChannel] = React.useState<Channel>("all")
  const trend = sales.netSalesTrend
  const updateSalesTrend = React.useCallback(
    (
      startDate: string,
      endDate: string,
      comparison: NetSalesTrend["comparison"]
    ) => {
      const params = new URLSearchParams()
      params.set("tab", "activity")
      const defaultDate = trend.availableDates[0]
      if (!defaultDate || startDate !== defaultDate || endDate !== startDate) {
        params.set("start", startDate)
      }
      if (endDate !== startDate) params.set("end", endDate)
      if (comparison !== "prior_day") {
        params.set("comparison", comparison)
      }
      startPeriod(() => router.replace(`/?${params}`, { scroll: false }))
    },
    [router, trend.availableDates]
  )
  const connectedChannels = connections
    .filter((connection) => connection.status === "active")
    .map((connection) => connection.provider)
  // Labor and invoice purchases are company-wide; their percentages must use
  // the matching all-channel revenue even while the sales cards are filtered.
  const companyNetSales = periodNetSales(trend, "all")
  const costRevenueLabel =
    selectedChannel === "all" ? "net sales" : "all-channel net sales"
  const primeCost = primeCostState(trend.financials)
  const primeCostRatio =
    primeCost.status === "estimated" && companyNetSales.currentCents > 0
      ? primeCost.currentCents / companyNetSales.currentCents
      : null
  const previousPrimeCostCents =
    trend.financials.previousLaborCents + trend.financials.previousInvoiceCents
  const previousPrimeCostRatio =
    companyNetSales.previousCents > 0
      ? previousPrimeCostCents / companyNetSales.previousCents
      : null
  const {
    averageFoodCost: recipeAverageFoodCost,
    costedRecipes: costedRecipeCount,
    foodCostTarget,
    recipesNeedingAttention,
    totalRecipes,
  } = recipeMetrics
  const laborRatio =
    companyNetSales.currentCents > 0
      ? trend.financials.currentLaborCents / companyNetSales.currentCents
      : null
  const invoiceRatio =
    companyNetSales.currentCents > 0
      ? trend.financials.currentInvoiceCents / companyNetSales.currentCents
      : null
  const hasPeriod = Boolean(trend.periodStart && trend.periodEnd)

  return (
    <Page variant="wide">
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <PageTitle>Analytics</PageTitle>
          <HomePlanBadge freePlan={freePlan} />
          {/* With nothing to filter there is no filter row, so freshness sits
              on the title line rather than alone on an empty one under it. */}
          {hasPeriod ? null : (
            <div className="ml-auto">
              <SyncStatus connections={connections} />
            </div>
          )}
        </div>
        {hasPeriod ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <DateRangeFilter
              selectedStartDate={trend.periodStart!}
              selectedEndDate={trend.periodEnd!}
              timeZone={trend.timezone}
              pending={periodPending}
              onSelectedDateRangeChange={(startDate, endDate) =>
                updateSalesTrend(startDate, endDate, trend.comparison)
              }
            />
            <ComparisonFilter
              startDate={trend.periodStart!}
              endDate={trend.periodEnd!}
              comparison={trend.comparison}
              options={salesComparisonOptions}
              pending={periodPending}
              onComparisonChange={(comparison) =>
                updateSalesTrend(
                  trend.periodStart!,
                  trend.periodEnd!,
                  comparison
                )
              }
            />
            {/* Only worth a pill once there is something to split by. */}
            {connectedChannels.length > 1 ? (
              <ChannelFilter
                connectedChannels={connectedChannels}
                selectedChannel={selectedChannel}
                onSelectedChannelChange={setSelectedChannel}
                showLabel
              />
            ) : null}
            {/* Freshness sits at the far right of the same row. */}
            <div className="ml-auto">
              <SyncStatus connections={connections} />
            </div>
          </div>
        ) : null}
      </div>

      <LoadingRegion pending={periodPending} label="Loading analytics">
        {sales.incompleteManualRevenue ? (
          <div className="rounded-xl border border-border bg-fill-soft px-4 py-3 text-sm text-muted-foreground">
            Manual count-only entries are included in product quantities but
            omitted from revenue totals.
          </div>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
          <DeferredNetSalesCard
            trend={trend}
            channel={selectedChannel}
            currencyCode={currencyCode}
          />

          <div className="grid gap-4 lg:grid-rows-2">
            <AnalyticsCard className="flex flex-col justify-center px-5 py-[18px]">
              <CardLabel>Prime cost</CardLabel>
              <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
                <CardMetric
                  className={
                    primeCost.status === "incomplete"
                      ? "text-disabled-foreground"
                      : ""
                  }
                >
                  {primeCost.status === "incomplete"
                    ? "—"
                    : primeCostRatio === null
                      ? formatWholeCents(primeCost.currentCents, currencyCode)
                      : percentFormat.format(primeCostRatio)}
                </CardMetric>
                {primeCost.status === "estimated" &&
                hasPrimeCostComparison(trend.financials) ? (
                  <MetricComparisonBadge
                    current={primeCostRatio ?? primeCost.currentCents}
                    previous={
                      primeCostRatio === null
                        ? previousPrimeCostCents
                        : (previousPrimeCostRatio ?? 0)
                    }
                    lowerIsBetter
                    label="Prime cost against the comparison period"
                  />
                ) : null}
              </div>
              <CardNote className="mt-2">
                {primeCost.status === "incomplete"
                  ? `Labor ${formatWholeCents(primeCost.laborCents, currencyCode)}, no invoices in this period`
                  : `${formatWholeCents(primeCost.currentCents, currencyCode)} of ${formatWholeCents(companyNetSales.currentCents, currencyCode)} ${costRevenueLabel}`}
              </CardNote>
              <ProgressRail
                ratio={primeCostRatio ?? 0}
                label="Prime cost as a share of net sales"
              />
            </AnalyticsCard>

            <AnalyticsCard className="flex flex-col justify-center px-5 py-[18px]">
              <CardLabel>Invoices</CardLabel>
              <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
                <CardMetric>{trend.financials.currentInvoiceCount}</CardMetric>
                <MetricComparisonBadge
                  current={trend.financials.currentInvoiceCount}
                  previous={trend.financials.previousInvoiceCount}
                  label="Invoices received against the comparison period"
                />
              </div>
              <CardNote className="mt-2">
                {`${formatWholeCents(
                  trend.financials.currentInvoiceCents,
                  currencyCode
                )} received this period`}
              </CardNote>
              <ProgressRail
                ratio={invoiceRatio ?? 0}
                label="Invoice spend as a share of net sales"
              />
            </AnalyticsCard>
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <MetricCard
            label="Labor"
            value={formatWholeCents(
              trend.financials.currentLaborCents,
              currencyCode
            )}
            badge={
              <MetricComparisonBadge
                current={trend.financials.currentLaborCents}
                previous={trend.financials.previousLaborCents}
                lowerIsBetter
                label="Labor cost against the comparison period"
              />
            }
            note={
              laborRatio === null
                ? "No net sales in this period"
                : `${percentFormat.format(laborRatio)} of ${costRevenueLabel}`
            }
          />
          <MetricCard
            label="Average food cost"
            value={
              recipeAverageFoodCost === null
                ? "—"
                : percentFormat.format(recipeAverageFoodCost)
            }
            note={
              recipeAverageFoodCost === null
                ? "No costed recipes yet"
                : `target ${percentFormat.format(foodCostTarget)}`
            }
          />
          <MetricCard
            label="Total recipes"
            value={totalRecipes}
            note={
              recipesNeedingAttention
                ? `${recipesNeedingAttention} to review`
                : `${costedRecipeCount} costed`
            }
          />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[1.35fr_1fr]">
          <TopProductsCard
            productSales={sales.topProducts}
            channel={selectedChannel}
            currencyCode={currencyCode}
          />
          <PriceMovesCard moves={priceMoves} currencyCode={currencyCode} />
        </div>
      </LoadingRegion>
    </Page>
  )
}
