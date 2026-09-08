import { describe, expect, it } from "vitest"

import {
  formatCalendarDate,
  formatCalendarDayMonth,
  formatDateTime,
  formatDayMonth,
  formatDayMonthTime,
  formatFullDate,
  formatInZone,
  formatMonthYear,
  formatZoneOffset,
} from "@/lib/datetime"

// 2026-08-23T02:30Z is still 2026-08-22 in New York: the case that used to
// render one day on the server and another in the browser.
const ACROSS_MIDNIGHT = new Date("2026-08-23T02:30:00Z")

describe("zone-pinned formatters", () => {
  it("reads the same instant as a different day in each zone", () => {
    expect(formatDayMonth(ACROSS_MIDNIGHT, "UTC")).toBe("Aug 23")
    expect(formatDayMonth(ACROSS_MIDNIGHT, "America/New_York")).toBe("Aug 22")
  })

  it("does not depend on the runtime's own zone", () => {
    const asked = formatDateTime(ACROSS_MIDNIGHT, "Asia/Tokyo")
    expect(asked).toBe(formatDateTime(ACROSS_MIDNIGHT, "Asia/Tokyo"))
    expect(asked).not.toBe(formatDateTime(ACROSS_MIDNIGHT, "UTC"))
  })

  it("prints every stamp in one locale, on one clock", () => {
    expect(formatFullDate(ACROSS_MIDNIGHT, "UTC")).toBe("Aug 23, 2026")
    expect(formatDayMonthTime(ACROSS_MIDNIGHT, "UTC")).toBe("Aug 23, 2:30 AM")
    expect(formatDayMonthTime(ACROSS_MIDNIGHT, "America/New_York")).toBe(
      "Aug 22, 10:30 PM"
    )
    expect(formatDateTime(ACROSS_MIDNIGHT, "UTC")).toBe("Aug 23, 2026, 2:30 AM")
    expect(formatMonthYear(Date.UTC(2026, 7, 1))).toBe("August 2026")
  })

  it("reads a calendar date as the day it names, in any runtime zone", () => {
    expect(formatCalendarDayMonth("2026-08-09")).toBe("Aug 9")
    expect(formatCalendarDate("2026-08-09")).toBe("Aug 9, 2026")
    expect(formatCalendarDayMonth(null)).toBe("—")
    expect(formatCalendarDate(null)).toBe("—")
  })

  it("names the offset a zone is on", () => {
    expect(formatZoneOffset("America/New_York", ACROSS_MIDNIGHT)).toBe("GMT-4")
    expect(formatZoneOffset("UTC", ACROSS_MIDNIGHT)).toBe("GMT+0")
  })

  it("falls back to UTC for a zone this build cannot resolve", () => {
    expect(
      formatInZone(ACROSS_MIDNIGHT, "Mars/Olympus_Mons", { day: "numeric" })
    ).toBe(formatInZone(ACROSS_MIDNIGHT, "UTC", { day: "numeric" }))
  })
})
