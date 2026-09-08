import { parseDateKey, resolveDatePreset } from "@/lib/date-presets"
import { dateSearchParam, rangeEndSearchParam } from "@/lib/date-search-param"
import { formatDayMonth, formatFullDate } from "@/lib/datetime"

export function formatDateRangeLabel(startDate: string, endDate: string) {
  const start = parseDateKey(startDate)
  const end = parseDateKey(endDate)
  if (startDate === endDate) return formatFullDate(end, "UTC")

  const sameYear = start.getUTCFullYear() === end.getUTCFullYear()
  if (!sameYear) {
    return `${formatFullDate(start, "UTC")} – ${formatFullDate(end, "UTC")}`
  }

  const head = formatDayMonth(start, "UTC")
  if (start.getUTCMonth() === end.getUTCMonth()) {
    return `${head} – ${end.getUTCDate()}, ${end.getUTCFullYear()}`
  }
  return `${head} – ${formatFullDate(end, "UTC")}`
}

export type ResolvedPeriod = {
  startDate: string
  endDate: string
  label: string
}

function resolved(startDate: string, endDate: string): ResolvedPeriod {
  return {
    startDate,
    endDate,
    label: formatDateRangeLabel(startDate, endDate),
  }
}

/** Resolve a short period against the kitchen's own current calendar date. */
export function resolvePeriod(
  value: string,
  today: string
): ResolvedPeriod | null {
  const period = value.trim()
  const currentDate = dateSearchParam(today)
  if (!currentDate) return null

  const preset = resolveDatePreset(period, currentDate)
  if (preset) return resolved(preset.startDate, preset.endDate)

  if (/^\d{4}$/.test(period)) {
    const startDate = dateSearchParam(`${period}-01-01`)
    if (!startDate || startDate > currentDate) return null
    const naturalEnd = dateSearchParam(`${period}-12-31`)
    if (!naturalEnd) return null
    return resolved(
      startDate,
      naturalEnd > currentDate ? currentDate : naturalEnd
    )
  }

  if (/^\d{4}-\d{2}$/.test(period)) {
    const startDate = dateSearchParam(`${period}-01`)
    if (!startDate || startDate > currentDate) return null
    const [year, month] = period.split("-").map(Number)
    const naturalEnd = new Date(Date.UTC(year, month, 0))
      .toISOString()
      .slice(0, 10)
    const endDate = naturalEnd > currentDate ? currentDate : naturalEnd
    return resolved(startDate, endDate)
  }

  const range = period.split("..")
  if (range.length === 2) {
    const startDate = dateSearchParam(range[0])
    const endDate = rangeEndSearchParam(startDate, range[1])
    if (!startDate || !endDate || startDate > currentDate) return null
    return resolved(startDate, endDate > currentDate ? currentDate : endDate)
  }

  const date = dateSearchParam(period)
  return date && date <= currentDate ? resolved(date, date) : null
}
