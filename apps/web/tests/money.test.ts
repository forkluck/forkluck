import { describe, expect, it } from "vitest"

import {
  centsToDollarInput,
  dollarsToCents,
  formatCents,
  formatWholeCents,
} from "../lib/money"

describe("money display", () => {
  it("formats cents in the workspace currency", () => {
    expect(formatCents(2450)).toBe("$24.50")
    expect(formatCents(3750)).toBe("$37.50")
    expect(formatCents(3.4)).toBe("$0.03")
    expect(formatCents(2450, "EUR")).toBe("€24.50")
    expect(formatCents(100, "JPY")).toBe("¥1")
  })

  it("drops the decimals for hero figures", () => {
    expect(formatWholeCents(390_540)).toBe("$3,905")
    expect(formatWholeCents(390_560)).toBe("$3,906")
    expect(formatWholeCents(2450, "EUR")).toBe("€25")
  })

  it("falls back to a plain amount for a code Intl rejects", () => {
    expect(formatCents(100, "US$")).toBe("US$ 1.00")
    expect(formatWholeCents(2450, "US$")).toBe("US$ 25")
  })
})

describe("money entry", () => {
  it("accepts money the way people type it", () => {
    expect(dollarsToCents("24.50")).toBe(2450)
    expect(dollarsToCents("$3.46")).toBe(346)
    expect(dollarsToCents(" $3.46 ")).toBe(346)
    expect(dollarsToCents("1,234.56")).toBe(123456)
    expect(dollarsToCents("$1,234.56")).toBe(123456)
    expect(dollarsToCents(".5")).toBe(50)
    expect(dollarsToCents("3.")).toBe(300)
  })

  it("rejects input it cannot read exactly", () => {
    expect(dollarsToCents("")).toBeNull()
    expect(dollarsToCents("-3")).toBeNull()
    expect(dollarsToCents("3.46abc")).toBeNull()
    expect(dollarsToCents("abc")).toBeNull()
    expect(dollarsToCents("$")).toBeNull()
    expect(dollarsToCents(".")).toBeNull()
    expect(dollarsToCents("1.2.3")).toBeNull()
    expect(dollarsToCents("$-3")).toBeNull()
  })

  it("round-trips a stored price back into the input", () => {
    expect(centsToDollarInput(2450)).toBe("24.50")
    expect(dollarsToCents(centsToDollarInput(346))).toBe(346)
  })
})
