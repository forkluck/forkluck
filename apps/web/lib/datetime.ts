/**
 * Every date and time the app prints comes through here, in one locale and
 * on one clock: "Aug 9", "Aug 9, 2026", "Aug 9, 2:32 PM", "Aug 9, 2026,
 * 2:32 PM". Money is printed the same way in lib/money.ts, and the app once
 * printed "9 Aug" beside "Aug 9" on one screen, so the rule is pinned by
 * tests/datetime-pins.test.ts: no other module builds a date formatter.
 *
 * `timeZone` is required for an instant: an unpinned formatter resolves to
 * the runtime's zone, so the server and the browser disagree. A date-only
 * field ("2026-08-09") carries no zone and is read at UTC midnight.
 */
const LOCALE = "en-US"

const cache = new Map<string, Intl.DateTimeFormat>()

function formatter(
  timeZone: string,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`
  let found = cache.get(key)
  if (!found) {
    // An unresolvable zone throws; UTC beats crashing the render.
    try {
      found = new Intl.DateTimeFormat(LOCALE, { ...options, timeZone })
    } catch {
      found = new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: "UTC" })
    }
    cache.set(key, found)
  }
  return found
}

/** The base every other formatter is built on; for the odd shape (a chart
 *  axis weekday, an hour) that has no name of its own. */
export function formatInZone(
  value: Date | number,
  timeZone: string,
  options: Intl.DateTimeFormatOptions
): string {
  return formatter(timeZone, options).format(value)
}

/** A calendar date ("2026-08-09") as the instant of its UTC midnight. */
function calendarDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`)
}

/** "Aug 9" — a calendar date; "—" for none. */
export function formatCalendarDayMonth(value: string | null): string {
  if (!value) return "—"
  return formatDayMonth(calendarDate(value), "UTC")
}

/** "Aug 9, 2026" — a calendar date; "—" for none. */
export function formatCalendarDate(value: string | null): string {
  if (!value) return "—"
  return formatFullDate(calendarDate(value), "UTC")
}

/** "August 2026" — a month, read at UTC: the calendar's heading. */
export function formatMonthYear(value: Date | number): string {
  return formatInZone(value, "UTC", { month: "long", year: "numeric" })
}

/** "Aug 9" — the short stamp the list tables print under a name. */
export function formatDayMonth(value: Date | number, timeZone: string): string {
  return formatInZone(value, timeZone, { month: "short", day: "numeric" })
}

/** "Aug 9, 2026" — the long stamp. */
export function formatFullDate(value: Date | number, timeZone: string): string {
  return formatInZone(value, timeZone, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

/** "Aug 9, 2:32 PM" — a moment inside a period the screen already names. */
export function formatDayMonthTime(
  value: Date | number,
  timeZone: string
): string {
  return formatInZone(value, timeZone, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

/** "Aug 9, 2026, 2:32 PM" — a stamp that has to name the minute. */
export function formatDateTime(value: Date | number, timeZone: string): string {
  return formatInZone(value, timeZone, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

/** "GMT-4" — the offset a zone is on today; "" for a zone that has none. */
export function formatZoneOffset(zone: string, now: Date = new Date()): string {
  const parts = formatter(zone, { timeZoneName: "shortOffset" }).formatToParts(
    now
  )
  return parts.find((part) => part.type === "timeZoneName")?.value ?? ""
}
