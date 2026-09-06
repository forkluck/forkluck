import { describe, expect, it } from "vitest"

import {
  buildPriceSources,
  normalizeIngredientName,
  centsPerKg,
  centsPerWeightUnit,
  priceIngredientLines,
  priceParsedLines,
  priceRecipeBody,
  type PriceListEntry,
} from "../lib/pricing"
import { parseRecipeText, type IngredientMeasure } from "../lib/recipe"

const flour: PriceListEntry = {
  id: "flour",
  name: "Bread Flour",
  normalizedName: "bread flour",
  purchaseCostCents: 1850,
  purchaseSize: 25,
  purchaseUnit: "kg",
}

// The kitchen supplied an unrelated custom measure, so the automatic density
// path must stay off and leave a volume line unresolved.
const saffron: PriceListEntry = {
  id: "saffron",
  name: "Saffron Threads",
  normalizedName: "saffron threads",
  purchaseCostCents: 4000,
  purchaseSize: 10,
  purchaseUnit: "g",
  conversion: {
    usesStandardConversion: false,
    weight: null,
    volume: null,
    each: { amount: 1, unit: "each" },
  },
}

const butter: PriceListEntry = {
  id: "butter",
  name: "Butter",
  normalizedName: "butter",
  purchaseCostCents: 500,
  purchaseSize: 454,
  purchaseUnit: "g",
}

const flourCup: IngredientMeasure = {
  id: "flour-cup",
  ingredientId: "flour",
  name: "Bread Flour",
  normalizedName: "bread flour",
  unit: "cup",
  amount: 1,
  grams: 137,
  lowGrams: null,
  highGrams: null,
  qualifier: "",
  source: "user",
  confidence: "high",
}

describe("normalizeIngredientName", () => {
  it("lowercases, trims, and collapses punctuation to single spaces", () => {
    expect(normalizeIngredientName("  Bread Flour ")).toBe("bread flour")
    expect(normalizeIngredientName("P. Sugar")).toBe("p sugar")
    expect(normalizeIngredientName("Extra-Virgin  Olive Oil")).toBe(
      "extra virgin olive oil"
    )
  })

  // Mirrors ACCENT_PARITY in apps/api/forkluck/test_name_normalization.py:
  // the two engines compare the same keys, so they must fold alike.
  it("folds accents", () => {
    expect(normalizeIngredientName("Crème Fraîche")).toBe("creme fraiche")
    expect(normalizeIngredientName("Jalapeño")).toBe("jalapeno")
    expect(normalizeIngredientName("püree")).toBe("puree")
    expect(normalizeIngredientName("  Crème---fraîche! ")).toBe(
      normalizeIngredientName("Creme Fraiche")
    )
    expect(normalizeIngredientName("ICING SUGAR")).toBe("icing sugar")
  })
})

describe("centsPerKg", () => {
  it("derives cost per kilogram from the pack", () => {
    expect(
      centsPerKg(
        flour.purchaseCostCents,
        flour.purchaseSize,
        flour.purchaseUnit
      )
    ).toBeCloseTo(74, 0)
    // No weight, no price per kilo — a case of eggs has a cost and no rate.
    expect(centsPerKg(500, 1, "case")).toBeNull()
  })
})

describe("centsPerWeightUnit", () => {
  it("uses the selected display basis without changing the pack", () => {
    expect(
      centsPerWeightUnit(
        flour.purchaseCostCents,
        flour.purchaseSize,
        flour.purchaseUnit,
        "lb"
      )
    ).toBeCloseTo(33.57, 1)
    expect(centsPerWeightUnit(500, 1, "case", "lb")).toBeNull()
  })
})

describe("priceIngredientLines", () => {
  it("prices matched lines by weight and sums the total", () => {
    const result = priceIngredientLines(
      [
        { name: "Bread Flour", grams: 500 },
        { name: "butter", grams: 227 },
      ],
      [flour, butter]
    )
    expect(result.lines[0].costCents).toBeCloseTo(37, 0)
    expect(result.lines[1].costCents).toBeCloseTo(250, 0)
    expect(result.totalCents).toBeCloseTo(287, 0)
    expect(result.unpricedCount).toBe(0)
  })

  it("matches on normalized names, not exact strings", () => {
    const result = priceIngredientLines(
      [{ name: "  BREAD-FLOUR ", grams: 1000 }],
      [flour]
    )
    expect(result.lines[0].ingredientId).toBe("flour")
    expect(result.unpricedCount).toBe(0)
  })

  it("flags unmatched lines as unpriced and excludes them from the total", () => {
    const result = priceIngredientLines(
      [
        { name: "Bread Flour", grams: 1000 },
        { name: "Vanilla Extract", grams: 10 },
      ],
      [flour]
    )
    expect(result.unpricedCount).toBe(1)
    expect(result.lines[1].costCents).toBeNull()
    expect(result.totalCents).toBeCloseTo(74, 0)
  })
})

describe("line matching", () => {
  it("resolves a differently-named line through a saved match", () => {
    const result = priceIngredientLines(
      [{ name: "P. Sugar", grams: 500 }],
      [flour, butter],
      [{ line: "p sugar", targetId: "butter" }]
    )
    expect(result.lines[0].ingredientId).toBe("butter")
    expect(result.lines[0].costCents).toBeCloseTo((500 * 500) / 454, 0)
    expect(result.unpricedCount).toBe(0)
  })

  it("prefers an exact name match over a saved match", () => {
    const result = priceIngredientLines(
      [{ name: "Butter", grams: 100 }],
      [flour, butter],
      [{ line: "butter", targetId: "flour" }]
    )
    expect(result.lines[0].ingredientId).toBe("butter")
  })

  it("lets an explicit match replace an exact-name starter estimate", () => {
    const vanillaEstimate: PriceListEntry = {
      id: "master:vanilla",
      name: "Vanilla Extract",
      normalizedName: "vanilla extract",
      purchaseCostCents: 3252,
      purchaseSize: 1000,
      purchaseUnit: "g",
      source: "master",
      masterPriceId: "vanilla",
    }
    const bourbonVanilla: PriceListEntry = {
      id: "bourbon-vanilla",
      name: "Bourbon Vanilla Extract",
      normalizedName: "bourbon vanilla extract",
      purchaseCostCents: 3995,
      purchaseSize: 1000,
      purchaseUnit: "g",
      source: "pantry",
    }
    const result = priceIngredientLines(
      [{ name: "vanilla extract", grams: 6 }],
      [vanillaEstimate, bourbonVanilla],
      [{ line: "vanilla extract", targetId: "bourbon-vanilla" }]
    )

    expect(result.lines[0].ingredientId).toBe("bourbon-vanilla")
    expect(result.lines[0].costCents).toBeCloseTo((6 * 3995) / 1000, 2)
  })

  it("lets an explicit match replace an exact-name Catalog estimate", () => {
    const catalogEstimate: PriceListEntry = {
      id: "catalog:onion",
      name: "Yellow Onions",
      normalizedName: "yellow onions",
      purchaseCostCents: 2800,
      purchaseSize: 22680,
      purchaseUnit: "g",
      source: "catalog",
      catalogPriceId: "catalog-product-id",
    }
    const pantryOnion: PriceListEntry = {
      id: "pantry-onion",
      name: "Local Yellow Onions",
      normalizedName: "local yellow onions",
      purchaseCostCents: 2400,
      purchaseSize: 22680,
      purchaseUnit: "g",
      source: "pantry",
    }
    const result = priceIngredientLines(
      [{ name: "yellow onions", grams: 500 }],
      [catalogEstimate, pantryOnion],
      [{ line: "yellow onions", targetId: "pantry-onion" }]
    )

    expect(result.lines[0].ingredientId).toBe("pantry-onion")
  })

  it("uses one exact pantry identity for both weight and price", () => {
    const exactPantry: PriceListEntry = {
      id: "exact-ap",
      name: "AP flour",
      normalizedName: "ap flour",
      purchaseCostCents: 1000,
      purchaseSize: 1000,
      purchaseUnit: "g",
      source: "pantry",
    }
    const exactMeasure: IngredientMeasure = {
      ...flourCup,
      id: "exact-ap-cup",
      ingredientId: exactPantry.id,
      name: exactPantry.name,
      normalizedName: exactPantry.normalizedName,
      grams: 100,
    }
    const result = priceRecipeBody(
      "1 cup AP flour",
      [flour, exactPantry],
      [{ line: "ap flour", targetId: flour.id }],
      [flourCup, exactMeasure]
    )

    expect(result.lines[0]).toEqual(
      expect.objectContaining({
        grams: 100,
        ingredientId: exactPantry.id,
        costCents: 100,
      })
    )
  })
})

describe("priceRecipeBody", () => {
  it("parses ingredient lines out of a pasted recipe and prices them", () => {
    const body = "500 g Bread Flour\n380 g Water\n\nMix everything and rest."
    const result = priceRecipeBody(body, [flour])
    expect(result.lines).toHaveLength(2)
    expect(result.lines[0].costCents).toBeCloseTo(37, 0)
    expect(result.unpricedCount).toBe(1) // water has no price entry
  })

  // Parity with AccentedPantryPricingTests in
  // apps/api/forkluck/test_name_normalization.py.
  it("prices either spelling against an accented pantry name", () => {
    const cremeFraiche: PriceListEntry = {
      id: "creme-fraiche",
      name: "Crème Fraîche",
      normalizedName: normalizeIngredientName("Crème Fraîche"),
      purchaseCostCents: 1000,
      purchaseSize: 1000,
      purchaseUnit: "g",
    }
    for (const line of ["200 g creme fraiche", "200 g Crème Fraîche"]) {
      const result = priceRecipeBody(line, [cremeFraiche])
      expect(result.unpricedCount).toBe(0)
      expect(result.lines[0].costCents).toBeCloseTo(200, 4)
    }
  })

  it("resolves an ingredient-specific volume before pricing", () => {
    const result = priceRecipeBody(
      "2 cups Bread Flour",
      [flour],
      [],
      [flourCup]
    )
    expect(result.lines[0].grams).toBe(274)
    expect(result.lines[0].costCents).toBeCloseTo((274 * 1850) / 25000, 4)
    expect(result.unpricedCount).toBe(0)
  })

  it("uses the canonical measure identity after a pantry rename", () => {
    const renamedFlour: PriceListEntry = {
      ...flour,
      name: "House Flour",
      normalizedName: "house flour",
      measureName: "All-purpose flour",
    }
    const catalogFlour: IngredientMeasure = {
      ...flourCup,
      ingredientId: null,
      name: "All-purpose flour",
      normalizedName: "all purpose flour",
      source: "catalog",
    }
    const result = priceRecipeBody(
      "1 cup House Flour",
      [renamedFlour],
      [],
      [catalogFlour]
    )

    expect(result.lines[0]).toEqual(
      expect.objectContaining({
        grams: 137,
        ingredientId: renamedFlour.id,
      })
    )
    expect(result.unpricedCount).toBe(0)
  })

  it("prices a qualified measure against its base pantry ingredient", () => {
    const siftedFlour: IngredientMeasure = {
      ...flourCup,
      id: "sifted-flour-cup",
      grams: 120,
      qualifier: "sifted",
    }
    const result = priceRecipeBody(
      "1 cup Bread Flour (sifted)",
      [flour],
      [],
      [siftedFlour]
    )

    expect(result.lines[0]).toEqual(
      expect.objectContaining({
        name: "Bread Flour (sifted)",
        grams: 120,
        ingredientId: "flour",
      })
    )
    expect(result.lines[0].costCents).toBeCloseTo((120 * 1850) / 25000, 4)
    expect(result.unpricedCount).toBe(0)
  })

  it.each([
    "Bread Flour (sifted), divided",
    "Bread Flour (sifted) (divided)",
    "Bread Flour, sifted (room temperature)",
  ])(
    "prices composed annotations against the base ingredient in %s",
    (name) => {
      const siftedFlour: IngredientMeasure = {
        ...flourCup,
        id: "sifted-flour-composed",
        grams: 120,
        qualifier: "sifted",
      }
      const result = priceRecipeBody(
        `1 cup ${name}`,
        [flour],
        [],
        [siftedFlour]
      )

      expect(result.lines[0]).toEqual(
        expect.objectContaining({
          grams: 120,
          ingredientId: flour.id,
        })
      )
      expect(result.unpricedCount).toBe(0)
    }
  )

  it("keeps unresolved volumes visible and unpriced", () => {
    const result = priceRecipeBody("1 cup Saffron Threads", [saffron])
    expect(result.lines).toEqual([
      expect.objectContaining({
        name: "Saffron Threads",
        grams: null,
        ingredientId: "saffron",
        costCents: null,
        needsConversion: true,
      }),
    ])
    expect(result.unpricedCount).toBe(1)
  })

  it("weighs a volume from a typical density when nothing is saved", () => {
    const result = priceRecipeBody("1 cup Bread Flour", [flour])
    expect(result.lines[0].grams).toBeCloseTo(127, 0)
    expect(result.lines[0].costCents).not.toBeNull()
    expect(result.unpricedCount).toBe(0)
  })

  it("uses a known density before the standard cup estimate", () => {
    const ingredients: PriceListEntry[] = [
      {
        id: "shiro-miso",
        name: "Shiro Miso",
        normalizedName: "shiro miso",
        purchaseCostCents: 1000,
        purchaseSize: 1,
        purchaseUnit: "kg",
      },
      {
        id: "pimenton",
        name: "Pimentón de la Vera",
        normalizedName: "pimenton de la vera",
        purchaseCostCents: 1000,
        purchaseSize: 1,
        purchaseUnit: "kg",
      },
    ]

    const result = priceRecipeBody(
      "1 cup Shiro Miso\n1 cup Pimentón de la Vera",
      ingredients
    )

    expect(result.lines.map((line) => line.grams)).toEqual([273, 226.796185])
    expect(result.lines.map((line) => line.basis)).toEqual([
      "automatic-conversion",
      "automatic-conversion",
    ])
    expect(result.unpricedCount).toBe(0)
  })

  it("prices an ingredient range at the amount it starts from", () => {
    const result = priceRecipeBody("1–2 cups Bread Flour\n100 g Butter", [
      flour,
      butter,
    ])

    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Bread Flour", ingredientId: "flour" }),
      ])
    )
    expect(result.lines[0].grams).toBeCloseTo(127, 0)
    expect(result.unpricedCount).toBe(0)
  })

  it("prices a disputed catalog midpoint while keeping it in review", () => {
    const rangedCatalogMeasure: IngredientMeasure = {
      ...flourCup,
      id: "catalog-flour-range",
      ingredientId: null,
      lowGrams: 110,
      highGrams: 164,
      source: "catalog",
    }
    const result = priceRecipeBody(
      "1 cup Bread Flour",
      [flour],
      [],
      [rangedCatalogMeasure]
    )

    expect(result.lines[0]).toEqual(
      expect.objectContaining({
        grams: 137,
        needsReview: true,
      })
    )
    expect(result.totalCents).toBeCloseTo((137 * 1850) / 25000, 4)
    expect(result.unpricedCount).toBe(0)
    expect(result.reviewCount).toBe(1)
  })
})

describe("buildPriceSources", () => {
  const pasteRecipe = {
    id: "paste",
    title: "Red Bean Paste",
    kind: "component" as const,
    body: "1000 g Bread Flour\n500 g Butter",
  }

  it("exposes a fully priced recipe as a price source by batch weight", () => {
    const sources = buildPriceSources([flour, butter], [pasteRecipe])
    const paste = sources.find((entry) => entry.id === "paste")
    expect(paste).toBeDefined()
    expect(paste?.source).toBe("component")
    expect(paste?.purchaseSize).toBe(1500)
    // 1000g flour = 74¢, 500g butter = 550.66¢ → rounded batch cost.
    expect(paste?.purchaseCostCents).toBe(625)
  })

  it("lets recipe lines auto-match a sub-recipe by title", () => {
    const sources = buildPriceSources([flour, butter], [pasteRecipe])
    const result = priceRecipeBody("300 g Red Bean Paste", sources)
    expect(result.unpricedCount).toBe(0)
    expect(result.lines[0].costCents).toBeCloseTo((300 * 625) / 1500, 0)
  })

  it("rolls a fully mapped component composition into its identity", () => {
    const sources = buildPriceSources([flour, butter], [pasteRecipe])
    const paste = sources.find((entry) => entry.id === "paste")
    expect(paste?.nutritionPer100g?.protein).toBeCloseTo(8.3, 1)
    expect(paste?.nutritionPer100g?.fat).toBeCloseTo(28, 1)
  })

  // 1000 g bread flour + 500 g unsalted butter: 207 g water, 420.5 g fat,
  // 124.5 g protein.
  it("treats a yield above the input sum as gained water", () => {
    const soaked = { ...pasteRecipe, yieldAmount: 2, yieldUnit: "kg" }
    const sources = buildPriceSources([flour, butter], [soaked])
    const paste = sources.find((entry) => entry.id === "paste")
    expect(paste?.purchaseSize).toBe(2000)
    expect(paste?.nutritionPer100g?.water).toBeCloseTo((207 + 500) / 20, 4)
    expect(paste?.nutritionPer100g?.fat).toBeCloseTo(420.5 / 20, 4)
    expect(paste?.nutritionPer100g?.protein).toBeCloseTo(124.5 / 20, 4)
  })

  it("treats a yield below the input sum as evaporated water", () => {
    const cookedDown = { ...pasteRecipe, yieldAmount: 1.4, yieldUnit: "kg" }
    const sources = buildPriceSources([flour, butter], [cookedDown])
    const paste = sources.find((entry) => entry.id === "paste")
    expect(paste?.purchaseSize).toBe(1400)
    expect(paste?.nutritionPer100g?.water).toBeCloseTo((207 - 100) / 14, 4)
    expect(paste?.nutritionPer100g?.fat).toBeCloseTo(420.5 / 14, 4)
    expect(paste?.nutritionPer100g?.protein).toBeCloseTo(124.5 / 14, 4)
  })

  it("leaves a component unmapped when the loss exceeds its water", () => {
    // Inputs sum to 1500 g but the paste cooks down to a declared 1.2 kg,
    // so cost per gram rises accordingly. The 300 g lost is more water than
    // the batch holds, so no profile is inferred.
    const overCooked = { ...pasteRecipe, yieldAmount: 1.2, yieldUnit: "kg" }
    const sources = buildPriceSources([flour, butter], [overCooked])
    const paste = sources.find((entry) => entry.id === "paste")
    expect(paste?.purchaseSize).toBe(1200)
    expect(paste?.purchaseCostCents).toBe(625)
    expect(paste?.nutritionPer100g).toBeNull()
  })

  it("keeps component nutrition when declared weight equals input mass", () => {
    const unchanged = { ...pasteRecipe, yieldAmount: 1.5, yieldUnit: "kg" }
    const sources = buildPriceSources([flour, butter], [unchanged])
    expect(
      sources.find((entry) => entry.id === "paste")?.nutritionPer100g
    ).not.toBeNull()
  })

  it("ignores a pieces yield when deriving sub-recipe weight", () => {
    const pieces = { ...pasteRecipe, yieldAmount: 40, yieldUnit: "pcs" }
    const sources = buildPriceSources([flour, butter], [pieces])
    expect(sources.find((entry) => entry.id === "paste")?.purchaseSize).toBe(
      1500
    )
  })

  it("prices each component piece from its own sellable yield", () => {
    const dough = {
      ...pasteRecipe,
      id: "dough",
      title: "Cookie dough",
      yieldAmount: 70,
      yieldUnit: "pcs",
    }
    const jam = {
      ...pasteRecipe,
      id: "jam",
      title: "Cookie jam",
      yieldAmount: 80,
      yieldUnit: "pcs",
    }
    const sources = buildPriceSources([flour, butter], [dough, jam])
    const result = priceRecipeBody(
      "1 ea Cookie dough\n1 ea Cookie jam",
      sources
    )

    expect(result.unpricedCount).toBe(0)
    expect(result.lines.map((line) => line.needsConversion)).toEqual([
      false,
      false,
    ])
    expect(result.lines[0].costCents).toBeCloseTo(625 / 70, 6)
    expect(result.lines[1].costCents).toBeCloseTo(625 / 80, 6)
    expect(result.totalCents).toBeCloseTo(625 / 70 + 625 / 80, 6)
  })

  it("prices a component counted in slices per slice", () => {
    // An 8 slice tart is 8 pieces of a 625¢ batch, and it publishes that
    // basis in the one spelling a piece basis is published in.
    const tart = {
      ...pasteRecipe,
      id: "tart",
      title: "Lemon tart",
      yieldAmount: 8,
      yieldUnit: "slice",
    }
    const sources = buildPriceSources([flour, butter], [tart])
    const entry = sources.find((one) => one.id === "tart")
    expect(entry?.componentYieldAmount).toBe(8)
    expect(entry?.componentYieldUnit).toBe("pcs")
    // A slice yield says nothing about finished weight, same as a pieces one.
    expect(entry?.purchaseSize).toBe(1500)

    const result = priceRecipeBody("1 ea Lemon tart", sources)
    expect(result.unpricedCount).toBe(0)
    expect(result.lines[0].costCents).toBeCloseTo(625 / 8, 6)
  })

  it("counts an equivalency stated in slices as the batch's pieces", () => {
    const loaf = {
      ...pasteRecipe,
      id: "loaf",
      title: "Sandwich loaf",
      yieldAmount: 1.5,
      yieldUnit: "kg",
      equivalency: {
        massAmount: null,
        massUnit: "",
        volumeAmount: null,
        volumeUnit: "",
        countAmount: 20,
        countUnit: "slice",
      },
    }
    const sources = buildPriceSources([flour, butter], [loaf])
    const entry = sources.find((one) => one.id === "loaf")
    expect(entry?.componentYieldAmount).toBe(20)
    expect(entry?.componentYieldUnit).toBe("pcs")
  })

  it("prices a piece-yield component whose title collides with a built-in profile", () => {
    // A component titled `Egg` collides with the built-in 50 g each-weight
    // profile. Piece-yield costing must win: cost the line from the batch
    // cost divided by its yield, never from an invented 50 g weight.
    const egg = {
      ...pasteRecipe,
      id: "egg",
      title: "Egg",
      yieldAmount: 70,
      yieldUnit: "pcs",
    }
    const eggs = {
      ...pasteRecipe,
      id: "eggs",
      title: "Eggs",
      yieldAmount: 80,
      yieldUnit: "pcs",
    }
    const sources = buildPriceSources([flour, butter], [egg, eggs])
    const result = priceRecipeBody("1 ea Egg\n1 ea Eggs", sources)

    expect(result.unpricedCount).toBe(0)
    expect(result.lines.map((line) => line.needsConversion)).toEqual([
      false,
      false,
    ])
    // Batch cost is 625¢; without the fix the 50 g profile would divide
    // 50 g by the 1500 g batch (~20.8¢) instead of 625¢ / yield.
    expect(result.lines[0].costCents).toBeCloseTo(625 / 70, 6)
    expect(result.lines[1].costCents).toBeCloseTo(625 / 80, 6)
    expect(result.totalCents).toBeCloseTo(625 / 70 + 625 / 80, 6)
  })

  // A curd measured in cups that the cook also weighed and cut into 8: the
  // yield and every filled equivalency amount are one batch, read three ways.
  const curd = {
    ...pasteRecipe,
    id: "curd",
    title: "Lemon Curd",
    yieldAmount: 2.75,
    yieldUnit: "cup",
    equivalency: {
      massAmount: 700,
      massUnit: "g",
      volumeAmount: null,
      volumeUnit: "",
      countAmount: 8,
      countUnit: "each",
    },
  }

  it("weighs a volume-yield component from its equivalency", () => {
    const sources = buildPriceSources([flour, butter], [curd])
    const entry = sources.find((one) => one.id === "curd")
    expect(entry?.purchaseSize).toBe(700)
    expect(entry?.purchaseUnit).toBe("g")
    expect(entry?.componentWeightKnown).toBe(true)
  })

  it("scales a standard density ratio to the component yield", () => {
    const standard = {
      ...curd,
      id: "standard-curd",
      title: "Standard Curd",
      yieldAmount: 1600,
      yieldUnit: "ml",
      equivalency: {
        massAmount: 8,
        massUnit: "oz",
        volumeAmount: 1,
        volumeUnit: "cup",
        countAmount: null,
        countUnit: "",
        standard: true,
      },
    }
    const sources = buildPriceSources([flour, butter], [standard])
    const entry = sources.find((one) => one.id === "standard-curd")

    expect(entry?.purchaseSize).toBeCloseTo(1534, 0)
    expect(entry?.purchaseUnit).toBe("g")
    expect(
      priceRecipeBody("800 ml Standard Curd", sources).totalCents
    ).toBeCloseTo(625 / 2, 6)
  })

  it("prices a cup of it as that share of the batch, with no density", () => {
    const sources = buildPriceSources([flour, butter], [curd])
    const result = priceRecipeBody("1 cup Lemon Curd", sources)
    expect(result.unpricedCount).toBe(0)
    expect(result.lines[0].costCents).toBeCloseTo(625 / 2.75, 6)
  })

  it("prices a piece of it from the equivalency's count", () => {
    const sources = buildPriceSources([flour, butter], [curd])
    const result = priceRecipeBody("1 ea Lemon Curd", sources)
    expect(result.unpricedCount).toBe(0)
    expect(result.lines[0].costCents).toBeCloseTo(625 / 8, 6)
  })

  it("keeps the input sum when the component states no equivalency", () => {
    const plain = { ...curd, equivalency: null }
    const sources = buildPriceSources([flour, butter], [plain])
    const entry = sources.find((one) => one.id === "curd")
    expect(entry?.purchaseSize).toBe(1500)
    expect(entry?.componentWeightKnown).toBe(false)
  })

  it("keeps a volume yield usable but refuses to invent its batch weight", () => {
    const plain = { ...curd, equivalency: null }
    const sources = buildPriceSources([flour, butter], [plain])

    expect(priceRecipeBody("1 cup Lemon Curd", sources).unpricedCount).toBe(0)
    expect(priceRecipeBody("100 g Lemon Curd", sources).unpricedCount).toBe(1)
  })

  it("excludes the recipe being priced and partially priced recipes", () => {
    const unpriced = {
      id: "mystery",
      title: "Mystery",
      kind: "component" as const,
      body: "10 g Saffron",
    }
    const sources = buildPriceSources(
      [flour, butter],
      [pasteRecipe, unpriced],
      { excludeRecipeId: "paste" }
    )
    expect(sources.some((entry) => entry.id === "paste")).toBe(false)
    expect(sources.some((entry) => entry.id === "mystery")).toBe(false)
  })

  it("excludes recipes that are not components", () => {
    const plain = { ...pasteRecipe, kind: "recipe" as const }
    const sources = buildPriceSources([flour, butter], [plain])
    expect(sources.some((entry) => entry.id === "paste")).toBe(false)
  })

  it("excludes recipes with no kind recorded", () => {
    const sources = buildPriceSources(
      [flour, butter],
      [{ id: "paste", title: "Red Bean Paste", body: pasteRecipe.body }]
    )
    expect(sources.some((entry) => entry.id === "paste")).toBe(false)
  })

  it("builds a component from resolved volume measures", () => {
    const volumeRecipe = {
      ...pasteRecipe,
      body: "2 cups Bread Flour\n500 g Butter",
    }
    const sources = buildPriceSources([flour, butter], [volumeRecipe], {
      measures: [flourCup],
    })
    expect(sources.find((entry) => entry.id === "paste")?.purchaseSize).toBe(
      774
    )
  })

  it("excludes components with unresolved volume measures", () => {
    const volumeRecipe = { ...pasteRecipe, body: "2 cups Saffron Threads" }
    const sources = buildPriceSources([saffron, butter], [volumeRecipe])
    expect(sources.some((entry) => entry.id === "paste")).toBe(false)
  })

  it("costs a component whose line states a range from that range's low end", () => {
    const rangeRecipe = {
      ...pasteRecipe,
      body: "1–2 cups Bread Flour\n500 g Butter",
    }
    const sources = buildPriceSources([flour, butter], [rangeRecipe])

    expect(
      sources.find((entry) => entry.id === "paste")?.purchaseSize
    ).toBeCloseTo(627, 0)
  })

  it("excludes components with disputed catalog measures", () => {
    const rangedCatalogMeasure: IngredientMeasure = {
      ...flourCup,
      id: "catalog-flour-range",
      ingredientId: null,
      lowGrams: 110,
      highGrams: 164,
      source: "catalog",
    }
    const volumeRecipe = {
      ...pasteRecipe,
      body: "1 cup Bread Flour",
    }
    const sources = buildPriceSources([flour, butter], [volumeRecipe], {
      measures: [rangedCatalogMeasure],
    })

    expect(sources.some((entry) => entry.id === "paste")).toBe(false)
  })

  // --- the component graph ------------------------------------------------

  it("prices a component that consumes another component", () => {
    const base = {
      id: "base",
      title: "Pastry cream",
      kind: "component" as const,
      body: "1000 g Bread Flour",
      yieldAmount: 1,
      yieldUnit: "kg",
    }
    // Pass 1 cannot price this against the pantry alone; pass 2 can.
    const nested = {
      id: "nested",
      title: "Chocolate cream",
      kind: "component" as const,
      body: "500 g Pastry cream",
      yieldAmount: 500,
      yieldUnit: "g",
    }
    const sources = buildPriceSources([flour, butter], [base, nested])

    const chocolate = sources.find((entry) => entry.id === "nested")
    expect(chocolate?.purchaseSize).toBe(500)
    // Flour is 0.074 ¢/g, so 500 g of pastry cream costs 37¢ and the nested
    // component never marks the chain up.
    expect(chocolate?.purchaseCostCents).toBe(37)
    expect(
      priceRecipeBody("250 g Chocolate cream", sources).unpricedCount
    ).toBe(0)
  })

  it("never prices a component off itself", () => {
    const loop = {
      id: "loop",
      title: "Loop",
      kind: "component" as const,
      body: "100 g Bread Flour\n100 g Loop",
      yieldAmount: 200,
      yieldUnit: "g",
    }
    const sources = buildPriceSources([flour, butter], [loop])

    expect(sources.some((entry) => entry.id === "loop")).toBe(false)
  })

  it("never resolves a two-component cycle", () => {
    const alpha = {
      id: "alpha",
      title: "Alpha",
      kind: "component" as const,
      body: "100 g Bread Flour\n100 g Beta",
      yieldAmount: 200,
      yieldUnit: "g",
    }
    const beta = {
      id: "beta",
      title: "Beta",
      kind: "component" as const,
      body: "100 g Bread Flour\n100 g Alpha",
      yieldAmount: 200,
      yieldUnit: "g",
    }
    const sources = buildPriceSources([flour, butter], [alpha, beta])

    expect(sources.some((entry) => entry.source === "component")).toBe(false)
  })

  it("lets a component win a name tie with a purchased ingredient", () => {
    const bought: PriceListEntry = {
      id: "bought-sauce",
      name: "Tomato sauce",
      normalizedName: "tomato sauce",
      purchaseCostCents: 5000,
      purchaseSize: 1000,
      purchaseUnit: "g",
    }
    const made = {
      id: "made-sauce",
      title: "Tomato sauce",
      kind: "component" as const,
      body: "1000 g Bread Flour",
      yieldAmount: 1000,
      yieldUnit: "g",
    }
    const sources = buildPriceSources([flour, bought], [made])
    const line = priceRecipeBody("100 g Tomato sauce", sources).lines[0]

    // The made sauce (7.4¢/100 g) wins over the bought one (500¢/100 g); the
    // lines table's component badge is what discloses the swap.
    expect(line.ingredientId).toBe("made-sauce")
    expect(line.costCents).toBeCloseTo(7.4, 1)
  })

  it("costs a component from its declared weight yield", () => {
    const reduced = {
      id: "reduced",
      title: "Reduced stock",
      kind: "component" as const,
      body: "1000 g Bread Flour",
      yieldAmount: 1000,
      yieldUnit: "g",
    }
    const sources = buildPriceSources([flour, butter], [reduced])

    // One recipe, one unit cost: the divisor here is the same sellable yield
    // the recipe's own per-unit row divides by.
    expect(sources.find((entry) => entry.id === "reduced")?.purchaseSize).toBe(
      1000
    )
  })

  it("refuses a piece-yield component measured by weight", () => {
    const dough = {
      id: "dough",
      title: "Brioche dough",
      kind: "component" as const,
      body: "1000 g Bread Flour",
      yieldAmount: 24,
      yieldUnit: "pcs",
    }
    const sources = buildPriceSources([flour, butter], [dough])
    const byWeight = priceRecipeBody("200 g Brioche dough", sources)
    const byPiece = priceRecipeBody("2 ea Brioche dough", sources)

    // A piece yield says nothing about finished weight, so the gram reading is
    // refused rather than costed at the raw dough's density.
    expect(byWeight.unpricedCount).toBe(1)
    expect(byWeight.lines[0].costCents).toBeNull()
    expect(byPiece.unpricedCount).toBe(0)
    expect(byPiece.lines[0].costCents).toBeCloseTo((2 * 74) / 24, 4)
  })

  it("reaches a catalog measure through an ingredient profile name", () => {
    // Pairs with `test_recipe_health_reaches_a_catalog_measure_through_a_profile
    // _name`: both engines must weigh "strong flour" from the "bread flour"
    // catalog measure, or the editor and the recipe list disagree on cost.
    const breadFlourCup: IngredientMeasure = {
      ...flourCup,
      id: "catalog-bread-flour-cup",
      ingredientId: null,
      grams: 136,
      source: "catalog",
    }
    const result = priceRecipeBody(
      "2 cups strong flour",
      [],
      [],
      [breadFlourCup]
    )

    expect(result.lines[0].grams).toBeCloseTo(272, 6)
  })
})

describe("costing in the unit of sale", () => {
  const caseOfEggs = {
    id: "eggs",
    name: "Eggs",
    normalizedName: "eggs",
    purchaseCostCents: 1800,
    purchaseSize: 1,
    purchaseUnit: "case",
    conversion: {
      usesStandardConversion: false,
      weight: null,
      volume: null,
      each: { amount: 36, unit: "each" },
    },
  }

  it("prices a counted line off the case without any weight", () => {
    const { lines, totalCents, unpricedCount } = priceIngredientLines(
      [{ name: "Eggs", amount: 2, unit: "each", grams: null }],
      [caseOfEggs]
    )
    // Two of thirty-six eggs in an $18.00 case.
    expect(totalCents).toBeCloseTo(100)
    expect(lines[0].basis).toBe("stated-conversion")
    expect(unpricedCount).toBe(0)
  })

  it("prices the sale unit itself with no conversion at all", () => {
    const { totalCents, lines } = priceIngredientLines(
      [{ name: "Eggs", amount: 2, unit: "case", grams: null }],
      [caseOfEggs]
    )
    expect(totalCents).toBeCloseTo(3600)
    expect(lines[0].basis).toBe("sale-unit")
  })

  it("leaves a weight line unpriced when nothing says what a case weighs", () => {
    const { lines, unpricedCount } = priceIngredientLines(
      [{ name: "Eggs", amount: 20, unit: "g", grams: 20 }],
      [caseOfEggs]
    )
    expect(lines[0].costCents).toBeNull()
    expect(lines[0].needsConversion).toBe(true)
    expect(unpricedCount).toBe(1)
  })

  it("uses a stated weight conversion when the line is in weight", () => {
    const withWeight = {
      ...caseOfEggs,
      conversion: {
        ...caseOfEggs.conversion,
        weight: { amount: 1800, unit: "g" },
      },
    }
    const { totalCents, lines } = priceIngredientLines(
      [{ name: "Eggs", amount: 900, unit: "g", grams: 900 }],
      [withWeight]
    )
    // Half a case by weight is half its price, and it took a conversion to
    // know that, so the row says so.
    expect(totalCents).toBeCloseTo(900)
    expect(lines[0].basis).toBe("stated-conversion")
  })

  // A 1 lb block with a catalog density on it: 227 g of it is 1 cup. The two
  // measures state one equivalence about the butter, not two readings of the
  // block, so the block's own weight is what a cup is a share of.
  const blockOfButter: PriceListEntry = {
    id: "unsalted-butter",
    name: "Unsalted butter",
    normalizedName: "unsalted butter",
    purchaseCostCents: 499,
    purchaseSize: 1,
    purchaseUnit: "lb",
    conversion: {
      usesStandardConversion: false,
      weight: { amount: 227, unit: "g" },
      volume: { amount: 1, unit: "cup" },
      each: null,
    },
  }
  const halfABlock = 499 * (227 / 453.59237)

  it("reads a stated density as a ratio, not as the pack", () => {
    const { totalCents, lines, unpricedCount } = priceIngredientLines(
      [{ name: "Unsalted butter", amount: 1, unit: "cup", grams: null }],
      [blockOfButter]
    )
    // A cup is 227 g, half of a 454 g block, so half of $4.99 and not all
    // of it.
    expect(totalCents).toBeCloseTo(halfABlock, 6)
    expect(totalCents).toBeCloseTo(250, 0)
    expect(lines[0].basis).toBe("stated-conversion")
    expect(unpricedCount).toBe(0)
  })

  it("costs a cup exactly as the grams that cup states", () => {
    const { totalCents } = priceIngredientLines(
      [{ name: "Unsalted butter", amount: 227, unit: "g", grams: 227 }],
      [blockOfButter]
    )
    expect(totalCents).toBeCloseTo(halfABlock, 6)
  })

  it("scales a stated density by the pack it is bought in", () => {
    const drum = { ...blockOfButter, purchaseSize: 25, purchaseUnit: "kg" }
    const { totalCents } = priceIngredientLines(
      [{ name: "Unsalted butter", amount: 1, unit: "cup", grams: null }],
      [drum]
    )
    // The same cup is a much smaller share of a 25 kg drum, and the drum's
    // price is what it is a share of.
    expect(totalCents).toBeCloseTo(499 * (227 / 25000), 6)
  })

  it("leaves a line unpriced when nothing stated reaches the pack", () => {
    // Bought by the piece, with a density on it and no piece weight anywhere:
    // 227 g is 1 cup says nothing about what one piece is.
    const byThePiece = {
      ...blockOfButter,
      purchaseSize: 1,
      purchaseUnit: "each",
    }
    const { lines, unpricedCount } = priceIngredientLines(
      [{ name: "Unsalted butter", amount: 1, unit: "cup", grams: null }],
      [byThePiece]
    )
    expect(lines[0].costCents).toBeNull()
    expect(lines[0].needsConversion).toBe(true)
    expect(unpricedCount).toBe(1)
  })

  it("cannot bridge a container unit from the standard table alone", () => {
    const standard = {
      ...caseOfEggs,
      conversion: { ...caseOfEggs.conversion, usesStandardConversion: true },
    }
    const { lines, unpricedCount } = priceIngredientLines(
      [{ name: "Eggs", amount: 3, unit: "each", grams: null }],
      [standard]
    )
    // Nothing shared knows how many eggs a case holds; only the kitchen does.
    expect(lines[0].costCents).toBeNull()
    expect(lines[0].needsConversion).toBe(true)
    expect(unpricedCount).toBe(1)
  })

  it("flags the standard conversion when one answers the line", () => {
    const flour = {
      id: "flour",
      name: "Flour",
      normalizedName: "flour",
      purchaseCostCents: 100,
      purchaseSize: 1,
      purchaseUnit: "kg",
    }
    // A cup of flour reaches grams through the shared density chart, so the
    // row says the number came from a conversion rather than the unit bought.
    const { totalCents, lines } = priceIngredientLines(
      [{ name: "Flour", amount: 1, unit: "cup", grams: 120 }],
      [flour]
    )
    expect(totalCents).toBeCloseTo(12)
    expect(lines[0].basis).toBe("automatic-conversion")
  })

  it("weighs a volume-bought ingredient from the standard table", () => {
    const milk = {
      id: "milk",
      name: "Milk",
      normalizedName: "milk",
      purchaseCostCents: 200,
      purchaseSize: 1,
      purchaseUnit: "l",
    }
    // A litre of milk weighs 1031.34 g, so 100 g is 9.6961% of a $2.00 litre.
    const { totalCents, lines, unpricedCount } = priceIngredientLines(
      [{ name: "Milk", amount: 100, unit: "g", grams: 100 }],
      [milk]
    )
    expect(totalCents).toBeCloseTo(19.392, 3)
    expect(lines[0].basis).toBe("automatic-conversion")
    expect(unpricedCount).toBe(0)
  })

  it("leaves a stated conversion the last word over the standard table", () => {
    const milk = {
      id: "milk",
      name: "Milk",
      normalizedName: "milk",
      purchaseCostCents: 200,
      purchaseSize: 1,
      purchaseUnit: "l",
      conversion: {
        usesStandardConversion: false,
        weight: null,
        volume: null,
        each: { amount: 4, unit: "each" },
      },
    }
    // The kitchen said what a litre comes to and did not say a weight, so
    // the shared table does not answer over the top of it.
    const { lines, unpricedCount } = priceIngredientLines(
      [{ name: "Milk", amount: 100, unit: "g", grams: 100 }],
      [milk]
    )
    expect(lines[0].costCents).toBeNull()
    expect(unpricedCount).toBe(1)
  })

  it("takes no standard density for a line the parser would not weigh", () => {
    const milk = {
      id: "milk",
      name: "Milk",
      normalizedName: "milk",
      purchaseCostCents: 200,
      purchaseSize: 1,
      purchaseUnit: "l",
    }
    const { lines, unpricedCount } = priceIngredientLines(
      [
        {
          name: "Milk, scalded",
          amount: 100,
          unit: "g",
          grams: 100,
          qualifier: "scalded",
        },
      ],
      [milk]
    )
    expect(lines[0].costCents).toBeNull()
    expect(unpricedCount).toBe(1)
  })

  it("still prices a weight-bought ingredient exactly as before", () => {
    const flour = {
      id: "flour",
      name: "Flour",
      normalizedName: "flour",
      purchaseCostCents: 100,
      purchaseSize: 1,
      purchaseUnit: "kg",
    }
    const { totalCents, lines } = priceIngredientLines(
      [{ name: "Flour", amount: 200, unit: "g", grams: 200 }],
      [flour]
    )
    expect(totalCents).toBeCloseTo(20)
    expect(lines[0].basis).toBe("sale-unit")
  })
})

describe("costing a preparation of an ingredient", () => {
  // One sale unit is a 1 kg head. The ingredient itself says a head is 8 cups
  // whole; shredded, the same head is only 4 cups, and cooked it comes back at
  // half its weight. Those are three different answers to "how much of what we
  // bought is this line", and the line's qualifier picks between them.
  const cabbage: PriceListEntry = {
    id: "cabbage",
    name: "Cabbage",
    normalizedName: "cabbage",
    purchaseCostCents: 300,
    purchaseSize: 1000,
    purchaseUnit: "g",
    conversion: {
      usesStandardConversion: false,
      weight: null,
      volume: { amount: 8, unit: "cup" },
      each: null,
    },
    preparations: [
      {
        id: "shredded",
        name: "Shredded",
        yieldPercent: null,
        usesStandardConversion: false,
        weight: { amount: 1000, unit: "g" },
        volume: { amount: 4, unit: "cup" },
        each: null,
      },
      {
        id: "cooked",
        name: "Cooked",
        yieldPercent: 50,
        usesStandardConversion: true,
        weight: null,
        volume: null,
        each: null,
      },
    ],
  }

  const garlic: PriceListEntry = {
    id: "garlic",
    name: "Garlic",
    normalizedName: "garlic",
    purchaseCostCents: 400,
    purchaseSize: 1000,
    purchaseUnit: "g",
    preparations: [
      {
        id: "minced",
        name: "Minced",
        yieldPercent: 88,
        usesStandardConversion: true,
        weight: null,
        volume: null,
        each: null,
      },
    ],
  }

  /** A $10 case of ten pounds, 90% of which survives the trim. */
  const tomatoes: PriceListEntry = {
    id: "tomatoes",
    name: "Tomatoes",
    normalizedName: "tomatoes",
    purchaseCostCents: 1000,
    purchaseSize: 10,
    purchaseUnit: "lb",
    yieldPercent: 90,
  }

  it("uses the preparation's own conversion, not the ingredient's", () => {
    const { totalCents, lines } = priceIngredientLines(
      [
        {
          name: "Cabbage, shredded",
          amount: 2,
          unit: "cup",
          grams: null,
          qualifier: "shredded",
        },
      ],
      [cabbage]
    )
    // Two of the four cups a head shreds to is half a $3.00 head. The
    // ingredient's own eight-cups-a-head row would have said $0.75.
    expect(totalCents).toBeCloseTo(150)
    expect(lines[0].basis).toBe("stated-conversion")
  })

  it("does not fill an incomplete custom preparation from the ingredient", () => {
    const partial: PriceListEntry = {
      ...cabbage,
      preparations: [
        {
          ...cabbage.preparations![0],
          weight: null,
        },
      ],
    }
    const result = priceIngredientLines(
      [
        {
          name: "Cabbage, shredded",
          amount: 2,
          unit: "cup",
          grams: 250,
          qualifier: "shredded",
        },
      ],
      [partial]
    )
    expect(result.totalCents).toBe(0)
    expect(result.unpricedCount).toBe(1)
    expect(result.lines[0].needsConversion).toBe(true)
  })

  it("lets an explicitly written weight bypass an incomplete custom conversion", () => {
    const empty: PriceListEntry = {
      ...cabbage,
      preparations: [
        {
          ...cabbage.preparations![0],
          weight: null,
          volume: null,
        },
      ],
    }
    const parsed = parseRecipeText("2 each (250 g total) cabbage, shredded", {
      identities: [empty],
    })
    const result = priceParsedLines(parsed.parsedLines, [empty])
    expect(result.unpricedCount).toBe(0)
    expect(result.totalCents).toBeCloseTo(75)
  })

  it("buys enough raw to cover a yield, not less", () => {
    const { totalCents, lines } = priceIngredientLines(
      [
        {
          name: "Garlic, minced",
          amount: 100,
          unit: "g",
          grams: 100,
          qualifier: "minced",
        },
      ],
      [garlic]
    )
    // 100 g of minced garlic at 88% yield needs 113.6 g of garlic bought, so
    // the line costs more than the same 100 g unprepped, never less.
    expect(totalCents).toBeCloseTo((100 / 1000) * (100 / 88) * 400)
    expect(totalCents).toBeGreaterThan(40)
    expect(lines[0].basis).toBe("sale-unit")
  })

  it("costs a seeded yield exactly as a measured one", () => {
    // Pairs with `test_a_seeded_yield_costs_a_line_exactly_as_a_measured_one
    // _does`: a catalog seed says where 88% came from and nothing else, so the
    // editor and the recipe list must reach the same cents.
    const seeded: PriceListEntry = {
      ...garlic,
      preparations: [{ ...garlic.preparations![0], source: "catalog" }],
    }
    const line = {
      name: "Garlic, minced",
      amount: 100,
      unit: "g",
      grams: 100,
      qualifier: "minced",
    }

    expect(priceIngredientLines([line], [seeded]).totalCents).toBeCloseTo(
      priceIngredientLines([line], [garlic]).totalCents
    )
    expect(priceIngredientLines([line], [seeded]).totalCents).toBeCloseTo(
      (100 / 1000) * (100 / 88) * 400
    )
  })

  it("borrows the ingredient's conversion when the preparation states none", () => {
    const { totalCents } = priceIngredientLines(
      [
        {
          name: "Cabbage, cooked",
          amount: 2,
          unit: "cup",
          grams: null,
          qualifier: "cooked",
        },
      ],
      [cabbage]
    )
    // The pack it is bought as is its own row, so two of the head's eight cups
    // is a quarter head — doubled, because half the weight cooks away.
    expect(totalCents).toBeCloseTo(150)
  })

  it("falls back to the ingredient when no preparation is named that way", () => {
    const { totalCents } = priceIngredientLines(
      [
        {
          name: "Cabbage, chopped",
          amount: 2,
          unit: "cup",
          grams: null,
          qualifier: "chopped",
        },
      ],
      [cabbage]
    )
    expect(totalCents).toBeCloseTo(75)
  })

  it("prices an unqualified line as the ingredient as bought", () => {
    const { totalCents } = priceIngredientLines(
      [{ name: "Cabbage", amount: 2, unit: "cup", grams: null }],
      [cabbage]
    )
    // No preparation may attach itself to a line that asked for none.
    expect(totalCents).toBeCloseTo(75)
  })

  it("carries the qualifier from the written line through to the price", () => {
    const { totalCents, lines } = priceRecipeBody("100 g garlic, minced", [
      garlic,
    ])
    expect(totalCents).toBeCloseTo((100 / 1000) * (100 / 88) * 400)
    expect(lines[0].costCents).toBeCloseTo((100 / 1000) * (100 / 88) * 400)
  })

  it("selects one exact preparation clause from a parsed compound note", () => {
    const { totalCents } = priceRecipeBody("100 g garlic, minced, cooked", [
      garlic,
    ])
    expect(totalCents).toBeCloseTo((100 / 1000) * (100 / 88) * 400)
  })

  it("matches a multi-word qualifier whole", () => {
    const finely: PriceListEntry = {
      ...garlic,
      preparations: [
        { ...garlic.preparations![0], id: "fine", name: "Finely Minced" },
      ],
    }
    const { totalCents } = priceRecipeBody("100 g garlic, finely minced", [
      finely,
    ])
    expect(totalCents).toBeCloseTo((100 / 1000) * (100 / 88) * 400)
    // And the same prep does not answer a line that named only part of it.
    expect(priceRecipeBody("100 g garlic, minced", [finely]).totalCents).toBe(
      40
    )
  })

  it("selects an exact preparation from a compound note", () => {
    const result = priceIngredientLines(
      [
        {
          name: "Garlic",
          amount: 100,
          unit: "g",
          grams: 100,
          preparationNote: "minced, room temperature; 100 g",
        },
      ],
      [garlic]
    )
    expect(result.totalCents).toBeCloseTo((100 / 1000) * (100 / 88) * 400)
  })

  it("does not select a preparation by substring", () => {
    const result = priceIngredientLines(
      [
        {
          name: "Garlic",
          amount: 100,
          unit: "g",
          grams: 100,
          preparationNote: "finely minced",
        },
      ],
      [garlic]
    )
    expect(result.totalCents).toBeCloseTo(40)
  })

  it("divides an unprepped line by the ingredient's own yield", () => {
    // Pairs with `test_a_pound_costs_what_the_trim_makes_it_cost`. ChefTec's
    // usable factor: a $10 case of tomatoes at 90% costs $11.11 a case of
    // usable tomato, so 1 lb of the ten costs $1.11 and not $1.00.
    const { totalCents } = priceIngredientLines(
      [{ name: "Tomatoes", amount: 1, unit: "lb", grams: null }],
      [tomatoes]
    )
    expect(totalCents).toBeCloseTo(1000 / 10 / 0.9)
    expect(totalCents).toBeCloseTo(111.11, 1)
  })

  it("leaves a full yield alone", () => {
    const { totalCents } = priceIngredientLines(
      [{ name: "Tomatoes", amount: 1, unit: "lb", grams: null }],
      [{ ...tomatoes, yieldPercent: 100 }]
    )
    expect(totalCents).toBeCloseTo(100)
  })

  it("applies the preparation's yield instead of the ingredient's, never both", () => {
    // Pairs with `test_a_named_preparation_replaces_the_ingredient_yield`.
    const diced: PriceListEntry = {
      ...tomatoes,
      preparations: [
        {
          id: "diced",
          name: "Diced",
          yieldPercent: 50,
          usesStandardConversion: true,
          weight: null,
          volume: null,
          each: null,
        },
      ],
    }
    const { totalCents } = priceIngredientLines(
      [
        {
          name: "Tomatoes, diced",
          amount: 1,
          unit: "lb",
          grams: null,
          qualifier: "diced",
        },
      ],
      [diced]
    )
    // Half the diced line's weight, not half of nine tenths of it.
    expect(totalCents).toBeCloseTo(200)
  })
})

describe("priceParsedLines", () => {
  it("returns one line per parsed line, in order", () => {
    const parsed = parseRecipeText(
      "Bread Flour, for dusting\n500 g Bread Flour"
    )
    expect(parsed.parsedLines.map((line) => line.alert)).toEqual([
      "unmeasured",
      null,
    ])

    const result = priceParsedLines(parsed.parsedLines, [flour])

    expect(result.lines).toHaveLength(2)
    expect(result.lines[0].costCents).toBeNull()
    expect(result.lines[1].costCents).toBeCloseTo(37, 0)
    // The unmeasured line is missing nothing, so it is not a gap.
    expect(result.unpricedCount).toBe(0)
  })

  it("leaves an excluded line uncosted and out of the unpriced count", () => {
    const parsed = parseRecipeText("500 g Bread Flour\n100 g Butter")
    const included = priceParsedLines(parsed.parsedLines, [flour, butter])
    const excluded = priceParsedLines(
      parsed.parsedLines.map((line, index) =>
        index === 1 ? { ...line, excludedFromCost: true } : line
      ),
      [flour, butter]
    )

    expect(excluded.lines).toHaveLength(2)
    expect(excluded.lines[1].costCents).toBeNull()
    expect(excluded.unpricedCount).toBe(0)
    expect(excluded.totalCents).toBeCloseTo(
      included.totalCents - (included.lines[1].costCents ?? 0)
    )
  })

  it("still counts a measured line nobody priced", () => {
    const parsed = parseRecipeText("500 g Bread Flour\n380 g Water")
    const result = priceParsedLines(parsed.parsedLines, [flour])

    expect(result.lines).toHaveLength(2)
    expect(result.unpricedCount).toBe(1)
  })
})
