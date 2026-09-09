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
import { units } from "@/components/menus/forecast-format"

const chartConfig = {
  actualUnits: { label: "Actual", color: "var(--foreground)" },
  typicalUnits: { label: "Typical", color: "var(--brand)" },
  band: { label: "Typical to planned", color: "var(--brand-fill)" },
} satisfies ChartConfig

function ForecastTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload: ForecastChartPoint }>
}) {
  const point = payload?.[0]?.payload
  if (!active || !point) return null
  return (
    <div className="rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs leading-4 shadow-xl">
      <div className="font-medium">{point.tooltipLabel}</div>
      <div className="mt-0.5 text-muted-foreground tabular-nums">
        {point.isHorizon
          ? `Typical ${units(point.typicalUnits ?? 0)} units${point.band ? ` · Planned ${units(point.band[1])} units` : ""}`
          : `Actual ${units(point.actualUnits ?? 0)} units`}
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
 * Menu-member units against the chosen plan: one solid line meeting one
 * dashed line at today. The busy plan is distributed by weekday rhythm;
 * the band shows that allocation rather than separate daily busy estimates.
 */
export function MenuForecastChart({
  series,
  horizonStart,
  summary,
  plan,
}: {
  series: MenuForecast["series"]
  horizonStart: string
  summary: string
  plan: MenuForecast["basis"]["plan"]
}) {
  const { points, todayLabel } = forecastChartPoints(series, horizonStart, plan)

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <LegendKey swatch="h-0.5 w-4 rounded-full bg-foreground">
          Actual
        </LegendKey>
        <LegendKey swatch="h-0 w-4 border-t-2 border-dashed border-brand">
          Typical
        </LegendKey>
        {plan === "busy" ? (
          <LegendKey swatch="h-2.5 w-4 rounded-sm bg-brand-fill">
            Typical to planned
          </LegendKey>
        ) : null}
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
            tickFormatter={units}
            allowDecimals={false}
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
            content={<ForecastTooltip />}
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
            dataKey="actualUnits"
            stroke="var(--color-actualUnits)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="typicalUnits"
            stroke="var(--color-typicalUnits)"
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
