import { describe, expect, it } from "vitest"

import {
  formatDateTime,
  formatDayMonth,
  formatFullDate,
  formatInZone,
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

  it("prints a full date the way the catalog screens do", () => {
    expect(formatFullDate(ACROSS_MIDNIGHT, "UTC")).toBe("23 Aug 2026")
  })

  it("falls back to UTC for a zone this build cannot resolve", () => {
    expect(
      formatInZone(ACROSS_MIDNIGHT, "Mars/Olympus_Mons", { day: "numeric" })
    ).toBe(formatInZone(ACROSS_MIDNIGHT, "UTC", { day: "numeric" }))
  })
})
