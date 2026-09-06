import type { NetSalesTrend } from "@/lib/backend/types"
import { dateKey, parseDateKey } from "@/lib/date-presets"

export type Comparison = NetSalesTrend["comparison"]

/**
 * Analytics keeps the calendar-date comparisons. Sales genuinely move with
 * holidays and month-ends, so measuring against the same dates is meaningful
 * even when the weekdays do not line up.
 */
export const salesComparisonOptions: Comparison[] = [
  "prior_day",
  "prior_year",
  "fifty_two_weeks_prior",
]

/**
 * Labor offers only weekday-aligned comparisons. Hours and staffing follow
 * day-of-week patterns, so a calendar-date step back measures Mon–Tue against
 * a weekend and reports a swing that is nothing but the shift itself.
 */
export const laborComparisonOptions: Comparison[] = [
  "prior_week",
  "four_weeks_prior",
  "fifty_two_weeks_prior",
]

export function periodLength(startDate: string, endDate: string) {
  return (
    Math.round(
      (parseDateKey(endDate).getTime() - parseDateKey(startDate).getTime()) /
        86_400_000
    ) + 1
  )
}

export function comparisonLabel(comparison: Comparison) {
  switch (comparison) {
    case "prior_week":
      return "Previous week"
    case "prior_sunday":
      return "Prior Sunday"
    case "four_weeks_prior":
      return "4 weeks prior"
    case "fifty_two_weeks_prior":
      return "Previous comparable period"
    case "prior_year":
      return "Previous year"
    default:
      return "Previous period"
  }
}

/**
 * A concise mid-sentence phrase for the comparison, for card notes and screen
 * reader labels ("Labor cost vs previous comparable period"). Kept beside
 * `comparisonLabel` so the two stay in step. `fifty_two_weeks_prior` normally
 * starts at the same weekday 52 weeks earlier, but long ranges shift farther
 * back to remain equal-length and non-overlapping, so its wording stays
 * deliberately neutral. `prior_year` steps the whole year back (28 Feb standing in for the
 * 29th) and preserves the range length, so it is the neutral "previous year",
 * not "same date last year"—a range spanning 29 Feb slips a day off that date.
 * `prior_sunday` names only its Sunday start anchor, and `prior_day` measures
 * the prior full-length period (not yesterday) for a multi-day range, so it
 * falls through to "prior period".
 *
 * `prior_week` is the same trap once more: it steps back whole weeks, and a
 * range longer than seven days needs more than one of them, so a ten-day range
 * lands a fortnight back. The pill can still be labelled "Previous week"
 * because it prints the dates it resolved to right beside the label; this noun
 * appears alone in card badges, so it names the invariant that actually holds
 * at every length — the window covers the same weekdays.
 */
export function comparisonNoun(comparison: Comparison) {
  switch (comparison) {
    case "prior_week":
      return "prior matching weekdays"
    case "prior_sunday":
      return "prior Sunday"
    case "four_weeks_prior":
      return "4 weeks prior"
    case "fifty_two_weeks_prior":
      return "previous comparable period"
    case "prior_year":
      return "previous year"
    default:
      return "prior period"
  }
}

/** The dates a comparison resolves to, given the period it is measured against. */
export function comparisonPeriod(
  startDate: string,
  endDate: string,
  comparison: Comparison
) {
  const currentStart = parseDateKey(startDate)
  const comparisonStart = parseDateKey(startDate)
  const periodDays = periodLength(startDate, endDate)

  switch (comparison) {
    case "prior_sunday": {
      comparisonStart.setUTCDate(
        comparisonStart.getUTCDate() - comparisonStart.getUTCDay() - 7
      )
      break
    }
    case "prior_week":
      comparisonStart.setUTCDate(
        comparisonStart.getUTCDate() - Math.ceil(periodDays / 7) * 7
      )
      break
    case "four_weeks_prior":
      comparisonStart.setUTCDate(comparisonStart.getUTCDate() - 28)
      break
    case "fifty_two_weeks_prior":
      comparisonStart.setUTCDate(comparisonStart.getUTCDate() - 364)
      break
    case "prior_year": {
      const month = comparisonStart.getUTCMonth()
      comparisonStart.setUTCFullYear(comparisonStart.getUTCFullYear() - 1)
      // 29 Feb has no counterpart in a common year; fall back to the 28th
      // rather than rolling forward into March.
      if (comparisonStart.getUTCMonth() !== month) {
        comparisonStart.setUTCDate(0)
      }
      break
    }
    default:
      comparisonStart.setUTCDate(comparisonStart.getUTCDate() - periodDays)
  }

  const comparisonEnd = new Date(comparisonStart)
  comparisonEnd.setUTCDate(comparisonEnd.getUTCDate() + periodDays - 1)
  if (comparisonEnd >= currentStart) {
    const overlapDays =
      Math.round(
        (comparisonEnd.getTime() - currentStart.getTime()) / 86_400_000
      ) + 1
    comparisonStart.setUTCDate(comparisonStart.getUTCDate() - overlapDays)
    comparisonEnd.setUTCDate(comparisonEnd.getUTCDate() - overlapDays)
  }

  return [dateKey(comparisonStart), dateKey(comparisonEnd)] as const
}
