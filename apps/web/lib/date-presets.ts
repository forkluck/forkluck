export type DatePreset = {
  id: string
  label: string
  startDate: string
  endDate: string
}

/** Dates travel as `YYYY-MM-DD`; all arithmetic on them is UTC. */
export function parseDateKey(value: string) {
  const [year, month, day] = value.split("-").map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

export function dateKey(value: Date) {
  return value.toISOString().slice(0, 10)
}

export function addDays(date: string, amount: number) {
  const value = parseDateKey(date)
  value.setUTCDate(value.getUTCDate() + amount)
  return dateKey(value)
}

export function localDateKey(timeZone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(now)
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  )
  return `${values.year}-${values.month}-${values.day}`
}

export function datePresetGroups(today: string): DatePreset[][] {
  const yesterday = addDays(today, -1)
  const todayDate = parseDateKey(today)
  const quarterStart = new Date(
    Date.UTC(
      todayDate.getUTCFullYear(),
      Math.floor(todayDate.getUTCMonth() / 3) * 3,
      1
    )
  )
  return [
    [
      { id: "today", label: "Today", startDate: today, endDate: today },
      {
        id: "yesterday",
        label: "Yesterday",
        startDate: yesterday,
        endDate: yesterday,
      },
    ],
    [
      {
        id: "last_7_days",
        label: "Last 7 days",
        startDate: addDays(yesterday, -6),
        endDate: yesterday,
      },
      {
        id: "last_30_days",
        label: "Last 30 days",
        startDate: addDays(yesterday, -29),
        endDate: yesterday,
      },
    ],
    [
      {
        id: "week_to_date",
        label: "Week to date",
        startDate: addDays(today, -todayDate.getUTCDay()),
        endDate: today,
      },
      {
        id: "month_to_date",
        label: "Month to date",
        startDate: dateKey(startOfMonth(todayDate)),
        endDate: today,
      },
      {
        id: "quarter_to_date",
        label: "Quarter to date",
        startDate: dateKey(quarterStart),
        endDate: today,
      },
      {
        id: "year_to_date",
        label: "Year to date",
        startDate: `${today.slice(0, 4)}-01-01`,
        endDate: today,
      },
    ],
  ]
}

export function startOfMonth(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1))
}

export function resolveDatePreset(id: string, today: string) {
  return datePresetGroups(today)
    .flat()
    .find((preset) => preset.id === id)
}

export const PERIOD_COOKIE = "forkluck_period"

export function formatPeriodCookie(id: string, timeZone: string) {
  return `${id}|${timeZone}`
}

export function parsePeriodCookie(value: string | undefined) {
  if (!value) return null
  const separator = value.indexOf("|")
  if (separator < 1) return null
  const id = value.slice(0, separator)
  const timeZone = value.slice(separator + 1)
  if (!timeZone) return null
  return { id, timeZone }
}

export function rememberedPeriod(cookieValue: string | undefined) {
  const stored = parsePeriodCookie(cookieValue)
  if (!stored) return null
  let today: string
  try {
    today = localDateKey(stored.timeZone)
  } catch {
    return null
  }
  const preset = resolveDatePreset(stored.id, today)
  return preset
    ? { startDate: preset.startDate, endDate: preset.endDate }
    : null
}
