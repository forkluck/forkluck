"use client"

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"

import {
  forecastChartPoints,
  type ForecastChartPoint,
} from "@/components/menus/forecast-series"
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart"
import type { MenuForecast } from "@/lib/backend/types"
import { formatAxisCents } from "@/lib/chart-axis"
import { formatCents } from "@/lib/money"

const chartConfig = {
  actualCents: { label: "Actual", color: "var(--foreground)" },
  typicalCents: { label: "Typical", color: "var(--brand)" },
  band: { label: "Typical to busy", color: "var(--brand-fill)" },
} satisfies ChartConfig

function ForecastTooltip({
  active,
  payload,
  currencyCode,
}: {
  active?: boolean
  payload?: Array<{ payload: ForecastChartPoint }>
  currencyCode: string
}) {
  const point = payload?.[0]?.payload
  if (!active || !point) return null
  return (
    <div className="rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs leading-4 shadow-xl">
      <div className="font-medium">{point.tooltipLabel}</div>
      <div className="mt-0.5 text-muted-foreground tabular-nums">
        {point.isHorizon && point.band
          ? `Typical ${formatCents(point.band[0], currencyCode)} · Busy ${formatCents(point.band[1], currencyCode)}`
          : `Actual ${formatCents(point.actualCents ?? 0, currencyCode)}`}
      </div>
    </div>
  )
}

function LegendKey({
  swatch,
  children,
}: {
  swatch: string
  children: React.ReactNode
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={swatch} aria-hidden="true" />
      {children}
    </span>
  )
}

/**
 * Sales so far against what the plan projects: one solid line meeting one
 * dashed line at today, with the typical-to-busy band behind it. Money on both
 * sides is units at current menu prices, so the eye compares quantity only.
 */
export function MenuForecastChart({
  series,
  horizonStart,
  currencyCode,
  summary,
}: {
  series: MenuForecast["series"]
  horizonStart: string
  currencyCode: string
  summary: string
}) {
  const { points, todayLabel } = forecastChartPoints(series, horizonStart)

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <LegendKey swatch="h-0.5 w-4 rounded-full bg-foreground">
          Actual
        </LegendKey>
        <LegendKey swatch="h-0 w-4 border-t-2 border-dashed border-brand">
          Typical
        </LegendKey>
        <LegendKey swatch="h-2.5 w-4 rounded-sm bg-brand-fill">
          Typical to busy
        </LegendKey>
      </div>

      <ChartContainer
        config={chartConfig}
        className="mt-3 aspect-auto h-[188px] w-full"
        aria-hidden="true"
      >
        <ComposedChart
          data={points}
          margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
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
            interval="preserveStartEnd"
            minTickGap={28}
            tick={{ className: "fill-faint text-2xs" }}
          />
          <ChartTooltip
            cursor={{ stroke: "var(--border)" }}
            content={<ForecastTooltip currencyCode={currencyCode} />}
          />
          <ReferenceLine
            x={todayLabel}
            stroke="var(--border)"
            label={{
              value: "Today",
              position: "insideTopLeft",
              className: "fill-muted-foreground text-2xs",
            }}
          />
          <Area
            dataKey="band"
            fill="var(--color-band)"
            stroke="none"
            isAnimationActive={false}
          />
          <Line
            dataKey="actualCents"
            stroke="var(--color-actualCents)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="typicalCents"
            stroke="var(--color-typicalCents)"
            strokeWidth={2}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ChartContainer>

      <p className="sr-only">{summary}</p>
    </div>
  )
}
