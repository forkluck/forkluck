import { describe, expect, it } from "vitest"

import {
  comparisonLabel,
  comparisonNoun,
  comparisonPeriod,
  laborComparisonOptions,
  periodLength,
  salesComparisonOptions,
  type Comparison,
} from "@/lib/period-comparison"

// These cover the noun for every mode so each stays truthful to what the
// backend resolves in apps/api/forkluck/domains/shared/periods.py, across
// single-day, multi-day, and leap-spanning ranges. Three past bugs live here as
// regressions: `prior_day` once read "prior day" though a range compares
// against the prior full-length period; `prior_year` once claimed "same date
// last year" though a range spanning 29 Feb drifts a day off the calendar date
// once the range length is preserved; and `fifty_two_weeks_prior` must remain
// neutral because long ranges shift farther back to avoid overlap.
describe("comparisonNoun", () => {
  it("describes prior_day as the prior period, not the prior day", () => {
    // trend_comparison_start subtracts the whole period length for prior_day,
    // so a multi-day range compares against the prior full-length period.
    expect(comparisonNoun("prior_day")).toBe("prior period")
    expect(comparisonNoun("prior_day")).not.toBe("prior day")
  })

  it("keeps every mode's noun truthful to what the backend computes", () => {
    const expected: Record<Comparison, string> = {
      prior_day: "prior period",
      prior_week: "prior matching weekdays",
      prior_sunday: "prior Sunday",
      four_weeks_prior: "4 weeks prior",
      fifty_two_weeks_prior: "previous comparable period",
      prior_year: "previous year",
    }
    for (const comparison of Object.keys(expected) as Comparison[]) {
      expect(comparisonNoun(comparison)).toBe(expected[comparison])
    }
  })

  it("stays in step with comparisonLabel's neutral default for prior_day", () => {
    expect(comparisonLabel("prior_day")).toBe("Previous period")
    expect(comparisonNoun("prior_day")).toBe("prior period")
  })

  it("keeps prior_year neutral so it can't over-claim a leap-spanning range", () => {
    // The backend anchors the range start on last year's calendar date and
    // preserves the range length, so a range crossing 29 Feb no longer lands
    // on the same date for every day; the noun must not promise "same date".
    expect(comparisonNoun("prior_year")).toBe("previous year")
    expect(comparisonNoun("prior_year")).not.toBe("same date last year")
  })

  it("stays in step with comparisonLabel's neutral previous-year label", () => {
    expect(comparisonLabel("prior_year")).toBe("Previous year")
    expect(comparisonNoun("prior_year")).toBe("previous year")
  })

  it("keeps fifty_two_weeks_prior neutral for shifted long ranges", () => {
    expect(comparisonNoun("fifty_two_weeks_prior")).toBe(
      "previous comparable period"
    )
    expect(comparisonLabel("fifty_two_weeks_prior")).toBe(
      "Previous comparable period"
    )
  })
})

describe("comparisonPeriod", () => {
  it.each([
    ["2025-01-01", "2025-12-31", "2024-01-02", "2024-12-31"],
    ["2024-01-01", "2024-12-31", "2022-12-31", "2023-12-31"],
  ])(
    "keeps a full-year 52-week comparison equal-length and non-overlapping",
    (start, end, comparisonStart, comparisonEnd) => {
      expect(comparisonPeriod(start, end, "fifty_two_weeks_prior")).toEqual([
        comparisonStart,
        comparisonEnd,
      ])
    }
  )
})

/**
 * `prior_week` — Labor's weekday-aligned replacement for `prior_day`.
 *
 * These are the TypeScript half of
 * `apps/api/forkluck/test_periods.py::PriorWeekWindowTests`: the same inputs,
 * the same dates. 17 Aug 2026 is a Monday.
 */
describe("prior_week", () => {
  const MONDAY = "2026-08-17"

  it("compares a Mon–Tue range against the Monday before, not the weekend", () => {
    // The reported bug: stepping back by the range length lands on Sat–Sun,
    // and labor read against a weekend is a swing that never happened.
    expect(comparisonPeriod(MONDAY, "2026-08-18", "prior_week")).toEqual([
      "2026-08-10",
      "2026-08-11",
    ])
    expect(comparisonPeriod(MONDAY, "2026-08-18", "prior_day")).toEqual([
      "2026-08-15",
      "2026-08-16",
    ])
  })

  it.each([
    ["2026-08-23", 7],
    ["2026-08-30", 14],
    ["2026-09-06", 21],
  ])(
    "resolves a whole-week range exactly as prior_day did (%s)",
    (end, expectedDays) => {
      // Why dropping prior_day from Labor loses nothing: on a whole number of
      // weeks the two comparisons are the same dates.
      expect(periodLength(MONDAY, end)).toBe(expectedDays)
      expect(comparisonPeriod(MONDAY, end, "prior_week")).toEqual(
        comparisonPeriod(MONDAY, end, "prior_day")
      )
    }
  )

  it("steps back whole weeks for a range longer than one", () => {
    // Ten days needs two weeks of shift to clear the current period.
    expect(comparisonPeriod(MONDAY, "2026-08-26", "prior_week")).toEqual([
      "2026-08-03",
      "2026-08-12",
    ])
    // Eight days is the tightest such case: a naive seven-day shift would end
    // on the current period's own first day.
    expect(comparisonPeriod(MONDAY, "2026-08-24", "prior_week")).toEqual([
      "2026-08-03",
      "2026-08-10",
    ])
  })

  it("stays aligned, equal-length and clear at every range length", () => {
    // comparisonPeriod's overlap correction subtracts days rather than weeks,
    // so it would quietly undo the alignment if it ever ran; rounding the
    // shift up to a whole week is what keeps it from running at all.
    const start = new Date(Date.UTC(2026, 7, 17))
    for (let days = 1; days <= 60; days += 1) {
      const end = new Date(start)
      end.setUTCDate(end.getUTCDate() + days - 1)
      const endKey = end.toISOString().slice(0, 10)
      const [comparisonStart, comparisonEnd] = comparisonPeriod(
        MONDAY,
        endKey,
        "prior_week"
      )
      expect(new Date(`${comparisonStart}T00:00:00Z`).getUTCDay()).toBe(
        start.getUTCDay()
      )
      expect(periodLength(comparisonStart, comparisonEnd)).toBe(days)
      expect(comparisonEnd < MONDAY).toBe(true)
    }
  })

  it("is labelled for the pill, which prints the dates beside it", () => {
    expect(comparisonLabel("prior_week")).toBe("Previous week")
  })
})

describe("the comparisons each surface offers", () => {
  it("gives Labor only weekday-aligned comparisons", () => {
    // A calendar-date step back is what produced the Mon–Tue vs Sat–Sun read,
    // so neither of the two that do it belongs on Labor.
    expect(laborComparisonOptions).toEqual([
      "prior_week",
      "four_weeks_prior",
      "fifty_two_weeks_prior",
    ])
    expect(laborComparisonOptions).not.toContain("prior_day")
    expect(laborComparisonOptions).not.toContain("prior_year")
  })

  it("leaves Analytics its calendar-date comparisons", () => {
    // Sales genuinely move with holidays and month-ends, so same-date is
    // meaningful there even when the weekdays do not line up.
    expect(salesComparisonOptions).toEqual([
      "prior_day",
      "prior_year",
      "fifty_two_weeks_prior",
    ])
  })

  it("keeps every offered comparison resolvable", () => {
    // The option lists diverge; the vocabulary behind them does not.
    for (const option of [
      ...laborComparisonOptions,
      ...salesComparisonOptions,
    ]) {
      const [start, end] = comparisonPeriod("2026-08-17", "2026-08-23", option)
      expect(periodLength(start, end)).toBe(7)
      expect(start < "2026-08-17").toBe(true)
    }
  })
})
