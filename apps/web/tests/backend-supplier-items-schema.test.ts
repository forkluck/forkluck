import { describe, expect, it } from "vitest"

import {
  supplierItemIgnoresPayloadSchema,
  supplierItemsPayloadSchema,
} from "@/lib/backend/schemas"

const item = {
  id: "item-1",
  supplier: "baldor",
  supplierName: "Baldor",
  externalId: "DABUT11",
  hasCode: true,
  title: "Butter, unsalted 36X1 LB",
  rawSize: "36X1 LB",
  packPriceCents: 12450,
  packAmount: 16.33,
  packUnit: "kg",
  ingredientId: "ing-1",
  ingredientName: "Butter",
  isPreferred: true,
  timesSeen: 7,
  lastInvoiceDate: "2026-08-09",
}

const ignored = {
  id: "ignore-1",
  supplier: "arrow-linen",
  supplierName: "Arrow Linen",
  externalId: "LINEN-SVC",
  hasCode: true,
  title: "Linen service",
  rawSize: "",
}

describe("the supplier items payload", () => {
  it("reads a pack the workspace remembers", () => {
    const parsed = supplierItemsPayloadSchema.parse({ items: [item], total: 1 })

    expect(parsed.items[0]).toMatchObject({ packUnit: "kg", timesSeen: 7 })
  })

  it("reads the ignored tab's shorter rows", () => {
    const parsed = supplierItemIgnoresPayloadSchema.parse({
      items: [ignored],
      total: 1,
    })

    expect(parsed.items[0]).not.toHaveProperty("packUnit")
    expect(() =>
      supplierItemsPayloadSchema.parse({ items: [ignored], total: 1 })
    ).toThrow()
  })

  it("refuses a pack row that lost its pack", () => {
    expect(() =>
      supplierItemsPayloadSchema.parse({
        items: [{ ...item, packUnit: undefined }],
        total: 1,
      })
    ).toThrow()
  })
})
