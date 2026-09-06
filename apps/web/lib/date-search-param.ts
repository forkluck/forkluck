/**
 * Calendar query parameters, filtered down to what the Django read model reads.
 *
 * These guards are the frontend half of a contract whose other half is
 * `date.fromisoformat` and `datetime.strptime(value, "%Y-%m")` in Python, plus
 * the window rules in `resolve_labor_reporting_period` and `sales_overview`.
 * The two halves have to accept the same set: a Server Component that forwards
 * a value the backend rejects turns a 400 into an unhandled exception, and the
 * whole screen becomes "a server error occurred" rather than the fallback the
 * page already renders for a value it recognizes as unusable.
 *
 * A well-formed but impossible date is the case that keeps being missed. It
 * passes a shape check, so only a calendar check can reject it.
 */

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/
const CALENDAR_MONTH = /^\d{4}-\d{2}$/

/** `datetime.date` starts at year 1, so `0000-…` is a date Python cannot read. */
const YEAR_ZERO = /^0000-/

/** It ends at 9999-12-31, and a window's exclusive end is the day after. */
const LAST_DATE = "9999-12-31"

/** Both reports refuse a window longer than a year. */
export const MAX_RANGE_DAYS = 365

const MILLISECONDS_PER_DAY = 86_400_000

/**
 * Repeated query parameters arrive as arrays, and an array is never a date.
 * Taking the first entry would guess at which one the user meant.
 */
function singleValue(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined
}

/** Return a canonical calendar-date query parameter, if present. */
export function dateSearchParam(value: string | string[] | undefined) {
  const raw = singleValue(value)
  if (!raw || !CALENDAR_DATE.test(raw) || YEAR_ZERO.test(raw)) return undefined
  if (raw === LAST_DATE) return undefined
  const parsed = new Date(`${raw}T00:00:00Z`)
  // An out-of-range month or day parses to an Invalid Date, and calling
  // toISOString() on one throws RangeError instead of returning a string that
  // fails the round-trip below. The round-trip only sees the dates that survive
  // parsing, such as a February 30 that rolled forward into March.
  if (Number.isNaN(parsed.getTime())) return undefined
  return parsed.toISOString().slice(0, 10) === raw ? raw : undefined
}

/** Return a canonical calendar-month query parameter, if present. */
export function monthSearchParam(value: string | string[] | undefined) {
  const raw = singleValue(value)
  if (!raw || !CALENDAR_MONTH.test(raw)) return undefined
  return dateSearchParam(`${raw}-01`) ? raw : undefined
}

/**
 * Return the end of a report window, dropped when the window is not one the
 * backend will read. A range that ends before it starts is already dropped
 * rather than reported; a range longer than a year is the same kind of
 * unusable, so it is dropped the same way.
 */
export function rangeEndSearchParam(
  startDate: string | undefined,
  value: string | string[] | undefined
) {
  const endDate = dateSearchParam(value)
  if (!startDate || !endDate || endDate < startDate) return undefined
  const spanDays =
    (Date.parse(`${endDate}T00:00:00Z`) -
      Date.parse(`${startDate}T00:00:00Z`)) /
    MILLISECONDS_PER_DAY
  return spanDays > MAX_RANGE_DAYS ? undefined : endDate
}
