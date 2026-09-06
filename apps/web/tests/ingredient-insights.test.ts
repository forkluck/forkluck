import { describe, expect, it } from "vitest"

import {
  cheaperSupplierItem,
  findDuplicateIngredients,
  ingredientPriceChange,
  isIngredientStale,
} from "../lib/ingredient-insights"
import type { IngredientRow } from "../lib/backend/types"

function ingredient(overrides: Partial<IngredientRow> = {}): IngredientRow {
  const now = new Date("2026-08-07T12:00:00Z")
  return {
    id: "1",
    publicId: "ing_000000000001",
    userId: "u",
    editVersion: 0,
    name: "Baby Arugula",
    normalizedName: "baby arugula",
    measureName: "Baby Arugula",
    purchaseCostCents: 1200,
    purchaseSize: 1,
    purchaseUnit: "kg",
    yieldPercent: 100,
    priceSource: "user",
    categoryId: null,
    category: null,
    status: "active",
    usedInRecipes: [],
    usedInProducts: [],
    tags: [],
    effectiveAllergenKeys: [],
    previousPrice: null,
    preferredSupplier: null,
    needsAttention: [],
    nutrition: null,
    nonEdible: false,
    sugarsAreAdded: false,
    nutritionLabelName: "",
    nutritionRequest: null,
    allergenHints: { contains: [], mayContain: [], checkLabel: [] },
    createdAt: now,
    updatedAt: now,
    priceHistory: [],
    supplierItems: [],
    invoicePrices: [],
    preparations: [],
    conversion: null,
    effectiveAllergens: [],
    ...overrides,
  }
}

describe("ingredient insights", () => {
  it("compares current and prior unit prices", () => {
    const row = ingredient({
      priceHistory: [
        {
          id: "p1",
          purchaseCostCents: 1000,
          purchaseSize: 1,
          purchaseUnit: "kg",
          source: "supplier",
          effectiveAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    expect(ingredientPriceChange(row)?.percent).toBeCloseTo(20)
    expect(ingredientPriceChange(row)?.previous.id).toBe("p1")
  })

  it("compares on unit price, so a pack-size change is not a price rise", () => {
    // Same $12/kg, bought as a 2 kg sack instead of 1 kg. The pack price
    // doubles; the ingredient did not get dearer.
    const row = ingredient({
      purchaseCostCents: 2400,
      purchaseSize: 2,
      priceHistory: [
        {
          id: "p1",
          purchaseCostCents: 1200,
          purchaseSize: 1,
          purchaseUnit: "kg",
          source: "supplier",
          effectiveAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    expect(ingredientPriceChange(row)).toBeNull()
  })

  it("finds a meaningfully cheaper alternate supplier pack", () => {
    const row = ingredient({
      supplierItems: [
        {
          id: "s1",
          supplier: "acme",
          externalId: "a1",
          title: "Baby Arugula",
          rawSize: "1 KG",
          packPriceCents: 1200,
          packGrams: 1000,
          packAmount: 1,
          packUnit: "kg",
          purchasedQuantity: 1,
          periodStart: null,
          periodEnd: null,
          isPreferred: true,
          updatedAt: new Date(),
        },
        {
          id: "s2",
          supplier: "acme",
          externalId: "a2",
          title: "Baby Arugula",
          rawSize: "2 KG",
          packPriceCents: 1800,
          packGrams: 2000,
          packAmount: 2,
          packUnit: "kg",
          purchasedQuantity: 1,
          periodStart: null,
          periodEnd: null,
          isPreferred: false,
          updatedAt: new Date(),
        },
      ],
    })
    expect(cheaperSupplierItem(row)?.item.externalId).toBe("a2")
    expect(cheaperSupplierItem(row)?.savingsPercent).toBeCloseTo(25)
  })

  it("flags stale rows and conservative duplicate suggestions", () => {
    expect(
      isIngredientStale(
        ingredient({ updatedAt: new Date("2026-01-01T00:00:00Z") }),
        new Date("2026-08-07T00:00:00Z")
      )
    ).toBe(true)
    expect(
      findDuplicateIngredients([
        { id: "1", name: "Baby Arugula" },
        { id: "2", name: "Arugula Baby" },
        { id: "3", name: "Kosher Salt" },
      ])
    ).toEqual([expect.objectContaining({ leftId: "1", rightId: "2" })])

    expect(
      findDuplicateIngredients([
        { id: "1", name: "5in White Corn Tortillas" },
        { id: "2", name: "6in White Corn Tortillas" },
        { id: "3", name: "Salted Peanuts" },
        { id: "4", name: "Unsalted Peanuts" },
      ])
    ).toEqual([])
  })
})
