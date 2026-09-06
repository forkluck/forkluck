import type { MenuForecast } from "@/lib/backend/types"
import { parseDateKey } from "@/lib/date-presets"
import { formatWholeCents } from "@/lib/money"

/**
 * The arithmetic behind the one forecast chart and the one accuracy sentence.
 * Kept out of the chart so it stays testable without a DOM.
 */

const dayMonthFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
})

const fullDateFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
})

export type ForecastChartPoint = {
  key: string
  label: string
  tooltipLabel: string
  actualCents: number | null
  typicalCents: number | null
  /** Recharts draws a ranged area from a [low, high] tuple in the data. */
  band: [number, number] | null
  isHorizon: boolean
}

export function forecastChartPoints(
  series: MenuForecast["series"],
  horizonStart: string
): { points: ForecastChartPoint[]; todayLabel: string } {
  const points = series.map((row) => {
    const date = parseDateKey(row.date)
    return {
      key: row.date,
      label: dayMonthFormat.format(date),
      tooltipLabel: fullDateFormat.format(date),
      actualCents: row.actualCents,
      typicalCents: row.typicalCents,
      band:
        row.typicalCents === null || row.busyCents === null
          ? null
          : ([row.typicalCents, row.busyCents] as [number, number]),
      isHorizon: row.date >= horizonStart,
    }
  })
  const first = points.find((point) => point.isHorizon)
  return { points, todayLabel: first ? first.label : "" }
}

export function accuracySentence(backtest: MenuForecast["backtest"]): string {
  if (backtest.errorPercent === null)
    return "Not enough sales history to check accuracy yet."
  // The window is every replayed week; scoredWeeks only counts the ones that
  // sold anything, so it names the coverage denominator, never the window.
  return `Over the last ${backtest.weeks.length} weeks the typical forecast was within ${Math.round(backtest.errorPercent)}% of actual sales; busy covered ${backtest.busyCoveredWeeks} of ${backtest.scoredWeeks} weeks with sales.`
}

/** What a screen reader gets in place of the chart.
 *
 * The horizon totals come from `revenue`, not from adding the daily busy
 * values up: busy is pooled over the whole horizon, so summing the days would
 * read higher than the figure printed above the chart.
 */
export function chartSummary(
  series: MenuForecast["series"],
  revenue: MenuForecast["revenue"],
  horizonStart: string
): string {
  const history = series.filter((row) => row.date < horizonStart)
  const actual = history.reduce(
    (total, row) => total + (row.actualCents ?? 0),
    0
  )
  const horizonDays = series.length - history.length
  const currencyCode = revenue.currencyCode
  return `${formatWholeCents(actual, currencyCode)} of actual sales over the last ${history.length} days, then ${horizonDays} projected days: ${formatWholeCents(revenue.typicalCents, currencyCode)} typical, up to ${formatWholeCents(revenue.busyCents, currencyCode)} busy.`
}
