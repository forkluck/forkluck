import type { Channel } from "@/components/overview/channel-filter"
import type { NetSalesTrend } from "@/lib/backend/types"
import { withLabelSteps } from "@/lib/chart-axis"
import { parseDateKey } from "@/lib/date-presets"
import { formatDayMonth, formatInZone, formatMonthYear } from "@/lib/datetime"

/**
 * The arithmetic behind the Analytics screen: what the bars are, what the
 * period adds up to, and whether prime cost can be stated at all. Kept out of
 * the cards so it stays testable on its own.
 */

// Chart axis shapes no shared stamp names: a weekday, an hour, a bare month
// or day. Each is the one base formatter over a UTC-read calendar date.
const weekday = (date: Date) => formatInZone(date, "UTC", { weekday: "short" })
const weekdayDate = (date: Date) =>
  formatInZone(date, "UTC", {
    weekday: "short",
    month: "short",
    day: "numeric",
  })
const monthShort = (date: Date) => formatInZone(date, "UTC", { month: "short" })
const dayOfMonth = (date: Date) => formatInZone(date, "UTC", { day: "numeric" })

const MAX_DAY_BARS = 31
const MAX_WEEK_BARS = 26
const WEEKDAY_LABEL_LIMIT = 7

function formatHour(hour: number) {
  return formatInZone(Date.UTC(2026, 0, 1, hour), "UTC", { hour: "numeric" })
}

function channelCents(
  point: NetSalesTrend["hours"][number] | NetSalesTrend["days"][number],
  period: "current" | "previous",
  channel: Channel
) {
  const square = point[`${period}SquareCents`]
  const shopify = point[`${period}ShopifyCents`]
  const manual = point[`${period}ManualCents`]
  if (channel === "square") return square
  if (channel === "shopify") return shopify
  return square + shopify + manual
}

export type TrendBar = {
  key: string
  label: string
  /** The hourly series is too dense to label every column. */
  showLabel: boolean
  tooltipLabel: string
  currentCents: number
  previousCents: number
}

type DayPoint = NetSalesTrend["days"][number]

function groupDays(days: DayPoint[], keyOf: (date: Date) => string) {
  const groups: Array<{ key: string; days: DayPoint[] }> = []
  for (const point of days) {
    const key = keyOf(parseDateKey(point.date))
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.days.push(point)
    else groups.push({ key, days: [point] })
  }
  return groups
}

function sumGroup(days: DayPoint[], channel: Channel) {
  return days.reduce(
    (totals, point) => ({
      currentCents:
        totals.currentCents + channelCents(point, "current", channel),
      previousCents:
        totals.previousCents + channelCents(point, "previous", channel),
    }),
    { currentCents: 0, previousCents: 0 }
  )
}

export function trendBars(trend: NetSalesTrend, channel: Channel): TrendBar[] {
  if (trend.granularity === "hour") {
    return withLabelSteps(
      trend.hours.map((point) => ({
        key: String(point.hour),
        label: formatHour(point.hour),
        tooltipLabel: formatHour(point.hour),
        currentCents: channelCents(point, "current", channel),
        previousCents: channelCents(point, "previous", channel),
      }))
    )
  }

  const days = trend.days
  if (days.length > MAX_DAY_BARS) {
    const weeksNeeded = Math.ceil(days.length / 7)
    if (weeksNeeded <= MAX_WEEK_BARS) {
      const groups: DayPoint[][] = []
      for (let index = 0; index < days.length; index += 7) {
        groups.push(days.slice(index, index + 7))
      }
      return withLabelSteps(
        groups.map((group) => {
          const start = parseDateKey(group[0].date)
          const end = parseDateKey(group[group.length - 1].date)
          return {
            key: group[0].date,
            label: formatDayMonth(start, "UTC"),
            tooltipLabel: `${formatDayMonth(start, "UTC")} – ${formatDayMonth(end, "UTC")}`,
            ...sumGroup(group, channel),
          }
        })
      )
    }

    return withLabelSteps(
      groupDays(
        days,
        (date) => `${date.getUTCFullYear()}-${date.getUTCMonth()}`
      ).map((group) => {
        const start = parseDateKey(group.days[0].date)
        return {
          key: group.key,
          label: monthShort(start),
          tooltipLabel: formatMonthYear(start),
          ...sumGroup(group.days, channel),
        }
      })
    )
  }

  const namesDays = days.length <= WEEKDAY_LABEL_LIMIT
  return withLabelSteps(
    days.map((point) => {
      const date = parseDateKey(point.date)
      return {
        key: point.date,
        label: namesDays ? weekday(date) : dayOfMonth(date),
        tooltipLabel: weekdayDate(date),
        currentCents: channelCents(point, "current", channel),
        previousCents: channelCents(point, "previous", channel),
      }
    })
  )
}

/** Period totals for the selected channel, shared with the cards beside it. */
export function periodNetSales(trend: NetSalesTrend, channel: Channel) {
  return trendBars(trend, channel).reduce(
    (totals, bar) => ({
      currentCents: totals.currentCents + bar.currentCents,
      previousCents: totals.previousCents + bar.previousCents,
    }),
    { currentCents: 0, previousCents: 0 }
  )
}

/**
 * Prime cost is labor plus purchases, so a period with no invoices in it has
 * no prime cost to state — the card says so rather than printing a labor-only
 * figure under the wrong name.
 */
export function primeCostState(financials: NetSalesTrend["financials"]) {
  if (financials.currentInvoiceCount === 0) {
    return {
      status: "incomplete" as const,
      laborCents: financials.currentLaborCents,
    }
  }

  return {
    status: "estimated" as const,
    currentCents: financials.currentLaborCents + financials.currentInvoiceCents,
  }
}

/** A prime-cost delta is meaningful only when both periods include purchases. */
export function hasPrimeCostComparison(
  financials: NetSalesTrend["financials"]
) {
  return (
    financials.currentInvoiceCount > 0 && financials.previousInvoiceCount > 0
  )
}
