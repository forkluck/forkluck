// Instant formatters. `timeZone` is required: an unpinned Intl formatter
// resolves to the runtime's zone, so the server and the browser disagree.
// Date-only fields carry no zone — format those as `${value}T00:00:00Z` in UTC.
const cache = new Map<string, Intl.DateTimeFormat>()

function formatter(
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`
  let found = cache.get(key)
  if (!found) {
    // An unresolvable zone throws; UTC beats crashing the render.
    try {
      found = new Intl.DateTimeFormat(locale, { ...options, timeZone })
    } catch {
      found = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" })
    }
    cache.set(key, found)
  }
  return found
}

export function formatInZone(
  value: Date | number,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
  locale = "en-US"
): string {
  return formatter(locale, timeZone, options).format(value)
}

/** "9 Aug" — a calendar date ("2026-08-09") as the invoice screens print it.
 * Date-only fields carry no zone, so the value is pinned to UTC. */
export function formatCalendarDayMonth(value: string | null): string {
  if (!value) return "—"
  return formatter("en-GB", "UTC", { day: "numeric", month: "short" }).format(
    new Date(`${value}T00:00:00Z`)
  )
}

/** "Aug 9" — the short stamp the list tables print under a name. */
export function formatDayMonth(value: Date, timeZone: string): string {
  return formatInZone(value, timeZone, { month: "short", day: "numeric" })
}

/** "9 Aug 2026" — the long stamp the catalog screens print. */
export function formatFullDate(value: Date, timeZone: string): string {
  return formatInZone(
    value,
    timeZone,
    { day: "numeric", month: "short", year: "numeric" },
    "en-GB"
  )
}

/** "Aug 9, 2026, 3:05 PM" — a stamp that has to name the minute. */
export function formatDateTime(value: Date | number, timeZone: string): string {
  return formatInZone(value, timeZone, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}
