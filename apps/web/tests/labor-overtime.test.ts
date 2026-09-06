import { describe, expect, it } from "vitest"

import { overtimeWeekLine } from "../lib/labor/overtime"

describe("overtimeWeekLine", () => {
  it("prints the week start and the hours the table would show", () => {
    expect(
      overtimeWeekLine({ weekStart: "2026-08-09", totalSeconds: 156600 })
    ).toBe("Week of 9 Aug: 43.5")
  })

  it("rounds to the tenth of an hour the totals column uses", () => {
    expect(
      overtimeWeekLine({ weekStart: "2026-08-09", totalSeconds: 144300 })
    ).toBe("Week of 9 Aug: 40.1")
  })

  it("reads the week start in UTC, so no timezone slides it a day back", () => {
    expect(
      overtimeWeekLine({ weekStart: "2026-01-04", totalSeconds: 144000 })
    ).toBe("Week of 4 Jan: 40.0")
    expect(
      overtimeWeekLine({ weekStart: "2026-03-01", totalSeconds: 144000 })
    ).toBe("Week of 1 Mar: 40.0")
  })
})
