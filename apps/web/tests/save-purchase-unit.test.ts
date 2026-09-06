import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  disconnectInvoiceItem,
  linkInvoiceItem,
  saveIngredient,
  applyInvoicePrice,
} = vi.hoisted(() => ({
  disconnectInvoiceItem: vi.fn(),
  linkInvoiceItem: vi.fn(),
  saveIngredient: vi.fn(),
  applyInvoicePrice: vi.fn(),
}))

vi.mock("@/app/(app)/ingredients/actions", () => ({
  disconnectInvoiceItem,
  linkInvoiceItem,
  saveIngredient,
  applyInvoicePrice,
}))

import {
  parsePurchaseUnit,
  savePurchaseUnit,
} from "@/lib/ingredients/save-purchase-unit"

describe("parsePurchaseUnit", () => {
  it("reads a blank size as one of the unit, the way the field shows it", () => {
    expect(
      parsePurchaseUnit({
        cost: "4.99",
        size: "",
        unit: "lb",
        yieldPercent: "100",
      })
    ).toEqual({
      purchaseCostCents: 499,
      purchaseSize: 1,
      purchaseUnit: "lb",
      yieldPercent: 100,
    })
  })

  it("keeps a typed size", () => {
    expect(
      parsePurchaseUnit({
        cost: "12",
        size: "2.5",
        unit: "kg",
        yieldPercent: "100",
      })?.purchaseSize
    ).toBe(2.5)
  })

  it("carries the typed yield, and reads a blank one as a full 100", () => {
    expect(
      parsePurchaseUnit({
        cost: "10",
        size: "10 lb",
        unit: "lb",
        yieldPercent: "90",
      })?.yieldPercent
    ).toBe(90)
    expect(
      parsePurchaseUnit({
        cost: "10",
        size: "10",
        unit: "lb",
        yieldPercent: "",
      })?.yieldPercent
    ).toBe(100)
    // A refusable value travels as typed rather than being rounded into 100,
    // so the action says no instead of quietly saving something else.
    expect(
      parsePurchaseUnit({
        cost: "10",
        size: "10",
        unit: "lb",
        yieldPercent: "0",
      })?.yieldPercent
    ).toBe(0)
  })

  it("has nothing to send without a cost or a unit", () => {
    expect(
      parsePurchaseUnit({
        cost: "",
        size: "1",
        unit: "lb",
        yieldPercent: "100",
      })
    ).toBeNull()
    expect(
      parsePurchaseUnit({
        cost: "4",
        size: "1",
        unit: null,
        yieldPercent: "100",
      })
    ).toBeNull()
  })
})

describe("savePurchaseUnit with a disconnect", () => {
  beforeEach(() => {
    disconnectInvoiceItem.mockReset()
    saveIngredient.mockReset()
  })

  const disconnecting = {
    id: "ing-1",
    unit: {
      cost: "9.99",
      size: "5",
      unit: "lb",
      yieldPercent: "100",
      invoiceLineId: null,
      disconnectInvoicePriceId: "price-1",
    },
  }

  it("drops only the named invoice price", async () => {
    disconnectInvoiceItem.mockResolvedValue({ ok: true, editVersion: 8 })

    expect(await savePurchaseUnit(disconnecting)).toEqual({
      ok: true,
      editVersion: 8,
    })
    expect(saveIngredient).not.toHaveBeenCalled()
    expect(disconnectInvoiceItem).toHaveBeenCalledWith("ing-1", "price-1")
  })

  it("drops the link on its own when there is nothing to price", async () => {
    disconnectInvoiceItem.mockResolvedValue({ ok: true, editVersion: 8 })

    expect(
      await savePurchaseUnit({
        ...disconnecting,
        unit: { ...disconnecting.unit, cost: "", unit: null },
      })
    ).toEqual({ ok: true, editVersion: 8 })
    expect(saveIngredient).not.toHaveBeenCalled()
    expect(disconnectInvoiceItem).toHaveBeenCalledWith("ing-1", "price-1")
  })

  it("keeps the exact disconnect failure", async () => {
    disconnectInvoiceItem.mockResolvedValue({
      error: "Invoice price not found",
    })

    expect(await savePurchaseUnit(disconnecting)).toEqual({
      error: "Invoice price not found",
    })
  })
})

describe("savePurchaseUnit with invoice prices", () => {
  beforeEach(() => {
    applyInvoicePrice.mockReset()
    disconnectInvoiceItem.mockReset()
    linkInvoiceItem.mockReset()
    saveIngredient.mockReset()
  })

  it("adds a price reference without changing active costing", async () => {
    linkInvoiceItem.mockResolvedValue({ ok: true, editVersion: 4 })

    const result = await savePurchaseUnit({
      id: "ing-1",
      unit: {
        cost: "46.60",
        size: "180",
        unit: "each",
        yieldPercent: "100",
        invoiceLineId: "line-1",
        invoicePurchaseSize: "12",
        invoicePurchaseUnit: "each",
      },
    })

    expect(result).toEqual({ ok: true, editVersion: 4 })
    expect(linkInvoiceItem).toHaveBeenCalledWith("ing-1", "line-1", {
      purchaseSize: 12,
      purchaseUnit: "each",
    })
    expect(saveIngredient).not.toHaveBeenCalled()
  })

  it("uses a connected price only through the explicit action", async () => {
    applyInvoicePrice.mockResolvedValue({ ok: true, editVersion: 5 })

    const result = await savePurchaseUnit({
      id: "ing-1",
      unit: {
        cost: "5.98",
        size: "20",
        unit: "each",
        yieldPercent: "100",
        useInvoicePriceId: "price-1",
      },
    })

    expect(result).toEqual({ ok: true, editVersion: 5 })
    expect(applyInvoicePrice).toHaveBeenCalledWith("ing-1", "price-1")
    expect(saveIngredient).not.toHaveBeenCalled()
  })
})
