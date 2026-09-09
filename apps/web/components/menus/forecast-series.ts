import type { MenuForecast } from "@/lib/backend/types"
import { parseDateKey } from "@/lib/date-presets"
import { formatWholeCents } from "@/lib/money"
import { formatDayMonth, formatInZone } from "@/lib/datetime"

/**
 * The arithmetic behind the one forecast chart and the one accuracy sentence.
 * Kept out of the chart so it stays testable without a DOM.
 */

/** "Wed, Aug 9": the tooltip names the weekday, which no shared stamp does. */
function weekdayDate(date: Date) {
  return formatInZone(date, "UTC", {
    weekday: "short",
    month: "short",
    day: "numeric",
  })
}

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
      label: formatDayMonth(date, "UTC"),
      tooltipLabel: weekdayDate(date),
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
  return `Over the last ${backtest.weeks.length} weeks the typical plan landed within ${Math.round(backtest.errorPercent)}% of actual sales. The busy plan covered ${backtest.busyCoveredWeeks} of ${backtest.scoredWeeks} weeks with sales.`
}

/**
 * The shopping list's total against the sales it serves. Cost needs only a
 * pack size and a price, so it is reported even when nothing is priced for
 * sale; the share is left out when there is no sales figure to share.
 */
export function materialCostSentence(
  forecast: Pick<MenuForecast, "materialCost" | "revenue">
): string | null {
  const { materialCost, revenue } = forecast
  const total = materialCost.costedMaterials + materialCost.uncostedMaterials
  if (total === 0) return null
  const uncosted =
    materialCost.uncostedMaterials === 0
      ? ""
      : materialCost.uncostedMaterials === 1
        ? " 1 material has no pack size or price."
        : ` ${materialCost.uncostedMaterials} materials have no pack size or price.`
  if (materialCost.costedMaterials === 0)
    return `No material has a pack size and a price yet, so there is no projected ingredient cost.${uncosted}`
  const cost = formatWholeCents(materialCost.costCents, revenue.currencyCode)
  const share =
    revenue.pricedProducts > 0 && revenue.plannedCents > 0
      ? `, ${Math.round((materialCost.costCents / revenue.plannedCents) * 100)}% of projected sales.`
      : "."
  return `Projected ingredient cost ${cost}${share}${uncosted}`
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
