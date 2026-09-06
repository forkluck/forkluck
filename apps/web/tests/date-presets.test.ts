import { describe, expect, it } from "vitest"

import {
  datePresetGroups,
  formatPeriodCookie,
  localDateKey,
  parsePeriodCookie,
  rememberedPeriod,
} from "../lib/date-presets"

describe("date presets", () => {
  it("uses complete days for rolling presets and calendar starts for current periods", () => {
    const groups = datePresetGroups("2026-08-12")
    const presets = Object.fromEntries(
      groups.flat().map((preset) => [preset.id, preset])
    )

    expect(presets.last_7_days).toMatchObject({
      startDate: "2026-08-05",
      endDate: "2026-08-11",
    })
    expect(presets.last_30_days).toMatchObject({
      startDate: "2026-07-13",
      endDate: "2026-08-11",
    })
    expect(presets.week_to_date).toMatchObject({
      startDate: "2026-08-09",
      endDate: "2026-08-12",
    })
    expect(presets.month_to_date).toMatchObject({
      startDate: "2026-08-01",
      endDate: "2026-08-12",
    })
    expect(presets.quarter_to_date).toMatchObject({
      startDate: "2026-07-01",
      endDate: "2026-08-12",
    })
    expect(presets.year_to_date).toMatchObject({
      startDate: "2026-01-01",
      endDate: "2026-08-12",
    })
  })
})

describe("local date keys", () => {
  it("uses the requested timezone rather than the server's calendar date", () => {
    const instant = new Date("2026-01-01T01:30:00Z")

    expect(localDateKey("America/Los_Angeles", instant)).toBe("2025-12-31")
    expect(localDateKey("Asia/Tokyo", instant)).toBe("2026-01-01")

    // A rate change starts on the operator's day, not the server's.
    const shift = new Date("2026-08-12T02:30:00Z")
    expect(localDateKey("America/New_York", shift)).toBe("2026-08-11")
    expect(localDateKey("UTC", shift)).toBe("2026-08-12")
  })
})

describe("remembered periods", () => {
  it("round-trips a preset and timezone cookie", () => {
    const cookie = formatPeriodCookie("month_to_date", "UTC")

    expect(parsePeriodCookie(cookie)).toEqual({
      id: "month_to_date",
      timeZone: "UTC",
    })
  })

  it("rejects malformed cookie values", () => {
    expect(parsePeriodCookie(undefined)).toBeNull()
    expect(parsePeriodCookie("month_to_date")).toBeNull()
    expect(parsePeriodCookie("|UTC")).toBeNull()
    expect(parsePeriodCookie("month_to_date|")).toBeNull()
  })

  it("does not restore a period for an unknown preset or invalid timezone", () => {
    expect(rememberedPeriod("not_a_preset|UTC")).toBeNull()
    expect(rememberedPeriod("month_to_date|Not/A_Real_Timezone")).toBeNull()
  })
})
