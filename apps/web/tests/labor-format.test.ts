import { describe, expect, it } from "vitest"

import {
  decimalHours,
  formatDecimalHours,
  formatWorkedHours,
} from "../components/labor/labor-format"
import { currencySymbol } from "../lib/business-settings"

describe("worked hours", () => {
  it("prints a single shift as a clock duration", () => {
    expect(formatWorkedHours(8 * 3600 + 15 * 60)).toBe("8:15")
    expect(formatWorkedHours(59.6 * 60)).toBe("1:00")
    expect(formatWorkedHours(-10)).toBe("0:00")
  })

  it("prints a total as decimal hours", () => {
    expect(formatDecimalHours(323 * 3600 + 56 * 60)).toBe("323.9")
    expect(formatDecimalHours(8 * 3600 + 30 * 60)).toBe("8.5")
    expect(formatDecimalHours(2080 * 3600)).toBe("2,080.0")
    expect(formatDecimalHours(-10)).toBe("0.0")
  })

  it("keeps the unrounded value for payroll exports", () => {
    expect(decimalHours(323 * 3600 + 56 * 60).toFixed(2)).toBe("323.93")
  })
})

describe("labor currencies", () => {
  it("uses the workspace currency symbol in rate inputs", () => {
    expect(currencySymbol("USD")).toBe("$")
    expect(currencySymbol("EUR")).toBe("€")
    expect(currencySymbol("GBP")).toBe("£")
  })
})
