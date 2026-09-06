import { describe, expect, it } from "vitest"

import { invoiceDetailHref, invoiceListHref } from "@/lib/invoice-navigation"

describe("invoice navigation", () => {
  it("carries the complete invoices list query into a receipt URL", () => {
    expect(
      invoiceDetailHref("inv_vxcqj4tzm4qs", "/invoices?month=2026-07&q=wegmans")
    ).toBe(
      "/invoices/inv_vxcqj4tzm4qs?returnTo=%2Finvoices%3Fmonth%3D2026-07%26q%3Dwegmans"
    )
  })

  it("keeps the ordinary receipt URL clean for the default list", () => {
    expect(invoiceDetailHref("inv_vxcqj4tzm4qs", "/invoices")).toBe(
      "/invoices/inv_vxcqj4tzm4qs"
    )
  })

  it.each([
    undefined,
    "https://example.com/invoices?month=2026-07",
    "//example.com/invoices",
    "/invoices/inv_1",
    "/recipes",
  ])("falls back for an unsafe return destination: %s", (value) => {
    expect(invoiceListHref(value)).toBe("/invoices")
  })

  it("restores a local invoices query and drops fragments", () => {
    expect(invoiceListHref("/invoices?month=2026-07#lines")).toBe(
      "/invoices?month=2026-07"
    )
  })
})
