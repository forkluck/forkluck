import { describe, expect, it } from "vitest"

import { normalizeEmployeeName, parseLaborRows } from "../lib/labor-import"

const EXPORT_HEADER = [
  "Job",
  "Clocked In",
  "Clocked Out",
  "Duration",
  "Comment",
  "Breaks",
  "Adjustments",
  "TotalTimeAdjustment",
  "TotalEarningsAdjustment",
  "TotalMileage",
]

describe("parseLaborRows", () => {
  it("detects the employee and hours columns in a typical export", () => {
    const result = parseLaborRows([
      EXPORT_HEADER,
      [
        "Alex Baker",
        "6/29/26 9:34 AM",
        "6/29/26 5:04 PM",
        "7.25",
        "Prep",
        "0:30",
        "",
        "0:15",
        "$4.50",
        "",
      ],
      [
        "Jordan Cook",
        "6/30/26 8:00 AM",
        "6/30/26 12:00 PM",
        "4",
        "Service",
        "",
        "",
        "",
        "",
        "",
      ],
    ])

    expect(result.mapping.employee).toBe("Job")
    expect(result.entries).toHaveLength(2)
    expect(result.people).toHaveLength(2)
    expect(result.totalSeconds).toBe(11.25 * 3600)
    expect(result.entries[0]).toMatchObject({
      employeeName: "Alex Baker",
      clockInLocal: "2026-06-29T09:34:00",
      paidSeconds: 7.25 * 3600,
      breakSeconds: 30 * 60,
      timeAdjustmentSeconds: 15 * 60,
      earningsAdjustmentCents: 450,
      comment: "Prep",
    })
  })

  it("uses elapsed clock time when no paid-duration column exists", () => {
    const result = parseLaborRows([
      ["Team member", "Start", "End", "Notes"],
      ["Alex Baker", "2026-07-01 08:15", "2026-07-01 12:45", "Bake"],
    ])

    expect(result.mapping.duration).toBeNull()
    expect(result.entries[0].paidSeconds).toBe(4.5 * 3600)
  })

  it("supports explicit column remapping for another vendor export", () => {
    const result = parseLaborRows(
      [
        ["Person", "In time", "Out time", "Paid"],
        ["Jordan Cook", "7/1/26 1:00 PM", "7/1/26 5:00 PM", "3h 45m"],
      ],
      {
        mapping: {
          employee: "Person",
          clockIn: "In time",
          clockOut: "Out time",
          duration: "Paid",
          breaks: null,
          timeAdjustment: null,
          earningsAdjustment: null,
          comment: null,
        },
      }
    )

    expect(result.entries[0].paidSeconds).toBe(3.75 * 3600)
    expect(result.people[0].firstDate).toBe("2026-07-01")
  })

  it("holds malformed rows for review without blocking valid shifts", () => {
    const result = parseLaborRows([
      EXPORT_HEADER,
      [
        "Alex Baker",
        "not a date",
        "6/29/26 5:04 PM",
        "7",
        "",
        "",
        "",
        "",
        "",
        "",
      ],
      [
        "Jordan Cook",
        "6/30/26 8:00 AM",
        "6/30/26 12:00 PM",
        "4",
        "",
        "unpaid lunch",
        "",
        "",
        "",
        "",
      ],
      [
        "Morgan Lee",
        "7/1/26 8:00 AM",
        "7/1/26 10:00 AM",
        "2",
        "",
        "",
        "",
        "",
        "",
        "",
      ],
    ])

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].employeeName).toBe("Morgan Lee")
    expect(result.skipped.map((row) => row.reason)).toEqual([
      "Clock-in or clock-out time could not be read",
      'Break duration could not be read: "unpaid lunch"',
    ])
  })
})

// Same inputs, same outputs, as EMPLOYEE_KEY_PARITY in
// apps/api/forkluck/test_labor.py. The import preview joins this key against
// the one the backend computes, so a fold added on one side and not the
// other silently unmatches stored employees.
const EMPLOYEE_KEY_PARITY: Array<[string, string]> = [
  ["Jan Groß", "jan groß"],
  ["STRAẞE KITCHEN", "straße kitchen"],
  ["Ken﻿Smith", "ken smith"],
  ["ﬁona Quinn", "ﬁona quinn"],
  ["  Alex   Baker  ", "alex baker"],
]

describe("normalizeEmployeeName", () => {
  it("matches the backend key on the shared corpus", () => {
    for (const [written, expected] of EMPLOYEE_KEY_PARITY) {
      expect(normalizeEmployeeName(written)).toBe(expected)
    }
  })
})
