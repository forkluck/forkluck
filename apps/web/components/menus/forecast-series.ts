import type { MenuForecast } from "@/lib/backend/types"
import { units } from "@/components/menus/forecast-format"
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
  actualUnits: number | null
  typicalUnits: number | null
  /** Recharts draws a ranged area from a [low, high] tuple in the data. */
  band: [number, number] | null
  isHorizon: boolean
}

export function forecastChartPoints(
  series: MenuForecast["series"],
  horizonStart: string,
  plan: MenuForecast["basis"]["plan"] = "typical"
): { points: ForecastChartPoint[]; todayLabel: string } {
  const points = series.map((row) => {
    const date = parseDateKey(row.date)
    return {
      key: row.date,
      label: formatDayMonth(date, "UTC"),
      tooltipLabel: weekdayDate(date),
      actualUnits: row.actualUnits,
      typicalUnits: row.typicalUnits,
      band:
        plan !== "busy" ||
        row.typicalUnits === null ||
        row.plannedUnits === null
          ? null
          : ([row.typicalUnits, row.plannedUnits] as [number, number]),
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
  return `Over the last ${backtest.weeks.length} weeks the typical plan’s volume-weighted error was ${Math.round(backtest.errorPercent)}% of actual units. The busy plan covered ${backtest.busyCoveredWeeks} of ${backtest.scoredWeeks} weeks with sales.`
}

/** One caption keeps planning money and missing prices in context. */
export function moneyCaption(
  forecast: Pick<MenuForecast, "materialCost" | "revenue">
): string {
  const { materialCost, revenue } = forecast
  const unpriced =
    revenue.unpricedProducts > 0
      ? ` (${revenue.unpricedProducts} ${revenue.unpricedProducts === 1 ? "product" : "products"} unpriced)`
      : ""
  const sales =
    revenue.pricedProducts > 0
      ? `Projected sales at current menu prices: ${formatWholeCents(revenue.plannedCents, revenue.currencyCode)}${unpriced}`
      : "No menu prices yet"
  const materials =
    materialCost.costedMaterials + materialCost.uncostedMaterials
  if (!materials) return `${sales}.`
  const missing =
    materialCost.uncostedMaterials > 0
      ? `; ${materialCost.uncostedMaterials} ${materialCost.uncostedMaterials === 1 ? "material needs" : "materials need"} a pack size or price`
      : ""
  if (!materialCost.costedMaterials)
    return `${sales} · Ingredient cost unavailable${missing}.`
  const share =
    revenue.pricedProducts > 0 && revenue.plannedCents > 0
      ? ` (${Math.round((materialCost.costCents / revenue.plannedCents) * 100)}% of ${revenue.unpricedProducts ? "priced " : ""}projected sales)`
      : ""
  return `${sales} · Ingredient cost: ${formatWholeCents(materialCost.costCents, revenue.currencyCode)}${share}${missing}.`
}

/** Menu history and the full production plan have explicitly named scopes. */
export function chartSummary(
  series: MenuForecast["series"],
  production: MenuForecast["production"],
  horizonStart: string
): string {
  const history = series.filter((row) => row.date < horizonStart)
  const actual = history.reduce(
    (total, row) => total + (row.actualUnits ?? 0),
    0
  )
  const horizonDays = series.length - history.length
  return `Menu items: ${units(actual)} actual units over the last ${history.length} days. Production plan across all product rows for ${horizonDays} days: ${units(production.typicalUnits)} typical, ${units(production.busyUnits)} busy, ${units(production.plannedUnits)} planned.`
}
