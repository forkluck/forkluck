import { describe, expect, it } from "vitest"

import {
  DEFAULT_BUSINESS_SETTINGS,
  preferredWeightUnit,
  resolveFoodCostTarget,
  resolveOvertimeWeeklyMinutes,
  resolveProductMatching,
} from "../lib/business-settings"
import {
  displayWeight,
  formatWeight,
  toGrams,
  weightInputFromGrams,
} from "../lib/units"

describe("preferredWeightUnit", () => {
  it("defaults the workspace food cost target to 30%", () => {
    expect(DEFAULT_BUSINESS_SETTINGS.foodCostTarget).toBe(0.3)
    expect(resolveFoodCostTarget(undefined)).toBe(0.3)
    expect(resolveFoodCostTarget(Number.NaN)).toBe(0.3)
  })

  it("defaults the weekly overtime threshold to forty hours", () => {
    expect(DEFAULT_BUSINESS_SETTINGS.overtimeWeeklyMinutes).toBe(2400)
    expect(resolveOvertimeWeeklyMinutes(undefined)).toBe(2400)
    expect(resolveOvertimeWeeklyMinutes(Number.NaN)).toBe(2400)
    expect(resolveOvertimeWeeklyMinutes("2250")).toBe(2400)
  })

  it("keeps a threshold inside an hour and a full week", () => {
    expect(resolveOvertimeWeeklyMinutes(2250)).toBe(2250)
    expect(resolveOvertimeWeeklyMinutes(60)).toBe(60)
    expect(resolveOvertimeWeeklyMinutes(10080)).toBe(10080)
    expect(resolveOvertimeWeeklyMinutes(59)).toBe(2400)
    expect(resolveOvertimeWeeklyMinutes(10081)).toBe(2400)
    expect(resolveOvertimeWeeklyMinutes(2400.5)).toBe(2400)
  })

  it("uses kilograms for metric workspaces", () => {
    expect(preferredWeightUnit("metric")).toBe("kg")
  })

  it("uses pounds for US customary workspaces", () => {
    expect(preferredWeightUnit("us")).toBe("lb")
  })
})

describe("measurement conversion", () => {
  it("uses exact international mass conversions", () => {
    expect(toGrams(1, "lb")).toBe(453.59237)
    expect(toGrams(1, "oz")).toBe(28.349523125)
  })

  it("chooses a readable unit in the preferred system", () => {
    expect(displayWeight(250, "metric")).toEqual({ amount: 250, unit: "g" })
    expect(displayWeight(1000, "metric")).toEqual({ amount: 1, unit: "kg" })
    expect(displayWeight(226.796185, "us")).toEqual({ amount: 8, unit: "oz" })
    expect(displayWeight(453.59237, "us")).toEqual({ amount: 1, unit: "lb" })
  })

  it("formats existing packs in the selected system", () => {
    expect(formatWeight(1000, "metric", { amount: 1, unit: "kg" })).toBe("1 kg")
    expect(formatWeight(1000, "us", { amount: 1, unit: "kg" })).toBe("2.205 lb")
  })

  it("creates editable values in the preferred system", () => {
    expect(weightInputFromGrams(1000, "us")).toEqual({
      amount: "2.204623",
      unit: "lb",
    })
  })
})

describe("resolveProductMatching", () => {
  it("reads a payload without the key as on", () => {
    // getBusinessSettings is an unvalidated cast, so a backend predating the
    // field yields undefined. Defaulting that to off would show every merchant
    // a switch disagreeing with what their workspace is actually doing.
    expect(resolveProductMatching(undefined)).toBe(true)
    expect(resolveProductMatching(null)).toBe(true)
  })

  it("honours an explicit choice", () => {
    expect(resolveProductMatching(false)).toBe(false)
    expect(resolveProductMatching(true)).toBe(true)
  })
})
