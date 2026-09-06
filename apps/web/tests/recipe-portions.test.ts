import { describe, expect, it } from "vitest"

import { recipePortions } from "@/lib/recipe/portions"
import type { WeighEquivalency } from "@/lib/recipe/weigh"

const noServing = { amount: null, unit: "" }
const recipe = (
  amount: number,
  unit: string,
  equivalency: WeighEquivalency | null = null
) => ({ id: "recipe", yieldAmount: amount, yieldUnit: unit, equivalency })

describe("recipePortions", () => {
  it("does not infer a portion from a counted yield", () => {
    expect(recipePortions(recipe(8, "slice"), noServing)).toBeNull()
    expect(recipePortions(recipe(12, "pcs"), noServing)).toBeNull()
  })

  it("serves one slice of a sliced batch, and one piece of it too", () => {
    const tart = recipe(8, "slice")
    expect(recipePortions(tart, { amount: 1, unit: "slice" })).toBe(8)
    expect(recipePortions(tart, { amount: 2, unit: "each" })).toBe(4)
    expect(recipePortions(tart, { amount: 1, unit: "pcs" })).toBe(8)
  })

  it("cannot relate a counted yield to a weight or volume portion", () => {
    expect(
      recipePortions(recipe(8, "slice"), { amount: 100, unit: "g" })
    ).toBeNull()
    expect(
      recipePortions(recipe(31, "pcs"), { amount: 12, unit: "g" })
    ).toBeNull()
    expect(
      recipePortions(recipe(24, "pcs"), { amount: 2, unit: "fl-oz" })
    ).toBeNull()
    expect(recipePortions(recipe(1, "kg"), noServing)).toBeNull()
  })

  it("uses an explicit batch equivalency to relate count and weight", () => {
    expect(
      recipePortions(
        recipe(31, "pcs", {
          massAmount: 400,
          massUnit: "g",
          volumeAmount: null,
          volumeUnit: "",
          countAmount: null,
          countUnit: "",
        }),
        { amount: 10, unit: "g" }
      )
    ).toBe(40)
  })

  it("divides a weight batch by a weight serving as before", () => {
    expect(recipePortions(recipe(1, "kg"), { amount: 250, unit: "g" })).toBe(4)
  })

  it("reads a counted serving through the recipe UOM", () => {
    expect(
      recipePortions(
        recipe(600, "g", {
          massAmount: null,
          massUnit: "",
          volumeAmount: null,
          volumeUnit: "",
          countAmount: 100,
          countUnit: "each",
        }),
        { amount: 1, unit: "each" }
      )
    ).toBe(100)
  })

  it("leaves a counted serving unresolved without an equivalency", () => {
    expect(
      recipePortions(recipe(600, "g"), { amount: 1, unit: "each" })
    ).toBeNull()
  })
})
