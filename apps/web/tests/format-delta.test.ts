import { describe, expect, it } from "vitest"

import { formatSignedCents } from "@/lib/format-delta"

describe("formatSignedCents", () => {
  it("marks a gain with a plus", () => {
    expect(formatSignedCents(120400)).toBe("+$1,204")
  })

  it("draws a real minus, not a hyphen", () => {
    expect(formatSignedCents(-3800)).toBe("−$38")
    expect(formatSignedCents(-3800)).not.toContain("-")
  })

  it("leaves zero unsigned", () => {
    expect(formatSignedCents(0)).toBe("$0")
  })

  it("follows the workspace currency", () => {
    expect(formatSignedCents(120400, "EUR")).toBe("+€1,204")
  })

  it.each([
    [1, "USD", "+$0.01"],
    [-1, "USD", "−$0.01"],
    [-38, "USD", "−$0.38"],
    [0, "USD", "$0.00"],
    [-0, "USD", "$0.00"],
    [120438, "EUR", "+€1,204.38"],
    [-38, "EUR", "−€0.38"],
  ])("preserves exact cost delta %s in %s", (cents, currency, expected) => {
    expect(formatSignedCents(cents, currency, "cents")).toBe(expected)
  })
})
