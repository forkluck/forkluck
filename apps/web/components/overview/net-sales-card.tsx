"use client"

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import {
  AnalyticsCard,
  CardLabel,
  CardNote,
} from "@/components/overview/analytics-cards"
import type { Channel } from "@/components/overview/channel-filter"
import { periodNetSales, trendBars } from "@/components/overview/trend"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { MetricComparisonBadge } from "@/components/ui/metric-comparison-badge"
import type { CurrencyCode } from "@/lib/business-settings"
import { formatAxisCents } from "@/lib/chart-axis"
import { formatWholeCents } from "@/lib/money"
import type { NetSalesTrend } from "@/lib/backend/types"

const chartConfig = {
  currentCents: { label: "This period", color: "var(--brand)" },
  previousCents: { label: "Comparison", color: "var(--brand-fill)" },
} satisfies ChartConfig

/**
 * Net sales: the hero of the Analytics screen. One 42px figure, its delta
 * badge, and the period's bars.
 */
export function NetSalesCard({
  trend,
  channel,
  currencyCode,
}: {
  trend: NetSalesTrend
  channel: Channel
  currencyCode: CurrencyCode
}) {
  if (!trend.currentDate) {
    return (
      <AnalyticsCard className="px-4 pt-[22px] pb-[18px] sm:px-6">
        <CardLabel>Net sales</CardLabel>
        <p className="mt-2 text-4xl leading-none font-semibold tracking-[-0.03em] text-disabled-foreground tabular-nums">
          {formatWholeCents(0, currencyCode)}
        </p>
        <CardNote className="mt-[26px] leading-[1.55]">
          No sales are tracked yet. Connect a register or import sales to fill
          this chart.
        </CardNote>
      </AnalyticsCard>
    )
  }

  const bars = trendBars(trend, channel)
  const totals = periodNetSales(trend, channel)

  return (
    <AnalyticsCard className="px-4 pt-[22px] pb-[18px] sm:px-6">
      <CardLabel>Net sales</CardLabel>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <p className="text-4xl leading-none font-semibold tracking-[-0.03em] tabular-nums">
          {formatWholeCents(totals.currentCents, currencyCode)}
        </p>
        <MetricComparisonBadge
          current={totals.currentCents}
          previous={totals.previousCents}
        />
      </div>

      <ChartContainer
        config={chartConfig}
        className="mt-[26px] aspect-auto h-[188px] w-full"
      >
        <BarChart
          data={bars}
          margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          barCategoryGap={bars.length > 14 ? "12%" : "22%"}
          barGap={bars.length > 14 ? 1 : 3}
        >
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <YAxis
            width={52}
            tickCount={3}
            tickLine={false}
            axisLine={false}
            tick={{ className: "fill-faint text-2xs" }}
            tickFormatter={(value: number) =>
              formatAxisCents(value, currencyCode)
            }
          />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={10}
            interval={0}
            tick={{ className: "fill-faint text-2xs" }}
            tickFormatter={(value: string, index: number) =>
              bars[index]?.showLabel ? value : ""
            }
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                labelFormatter={(_label, payload) =>
                  payload?.[0]?.payload?.tooltipLabel ?? ""
                }
                formatter={(value, name) => (
                  <div className="flex flex-1 items-center justify-between gap-4">
                    <span className="text-muted-foreground">
                      {chartConfig[name as keyof typeof chartConfig].label}
                    </span>
                    <span className="font-medium tabular-nums">
                      {formatWholeCents(Number(value), currencyCode)}
                    </span>
                  </div>
                )}
              />
            }
          />
          <Bar
            dataKey="currentCents"
            fill="var(--color-currentCents)"
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
          <Bar
            dataKey="previousCents"
            fill="var(--color-previousCents)"
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ChartContainer>

      <p className="sr-only">
        {formatWholeCents(totals.currentCents, currencyCode)} net sales over{" "}
        {bars.length} points, against{" "}
        {formatWholeCents(totals.previousCents, currencyCode)} in the comparison
        period.
      </p>
    </AnalyticsCard>
  )
}
