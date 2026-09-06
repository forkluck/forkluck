import { describe, expect, it } from "vitest"

import type {
  BenchcostRecipeWithData,
  RecipeSummary,
} from "../lib/backend/types"
import type { BodyPricing } from "../lib/pricing"
import {
  FOOD_COST_TARGET,
  buildRecipeHealth,
  describeRecipeIssues,
  recipePortionDivisor,
  recipeUnitDivisor,
} from "../lib/recipe/health"

function recipe(overrides: Partial<RecipeSummary> = {}): RecipeSummary {
  return {
    id: "r1",
    publicId: "rcp_test00000001",
    title: "Buttermilk Biscuits",
    code: "RCP-0001",
    kind: "recipe",
    status: "active",
    locked: false,
    categoryId: null,
    category: null,
    body: "",
    method: "",
    yieldAmount: 12,
    yieldUnit: "pcs",
    servingAmount: 1,
    servingUnit: "pcs",
    menuPriceCents: 400,
    autoPrepTimeEnabled: false,
    updatedAt: new Date("2026-08-07T00:00:00Z"),
    ...overrides,
  }
}

function step(
  id: string,
  ...seconds: number[]
): BenchcostRecipeWithData["steps"][number] {
  return {
    id,
    recipeId: "c1",
    name: id,
    kind: "active",
    covers: 1,
    position: 0,
    timings: seconds.map((value, index) => ({
      id: `${id}-${index}`,
      stepId: id,
      seconds: value,
      yieldCount: 12,
      createdAt: new Date(),
    })),
  }
}

function pricing(overrides: Partial<BodyPricing> = {}): BodyPricing {
  return {
    lines: [],
    totalCents: 1200,
    unpricedCount: 0,
    reviewCount: 0,
    ...overrides,
  }
}

function costEntry(
  steps: BenchcostRecipeWithData["steps"] = []
): BenchcostRecipeWithData {
  return {
    id: "c1",
    userId: "u1",
    recipeId: "r1",
    name: "Buttermilk Biscuits",
    ingredientCostCents: 1200,
    packagingCostCents: 0,
    batchYield: 12,
    sellableYield: null,
    position: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    steps,
  }
}

describe("recipeUnitDivisor", () => {
  it("divides piece yields by pieces", () => {
    expect(recipeUnitDivisor(recipe())).toEqual({ divisor: 12, suffix: "/pc" })
  })

  it("divides weight yields by kilograms", () => {
    const unit = recipeUnitDivisor(recipe({ yieldAmount: 2, yieldUnit: "kg" }))
    expect(unit).toEqual({ divisor: 2, suffix: "/kg" })
  })

  it("divides volume yields by liters", () => {
    const unit = recipeUnitDivisor(
      recipe({ yieldAmount: 1500, yieldUnit: "ml" })
    )
    expect(unit).toEqual({ divisor: 1.5, suffix: "/L" })
  })

  it("divides a piece yield by its count", () => {
    const unit = recipeUnitDivisor(recipe({ yieldAmount: 12 }))
    expect(unit).toEqual({ divisor: 12, suffix: "/pc" })
  })

  it("returns null without a usable yield", () => {
    expect(recipeUnitDivisor(recipe({ yieldAmount: null }))).toBeNull()
    expect(recipeUnitDivisor(recipe({ yieldAmount: 0 }))).toBeNull()
  })
})

describe("buildRecipeHealth", () => {
  it("computes unit cost and food cost against menu price", () => {
    const health = buildRecipeHealth(recipe(), pricing(), null, 2000)
    expect(health.ingredientCents).toBe(100)
    expect(health.foodCost).toBeCloseTo(0.25)
    expect(health.overTarget).toBe(false)
  })

  it("flags a recipe over the food cost target", () => {
    const health = buildRecipeHealth(
      recipe({ menuPriceCents: 200 }),
      pricing(),
      null,
      2000
    )
    expect(health.foodCost).toBeCloseTo(0.5)
    expect(health.foodCost!).toBeGreaterThan(FOOD_COST_TARGET)
    expect(health.overTarget).toBe(true)
  })

  it("uses the workspace food cost target when provided", () => {
    const health = buildRecipeHealth(recipe(), pricing(), null, 2000, 0.2)
    expect(health.foodCost).toBeCloseTo(0.25)
    expect(health.overTarget).toBe(true)
  })

  it("drops menu price and food cost for a component", () => {
    const health = buildRecipeHealth(
      recipe({ kind: "component" }),
      pricing(),
      null,
      2000
    )
    expect(health.ingredientCents).toBe(100)
    expect(health.menuPriceCents).toBeNull()
    expect(health.foodCost).toBeNull()
    expect(health.overTarget).toBe(false)
  })

  it("reports a missing yield and leaves cost null", () => {
    const health = buildRecipeHealth(
      recipe({ yieldAmount: null }),
      pricing(),
      null,
      2000
    )
    expect(health.issues).toContain("no yield")
    expect(health.ingredientCents).toBeNull()
    expect(health.foodCost).toBeNull()
  })

  it("does not invent a commercial unit when the portion is missing", () => {
    const health = buildRecipeHealth(
      recipe({ servingAmount: null, servingUnit: "" }),
      pricing(),
      null,
      2000
    )
    expect(health.issues).toContain("no portion")
    expect(health.ingredientCents).toBeNull()
    expect(health.foodCost).toBeNull()
  })

  it("prices the saved count portion instead of one yield unit", () => {
    const health = buildRecipeHealth(
      recipe({ servingAmount: 2, servingUnit: "each" }),
      pricing(),
      null,
      2000
    )
    expect(health.ingredientCents).toBe(200)
    expect(health.foodCost).toBeCloseTo(0.5)
    expect(health.suffix).toBe("/2 each")
  })

  it("leaves a weighted portion of a counted yield unresolved", () => {
    const health = buildRecipeHealth(
      recipe({
        yieldAmount: 31,
        yieldUnit: "pcs",
        servingAmount: 12,
        servingUnit: "g",
      }),
      pricing({ totalCents: 356 }),
      null,
      2000
    )
    expect(health.ingredientCents).toBeNull()
    expect(health.foodCost).toBeNull()
    expect(health.issues).toContain("portion needs equivalency")
  })

  it("prices volume portions in the same family", () => {
    const health = buildRecipeHealth(
      recipe({
        yieldAmount: 1,
        yieldUnit: "l",
        servingAmount: 250,
        servingUnit: "ml",
      }),
      pricing(),
      null,
      2000
    )
    expect(health.ingredientCents).toBe(300)
    expect(health.suffix).toBe("/250 ml")
  })

  it("uses recipe equivalency for a cross-family portion", () => {
    const health = buildRecipeHealth(
      {
        ...recipe({
          yieldAmount: 600,
          yieldUnit: "g",
          servingAmount: 1,
          servingUnit: "each",
        }),
        equivalency: {
          massAmount: null,
          massUnit: "",
          volumeAmount: null,
          volumeUnit: "",
          countAmount: 24,
          countUnit: "each",
        },
      },
      pricing(),
      null,
      2000
    )
    expect(health.ingredientCents).toBe(50)
    expect(health.issues).not.toContain("portion needs equivalency")
  })

  it("leaves a cross-family portion unresolved without equivalency", () => {
    const health = buildRecipeHealth(
      recipe({
        yieldAmount: 600,
        yieldUnit: "g",
        servingAmount: 1,
        servingUnit: "each",
      }),
      pricing(),
      null,
      2000
    )
    expect(health.issues).toContain("portion needs equivalency")
    expect(health.ingredientCents).toBeNull()
    expect(health.foodCost).toBeNull()
  })

  it("reports unpriced ingredients with a count", () => {
    const health = buildRecipeHealth(
      recipe(),
      pricing({ unpricedCount: 3 }),
      null,
      2000
    )
    expect(health.issues).toContain("3 unpriced")
  })

  it("reports uncertain catalog estimates for review", () => {
    const health = buildRecipeHealth(
      recipe(),
      pricing({ reviewCount: 2 }),
      null,
      2000
    )
    expect(health.issues).toContain("2 estimates to review")
  })

  it("reports no prep time when the recipe has none", () => {
    const health = buildRecipeHealth(recipe(), pricing(), null, 2000)
    expect(health.issues).toContain("No prep time")
    expect(health.labor).toBeNull()
  })

  it("costs prep time at the wage without any step tracking", () => {
    const health = buildRecipeHealth(
      recipe({ prepTimeAmount: 2, prepTimeUnit: "hours" }),
      pricing(),
      null,
      2000
    )
    expect(health.labor?.centsPerBatch).toBe(4000)
    expect(health.issues).not.toContain("No prep time")
  })

  it("sums the timed active steps when auto prep time is on", () => {
    const health = buildRecipeHealth(
      recipe({
        autoPrepTimeEnabled: true,
        prepTimeAmount: 2,
        prepTimeUnit: "hours",
      }),
      pricing(),
      costEntry([
        step("mix", 600),
        step("shape", 300),
        { ...step("prove", 1800), kind: "passive" },
      ]),
      2000
    )
    expect(health.labor?.centsPerBatch).toBe(500)
    expect(health.issues).toEqual([])
  })

  it("reports no timed steps when auto prep time has nothing to sum", () => {
    const health = buildRecipeHealth(
      recipe({ autoPrepTimeEnabled: true }),
      pricing(),
      costEntry([step("mix")]),
      2000
    )
    expect(health.issues).toContain("No timed steps")
    expect(health.labor).toBeNull()
  })

  it("reports untimed active steps", () => {
    const health = buildRecipeHealth(
      recipe({ autoPrepTimeEnabled: true }),
      pricing(),
      costEntry([step("mix", 600), step("pack"), step("label")]),
      2000
    )
    expect(health.issues).toContain("2 steps untimed")
    expect(health.labor?.centsPerBatch).toBe(333)
  })

  it("has no issues when a recipe is fully costed", () => {
    const health = buildRecipeHealth(
      recipe({ prepTimeAmount: 30, prepTimeUnit: "minutes" }),
      pricing(),
      null,
      2000
    )
    expect(health.issues).toEqual([])
    expect(health.labor?.centsPerPiece).toBeCloseTo(1000 / 12, 6)
  })
})

describe("recipePortionDivisor", () => {
  it("scales a standard equivalency to the declared yield", () => {
    expect(
      recipePortionDivisor({
        ...recipe({
          yieldAmount: 2,
          yieldUnit: "l",
          servingAmount: 100,
          servingUnit: "g",
        }),
        equivalency: {
          massAmount: 250,
          massUnit: "g",
          volumeAmount: 500,
          volumeUnit: "ml",
          countAmount: null,
          countUnit: "",
          standard: true,
        },
      })
    ).toEqual({ divisor: 10, suffix: "/100 g" })
  })
})

describe("describeRecipeIssues", () => {
  it("reads out the line-level gaps in fixing order", () => {
    expect(
      describeRecipeIssues([
        "missing quantity",
        "stray words",
        "unresolved item",
        "unpriced ingredient",
      ])
    ).toEqual([
      "Lines not linked to an ingredient or recipe",
      "Lines with extra words that aren’t a saved preparation",
      "Ingredients without a price",
      "Lines without a quantity",
    ])
  })

  it("keeps the pasted-text path's unpriced count", () => {
    expect(describeRecipeIssues(["3 unpriced"])).toEqual([
      "3 ingredients without a price",
    ])
    expect(describeRecipeIssues(["1 unpriced"])).toEqual([
      "1 ingredient without a price",
    ])
  })

  it("leaves setup gaps off the flag", () => {
    expect(
      describeRecipeIssues([
        "no yield",
        "no portion",
        "portion needs equivalency",
        "labor not tracked",
        "no steps",
        "2 steps untimed",
        "No prep time",
        "1 estimate to review",
      ])
    ).toEqual([])
  })
})
