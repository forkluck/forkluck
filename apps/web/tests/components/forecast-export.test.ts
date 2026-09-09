import { describe, expect, it } from "vitest"

import {
  exportFileName,
  prepListCsv,
  prepListRow,
  shoppingListCsv,
  shoppingListRow,
} from "@/components/menus/forecast-export"
import type { MenuForecast } from "@/lib/backend/types"

const cream: MenuForecast["materialRequirements"][number] = {
  ingredientId: "ingredient-1",
  ingredientPublicId: "ing_cream",
  ingredientName: "Heavy cream, 40%",
  kind: "ingredient",
  usage: [{ quantity: 18400, unit: "g" }],
  purchase: [{ quantity: 19.2, unit: "qt" }],
  purchaseSize: 4,
  purchaseUnit: "qt",
  packs: 4.8,
  costCents: 6250,
  supplierPack: null,
}

const yolk: MenuForecast["materialRequirements"][number] = {
  ingredientId: "ingredient-2",
  ingredientPublicId: "ing_yolk",
  ingredientName: "Egg yolk",
  kind: "ingredient",
  usage: [
    { quantity: 27, unit: "each" },
    { quantity: 369.4567, unit: "g" },
  ],
  purchase: [],
  purchaseSize: null,
  purchaseUnit: null,
  packs: null,
  costCents: null,
  supplierPack: null,
}

const dough: MenuForecast["recipeRequirements"][number] = {
  recipeId: "recipe-1",
  recipePublicId: "rcp_dough",
  recipeTitle: "Cookie dough",
  batches: 2.346,
  yieldAmount: 24,
  yieldUnit: "each",
}

describe("forecast exports", () => {
  it("writes a shopping row with whole packs and the pack price as a decimal", () => {
    expect(shoppingListRow(cream)).toBe(
      '"Heavy cream, 40%",ingredient,19.2,qt,5,4,qt,,62.50'
    )
    expect(
      shoppingListRow({
        ...cream,
        supplierPack: { supplier: "Baldor", rawSize: "4 QT", title: "Cream" },
      })
    ).toBe('"Heavy cream, 40%",ingredient,19.2,qt,5,4,qt,"Baldor: 4 QT",62.50')
  })

  it("falls back to the recipe side, units and all, when nothing can be bought yet", () => {
    expect(shoppingListRow(yolk)).toBe(
      '"Egg yolk",ingredient,27 ea; 369.457 g,,,,,,'
    )
  })

  it("writes a prep row with what the batches make", () => {
    expect(prepListRow(dough)).toBe('"Cookie dough",2.346,56.304,ea')
    expect(prepListRow({ ...dough, yieldAmount: null, yieldUnit: null })).toBe(
      '"Cookie dough",2.346,,'
    )
  })

  it("heads each list and names the file after the menu and the first day", () => {
    const forecast = {
      menu: { id: "menu-1", publicId: "mnu_spring", name: "Spring" },
      basis: { horizonStart: "2026-04-27" },
      materialRequirements: [cream],
      recipeRequirements: [dough],
    } as unknown as MenuForecast
    expect(shoppingListCsv(forecast).split("\n")[0]).toBe(
      "Material,Kind,Needed,Unit,Packs to buy,Pack size,Pack unit,Supplier pack,Cost"
    )
    expect(prepListCsv(forecast).split("\n")).toHaveLength(2)
    expect(exportFileName(forecast, "shopping-list")).toBe(
      "mnu_spring-shopping-list-2026-04-27.csv"
    )
  })
})
