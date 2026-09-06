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
})
