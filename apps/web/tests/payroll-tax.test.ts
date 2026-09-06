import { describe, expect, it } from "vitest"

import {
  STATE_UNEMPLOYMENT,
  US_FEDERAL,
  estimateBurden,
  unpaidBreakSeconds,
} from "@/lib/payroll-tax"

const NEW_YORK = STATE_UNEMPLOYMENT.find((row) => row.code === "NY")!

describe("estimateBurden", () => {
  it("prorates a capped tax instead of adding its headline rate", () => {
    // New York 2026: 4.1% charged on the first $17,600 of a $44,000 year is
    // 40% of that person's wages, so it costs 1.64% of payroll — not 4.1%.
    // Adding the headline rate would overstate the burden by two and a half
    // times, which is the whole reason this function exists.
    const burden = estimateBurden({
      stateRatePercent: NEW_YORK.newEmployerRatePercent,
      stateWageBase: NEW_YORK.wageBase,
      annualWage: 44_000,
    })

    expect(burden.stateUnemploymentPercent).toBeCloseTo(1.64, 5)
    expect(burden.ficaPercent).toBeCloseTo(7.65, 5)
    // FUTA: 0.6% on the first $7,000 of $44,000.
    expect(burden.futaPercent).toBeCloseTo(0.0954545, 5)
    expect(burden.totalPercent).toBe(9.39)
  })

  it("charges a capped tax in full when the year never reaches the cap", () => {
    // A part-timer earning less than every wage base pays every rate on all
    // of their wages, so nothing is prorated and the rates simply add up.
    const burden = estimateBurden({
      stateRatePercent: 4.1,
      stateWageBase: 17_600,
      annualWage: 6_000,
    })

    expect(burden.futaPercent).toBeCloseTo(US_FEDERAL.futaPercent, 5)
    expect(burden.stateUnemploymentPercent).toBeCloseTo(4.1, 5)
    expect(burden.totalPercent).toBe(12.35)
  })

  it("falls toward the uncapped rates as the annual wage climbs", () => {
    const modest = estimateBurden({
      stateRatePercent: 4.1,
      stateWageBase: 17_600,
      annualWage: 30_000,
    })
    const high = estimateBurden({
      stateRatePercent: 4.1,
      stateWageBase: 17_600,
      annualWage: 120_000,
    })

    expect(high.totalPercent).toBeLessThan(modest.totalPercent)
    // Social Security and Medicare are flat on a kitchen wage, so the burden
    // approaches 7.65% from above and never crosses it.
    expect(high.totalPercent).toBeGreaterThan(7.65)
  })

  it("reads a zero or missing wage as no capped tax rather than dividing by it", () => {
    const burden = estimateBurden({
      stateRatePercent: 4.1,
      stateWageBase: 17_600,
      annualWage: 0,
    })

    expect(burden.futaPercent).toBe(0)
    expect(burden.stateUnemploymentPercent).toBe(0)
    expect(burden.totalPercent).toBe(7.65)
  })
})

/**
 * These mirror `unpaid_break_seconds_for` in
 * `apps/api/forkluck/domains/shared/labor_policy.py`. The rule is written twice
 * — once to cost a shift, once to preview the deduction before saving — so the
 * two need parity cases on the same block boundaries.
 */
describe("unpaidBreakSeconds", () => {
  it("is off when no minutes are set", () => {
    expect(unpaidBreakSeconds(8 * 3600, 0, 8)).toBe(0)
  })

  it("deducts on whole completed blocks only", () => {
    // The four-hour lunch shift nobody took a meal break on.
    expect(unpaidBreakSeconds(4 * 3600, 30, 8)).toBe(0)
    expect(unpaidBreakSeconds(8 * 3600 - 1, 30, 8)).toBe(0)
    expect(unpaidBreakSeconds(8 * 3600, 30, 8)).toBe(30 * 60)
    expect(unpaidBreakSeconds(15 * 3600, 30, 8)).toBe(30 * 60)
    expect(unpaidBreakSeconds(16 * 3600, 30, 8)).toBe(60 * 60)
  })

  it("never takes more than the shift itself", () => {
    // A deduction longer than the block it applies to would otherwise drive
    // payable time negative and pay the kitchen to open.
    expect(unpaidBreakSeconds(2 * 3600, 480, 1)).toBe(2 * 3600)
  })
})
