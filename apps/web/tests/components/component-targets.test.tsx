import { describe, expect, it } from "vitest"

import {
  componentFromTarget,
  componentTargets,
  type MenuComponentTarget,
} from "@/components/menus/component-targets"
import type {
  MenuIngredientOption,
  MenuProductOption,
  MenuRecipeOption,
} from "@/lib/backend/types"

const bread: MenuRecipeOption = {
  id: "rec-1",
  publicId: "rcp_1",
  title: "Bread",
  kind: "recipe",
  category: "Bakery",
  menuPriceCents: 450,
  ingredientCents: 120,
  suffix: "/pc",
}

const butter: MenuIngredientOption = {
  id: "ing-1",
  name: "Butter",
  purchaseUnit: "kg",
  nonEdible: false,
}

const box: MenuProductOption = {
  id: "prd-1",
  publicId: "prd_box",
  name: "Mooncake Box",
  componentProductIds: [],
}

describe("component targets", () => {
  it("defaults unknown legacy purchase units to each", () => {
    const target = {
      kind: "ingredient",
      id: "ing-1",
      name: "Butter",
      purchaseUnit: "legacy pack",
      nonEdible: false,
    } satisfies MenuComponentTarget

    expect(componentFromTarget(target).unit).toBe("each")
    expect(componentFromTarget({ ...target, purchaseUnit: "pcs" }).unit).toBe(
      "each"
    )
  })

  it("offers products only when it is given them", () => {
    expect(componentTargets([bread], [butter]).map((row) => row.kind)).toEqual([
      "recipe",
      "ingredient",
    ])
    expect(
      componentTargets([bread], [butter], [box]).map((row) => row.kind)
    ).toEqual(["recipe", "ingredient", "product"])
  })

  it("prices a picked recipe from its option", () => {
    const component = componentFromTarget({
      kind: "recipe",
      id: bread.id,
      name: bread.title,
      recipe: bread,
    })

    expect(component.recipeId).toBe("rec-1")
    expect(component.unit).toBe("")
    expect(component.unitCostCents).toBe(120)
  })
})
