import { describe, expect, it } from "vitest"

import {
  invoiceLinePackPriceCents,
  resolveInvoiceLinePack,
} from "@/lib/invoice-line-cost"

describe("saved invoice line cost suggestions", () => {
  it("reads a catch-weight unit as one priced unit", () => {
    expect(resolveInvoiceLinePack({ unit: "LB", packSize: "" })).toMatchObject({
      amount: 1,
      unit: "lb",
      catchWeight: true,
    })
  })

  it("reads a container from its printed pack size", () => {
    expect(
      resolveInvoiceLinePack({ unit: "CS", packSize: "24 X 1 LB" })
    ).toMatchObject({ amount: 24, unit: "lb", catchWeight: false })
    expect(resolveInvoiceLinePack({ unit: "CS", packSize: "" })).toBeNull()
  })

  it("prefers unit price and otherwise divides the extended amount", () => {
    expect(
      invoiceLinePackPriceCents({
        quantity: 10,
        unitPriceCents: 3019,
        lineAmountCents: 30190,
      })
    ).toBe(3019)
    expect(
      invoiceLinePackPriceCents({
        quantity: 10,
        unitPriceCents: null,
        lineAmountCents: 30190,
      })
    ).toBe(3019)
  })

  it("treats a receipt line without quantity as one purchase", () => {
    expect(
      invoiceLinePackPriceCents({
        quantity: null,
        unitPriceCents: null,
        lineAmountCents: 649,
      })
    ).toBe(649)
  })
})
