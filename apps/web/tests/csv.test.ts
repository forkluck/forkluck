import { describe, expect, it } from "vitest"

import { csvCell } from "../lib/csv"

describe("csvCell", () => {
  it.each(["=2+3", "+SUM(A1:A2)", "-cmd", "@SUM(A1:A2)", "  =1+1", "\t=1+1"])(
    "neutralizes formula-like text: %s",
    (value) => {
      expect(csvCell(value)).toBe(`'${value}`)
    }
  )

  it("quotes escaped text after neutralizing it", () => {
    expect(csvCell('=HYPERLINK("https://example.com","x")')).toBe(
      `"'=HYPERLINK(""https://example.com"",""x"")"`
    )
  })

  it("preserves ordinary text and numeric values", () => {
    expect(csvCell("Ada Lovelace")).toBe("Ada Lovelace")
    expect(csvCell(-12.5)).toBe("-12.5")
    expect(csvCell("Ada, Lovelace", { alwaysQuote: true })).toBe(
      '"Ada, Lovelace"'
    )
  })
})
