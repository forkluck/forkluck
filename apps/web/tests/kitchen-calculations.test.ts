import { describe, expect, it } from "vitest"
import {
  batchCalculationSchema,
  calculateBatchCost,
} from "@/lib/kitchen-tools/calculations"

const input = batchCalculationSchema.parse({
  portions: 24,
  ingredientCostPerBatch: 18,
  packagingCostPerPortion: 0.25,
  sellingPricePerPortion: 2.5,
  currencyCode: "USD",
})
describe("hypothetical batch calculations", () => {
  it("distinguishes per-batch and per-portion costs, margin and markup", () => {
    const result = calculateBatchCost(input)
    expect(result.baseline).toEqual({
      ingredientCostPerPortion: 0.75,
      variableCostPerPortion: 1,
      contributionPerPortion: 1.5,
      marginPercent: 60,
      markupPercent: 150,
    })
    expect(result.hypothetical).toBe(true)
    expect(result.assumptions).toEqual(input)
  })
  it("retains the original margin after an ingredient increase and rounds the price up", () => {
    const result = calculateBatchCost({ ...input, ingredientChangePercent: 20 })
    expect(result.scenario).toEqual({
      ingredientCostPerPortion: 0.9,
      variableCostPerPortion: 1.15,
      targetMarginPercent: 60,
      exactSellingPrice: 2.875,
      minimumSellingPrice: 2.88,
    })
  })
  it.each([
    ["JPY", 3],
    ["USD", 2.88],
    ["KWD", 2.875],
  ])("respects %s minor-unit precision", (currencyCode, minimum) => {
    expect(
      calculateBatchCost({
        ...input,
        ingredientChangePercent: 20,
        currencyCode,
      }).scenario.minimumSellingPrice
    ).toBe(minimum)
  })
  it("includes only explicitly supplied other costs and supports an explicit target margin", () => {
    const result = calculateBatchCost({
      ...input,
      otherCostPerBatch: 12,
      targetMarginPercent: 50,
    })
    expect(result.baseline.variableCostPerPortion).toBe(1.5)
    expect(result.scenario.exactSellingPrice).toBe(3)
  })
  it("does not invent a selling price or profitability when only costs are known", () => {
    const result = calculateBatchCost({
      ...input,
      sellingPricePerPortion: undefined,
    })
    expect(result.baseline.marginPercent).toBeNull()
    expect(result.baseline.markupPercent).toBeNull()
    expect(result.scenario.exactSellingPrice).toBeNull()
  })
  it("handles zero costs and declining costs without undefined arithmetic", () => {
    const result = calculateBatchCost({
      ...input,
      ingredientCostPerBatch: 0,
      packagingCostPerPortion: 0,
    })
    expect(result.baseline.markupPercent).toBeNull()
    expect(result.scenario.exactSellingPrice).toBeNull()
    expect(
      calculateBatchCost({ ...input, ingredientChangePercent: -100 }).scenario
        .variableCostPerPortion
    ).toBe(0.25)
  })
  it.each([
    { portions: 0 },
    { ingredientCostPerBatch: -1 },
    { targetMarginPercent: 100 },
    { portions: undefined },
    { currencyCode: "USD/EUR" },
    { ingredientCostPerBatch: Infinity },
    { quantity: "2 kg", price: "5 per lb" },
  ])("rejects missing, impossible or incompatible assumptions %j", (bad) => {
    expect(batchCalculationSchema.safeParse({ ...input, ...bad }).success).toBe(
      false
    )
  })
})
