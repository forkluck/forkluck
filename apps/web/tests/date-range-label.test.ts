import { describe, expect, it } from "vitest"

import { datePresetGroups } from "../lib/date-presets"
import { formatDateRangeLabel, resolvePeriod } from "../lib/date-range-label"

describe("formatDateRangeLabel", () => {
  it("writes a single day in full", () => {
    expect(formatDateRangeLabel("2025-07-20", "2025-07-20")).toBe(
      "Jul 20, 2025"
    )
  })

  it("names the month once inside a month", () => {
    expect(formatDateRangeLabel("2026-08-07", "2026-08-10")).toBe(
      "Aug 7 – 10, 2026"
    )
  })

  it("names both months across a month boundary", () => {
    expect(formatDateRangeLabel("2026-07-28", "2026-08-03")).toBe(
      "Jul 28 – Aug 3, 2026"
    )
  })

  it("names both years across the new year", () => {
    expect(formatDateRangeLabel("2025-12-29", "2026-01-04")).toBe(
      "Dec 29, 2025 – Jan 4, 2026"
    )
  })

  it("keeps the year on a comparison a year back", () => {
    expect(formatDateRangeLabel("2025-08-01", "2025-08-07")).toBe(
      "Aug 1 – 7, 2025"
    )
  })
})

describe("resolvePeriod", () => {
  const today = "2026-09-03"

  it("resolves complete past months and years", () => {
    expect(resolvePeriod("2026-08", today)).toEqual({
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      label: "Aug 1 – 31, 2026",
    })
    expect(resolvePeriod("2025", today)).toEqual({
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      label: "Jan 1 – Dec 31, 2025",
    })
  })

  it("clamps the current month and rejects a future month", () => {
    expect(resolvePeriod("2026-09", today)).toEqual({
      startDate: "2026-09-01",
      endDate: today,
      label: "Sep 1 – 3, 2026",
    })
    expect(resolvePeriod("2026-10", today)).toBeNull()
  })

  it("resolves all eight presets", () => {
    for (const preset of datePresetGroups(today).flat()) {
      expect(resolvePeriod(preset.id, today)).toEqual({
        startDate: preset.startDate,
        endDate: preset.endDate,
        label: formatDateRangeLabel(preset.startDate, preset.endDate),
      })
    }
  })

  it("rejects ranges over 365 days and clamps a current range", () => {
    expect(resolvePeriod("2025-01-01..2026-01-02", today)).toBeNull()
    expect(resolvePeriod("2026-09-01..2026-09-30", today)).toEqual({
      startDate: "2026-09-01",
      endDate: today,
      label: "Sep 1 – 3, 2026",
    })
  })
})
