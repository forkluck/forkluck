import { describe, expect, it, vi } from "vitest"

vi.mock("@/app/(app)/ingredients/actions", () => ({
  searchInvoiceItems: vi.fn(),
}))

import {
  parseTypedSize,
  purchaseSizeLabel,
} from "@/components/ingredients/purchase-unit-fields"

describe("parsing a typed or invoiced size", () => {
  it("reads a number and its unit typed together", () => {
    expect(parseTypedSize("200 lb")).toEqual({ size: "200", unit: "lb" })
    expect(parseTypedSize("946ml")).toEqual({ size: "946", unit: "ml" })
    expect(parseTypedSize("12 ct")).toEqual({ size: "12", unit: "each" })
  })

  it("multiplies a compound pack out to one amount", () => {
    expect(parseTypedSize("9X3 LB")).toEqual({ size: "27", unit: "lb" })
    expect(parseTypedSize("36X1 LB")).toEqual({ size: "36", unit: "lb" })
    expect(parseTypedSize("24 X 1 PT")).toEqual({ size: "24", unit: "pt" })
  })

  it("keeps the chosen unit for a bare number", () => {
    expect(parseTypedSize("200", "lb")).toEqual({ size: "200", unit: "lb" })
    expect(parseTypedSize("200", null)).toEqual({ size: "200", unit: "" })
  })

  it("reads a bare per-piece unit as one of it", () => {
    expect(parseTypedSize("ea")).toEqual({ size: "1", unit: "each" })
    expect(parseTypedSize("each")).toEqual({ size: "1", unit: "each" })
  })

  it("is nothing for a bare weight word or empty text", () => {
    expect(parseTypedSize("lb")).toBeNull()
    expect(parseTypedSize("")).toBeNull()
    expect(parseTypedSize("  ")).toBeNull()
  })
})

describe("showing a purchase size", () => {
  it("writes one of a per-piece item as the unit alone", () => {
    expect(purchaseSizeLabel("1", "each")).toBe("ea")
  })

  it("keeps the number on a weight, and on more than one piece", () => {
    expect(purchaseSizeLabel("1", "lb")).toBe("1 lb")
    expect(purchaseSizeLabel("12", "each")).toBe("12 ea")
  })
})
