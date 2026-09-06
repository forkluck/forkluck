import { describe, expect, it } from "vitest"

import {
  weighRecipeLines,
  type WeighableLine,
  type WeighSources,
} from "../lib/recipe"

const flour: WeighSources["items"][number] = {
  id: "flour",
  name: "Bread Flour",
  measureName: "Bread Flour",
  purchaseSize: 25,
  purchaseUnit: "kg",
  conversion: null,
}

// The kitchen supplied an unrelated custom measure, so the standard density
// path must stay off and leave a volume line unresolved.
const saffron: WeighSources["items"][number] = {
  id: "saffron",
  name: "Saffron Threads",
  purchaseSize: 10,
  purchaseUnit: "g",
  conversion: {
    usesStandardConversion: false,
    weight: null,
    volume: null,
    each: { amount: 1, unit: "each" },
  },
}

const egg: WeighSources["items"][number] = {
  id: "egg",
  name: "Eggs",
  purchaseSize: 1,
  purchaseUnit: "dozen",
  conversion: {
    usesStandardConversion: false,
    weight: { amount: 600, unit: "g" },
    volume: null,
    each: { amount: 12, unit: "each" },
  },
  // A dozen eggs beaten weigh 600 g and fill 2.4 cups; whole ones fill no
  // cup at all. A preparation states its own measures and borrows none.
  preparations: [
    {
      name: "beaten",
      usesStandardConversion: false,
      weight: { amount: 600, unit: "g" },
      volume: { amount: 2.4, unit: "cup" },
      each: null,
    },
  ],
}

// Sold by the yolk, with no weight of its own: only the preparation says what
// one comes to.
const yolk: WeighSources["items"][number] = {
  id: "yolk",
  name: "Egg yolk",
  purchaseSize: 1,
  purchaseUnit: "each",
  conversion: null,
  preparations: [
    {
      name: "large",
      usesStandardConversion: false,
      weight: { amount: 17, unit: "g" },
      volume: null,
      each: { amount: 1, unit: "each" },
    },
  ],
}

/** One batch, read three ways: 2.75 cup of it, 700 g of it, 8 slices of it. */
const curd: WeighSources["recipes"][number] = {
  id: "curd",
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

const crust: WeighSources["recipes"][number] = {
  id: "crust",
  yieldAmount: 1,
  yieldUnit: "pcs",
  equivalency: null,
}

const standardGlaze: WeighSources["recipes"][number] = {
  id: "standard-glaze",
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

const sources: WeighSources = {
  items: [flour, saffron, egg, yolk],
  recipes: [curd, crust, standardGlaze],
}

function line(fields: Partial<WeighableLine>): WeighableLine {
  return {
    kind: "ingredient",
    quantity: "",
    unit: "g",
    displayName: "",
    preparationNote: "",
    ingredientId: null,
    subrecipeId: null,
    ...fields,
  }
}

describe("weighRecipeLines", () => {
  it("scales a standard density ratio to the recipe total yield", () => {
    const result = weighRecipeLines(
      [
        line({
          kind: "subrecipe",
          quantity: "800",
          unit: "ml",
          subrecipeId: "standard-glaze",
        }),
      ],
      sources
    )

    const batchGrams = (1600 / 236.5882365) * 226.796185
    expect(result.lines[0].grams).toBeCloseTo(batchGrams / 2)
    expect(result.total).toBeCloseTo(batchGrams / 2)
    expect(batchGrams).toBeCloseTo(1533.78, 1)
  })
  it("converts a weight line without asking the ingredient", () => {
    const result = weighRecipeLines(
      [line({ quantity: "1.5", unit: "kg", ingredientId: "flour" })],
      sources
    )
    expect(result.lines[0]).toEqual({ grams: 1500, reason: null })
    expect(result.total).toBe(1500)
  })

  it("weighs a volume line through the shared density chart", () => {
    const result = weighRecipeLines(
      [line({ quantity: "2", unit: "cup", ingredientId: "flour" })],
      sources
    )
    expect(result.lines[0].reason).toBeNull()
    expect(result.lines[0].grams).toBeCloseTo(254, 0)
    expect(result.total).toBeCloseTo(254, 0)
  })

  it("pours a weight line into cups through the ingredient's stated volume", () => {
    const milk: WeighSources["items"][number] = {
      id: "milk",
      name: "Milk",
      conversion: {
        usesStandardConversion: false,
        weight: { amount: 1030, unit: "g" },
        volume: { amount: 1, unit: "l" },
        each: null,
      },
    }
    const result = weighRecipeLines(
      [line({ quantity: "515", unit: "g", ingredientId: "milk" })],
      { items: [milk], recipes: [] },
      "cup"
    )
    expect(result.family).toBe("volume")
    expect(result.lines[0].reason).toBeNull()
    expect(result.total).toBeCloseTo(500, 0)
  })

  it("counts a weight line in pieces through the ingredient's each", () => {
    const result = weighRecipeLines(
      [line({ quantity: "300", unit: "g", ingredientId: "egg" })],
      sources,
      "pcs"
    )
    expect(result.family).toBe("count")
    expect(result.lines[0]).toEqual({ grams: 6, reason: null })
    expect(result.total).toBe(6)
  })

  it("cannot count flour in pieces and says so", () => {
    const result = weighRecipeLines(
      [line({ quantity: "300", unit: "g", ingredientId: "flour" })],
      sources,
      "pcs"
    )
    expect(result.lines[0]).toEqual({ grams: null, reason: "no-conversion" })
    expect(result.total).toBeNull()
  })

  it("weighs a count line through the ingredient's stated conversion", () => {
    const result = weighRecipeLines(
      [line({ quantity: "3", unit: "each", ingredientId: "egg" })],
      sources
    )
    expect(result.lines[0]).toEqual({ grams: 150, reason: null })
  })

  it("weighs a count line through the preparation its note names", () => {
    const result = weighRecipeLines(
      [
        line({
          quantity: "4",
          unit: "each",
          ingredientId: "yolk",
          preparationNote: "large, 2 ounces; 56 g",
        }),
      ],
      sources
    )
    expect(result.lines[0]).toEqual({ grams: 68, reason: null })
    expect(result.total).toBe(68)
  })

  it("cannot weigh the same line when its note names no preparation", () => {
    const result = weighRecipeLines(
      [
        line({
          quantity: "4",
          unit: "each",
          ingredientId: "yolk",
          preparationNote: "room temperature",
        }),
      ],
      sources
    )
    expect(result.lines[0]).toEqual({ grams: null, reason: "no-conversion" })
  })

  it("falls back to the ingredient's own conversion for an unnamed state", () => {
    const result = weighRecipeLines(
      [
        line({
          quantity: "3",
          unit: "each",
          ingredientId: "egg",
          preparationNote: "large, room temperature",
        }),
      ],
      sources
    )
    expect(result.lines[0]).toEqual({ grams: 150, reason: null })
  })

  it("converts cups through a preparation that states a volume", () => {
    const result = weighRecipeLines(
      [
        line({
          quantity: "1",
          unit: "cup",
          ingredientId: "egg",
          preparationNote: "beaten",
        }),
      ],
      sources
    )
    expect(result.lines[0]).toEqual({ grams: 250, reason: null })
  })

  it("does not fill a partial custom preparation from the ingredient", () => {
    const partial: WeighSources["items"][number] = {
      ...egg,
      preparations: [
        {
          name: "separated",
          usesStandardConversion: false,
          weight: null,
          volume: null,
          each: { amount: 12, unit: "each" },
        },
      ],
    }
    const result = weighRecipeLines(
      [
        line({
          quantity: "3",
          unit: "each",
          ingredientId: "egg",
          preparationNote: "separated, room temperature",
        }),
      ],
      { items: [partial], recipes: [] }
    )
    expect(result.lines[0]).toEqual({ grams: null, reason: "no-conversion" })
  })

  it("lets a standard preparation use the ingredient conversion", () => {
    const standard: WeighSources["items"][number] = {
      ...egg,
      preparations: [
        {
          name: "room temperature",
          usesStandardConversion: true,
          weight: null,
          volume: null,
          each: null,
        },
      ],
    }
    const result = weighRecipeLines(
      [
        line({
          quantity: "3",
          unit: "each",
          ingredientId: "egg",
          preparationNote: "room temperature",
        }),
      ],
      { items: [standard], recipes: [] }
    )
    expect(result.lines[0]).toEqual({ grams: 150, reason: null })
  })

  it("weighs a cup from a stated density, not from the pack", () => {
    // The two measures are one equivalence about the butter: 227 g of it is a
    // cup of it, and the 1 lb block is two of those cups. Costing reads the
    // same pair the same way, so a cup of this block is half its price.
    const butter: WeighSources["items"][number] = {
      id: "butter",
      name: "Unsalted butter",
      purchaseSize: 1,
      purchaseUnit: "lb",
      conversion: {
        usesStandardConversion: false,
        weight: { amount: 227, unit: "g" },
        volume: { amount: 1, unit: "cup" },
        each: null,
      },
    }
    const result = weighRecipeLines(
      [line({ quantity: "1", unit: "cup", ingredientId: "butter" })],
      { items: [butter], recipes: [] }
    )
    expect(result.lines[0]).toEqual({ grams: 227, reason: null })
  })

  it("holds the total back when a volume line has no conversion", () => {
    const result = weighRecipeLines(
      [
        line({ quantity: "500", unit: "g", ingredientId: "flour" }),
        line({ quantity: "1", unit: "tsp", ingredientId: "saffron" }),
      ],
      sources
    )
    expect(result.lines[1]).toEqual({ grams: null, reason: "no-conversion" })
    expect(result.total).toBeNull()
  })

  it("uses the standard cup estimate for an unrecognized ingredient", () => {
    const pimenton = {
      ...saffron,
      id: "pimenton",
      name: "Pimentón de la Vera",
      conversion: null,
    }
    const result = weighRecipeLines(
      [line({ quantity: "1", unit: "cup", ingredientId: "pimenton" })],
      { items: [pimenton], recipes: [] }
    )

    expect(result.lines[0].grams).toBeCloseTo(226.796185, 6)
    expect(result.lines[0].reason).toBeNull()
  })

  it("reports a line linked to nothing as unlinked", () => {
    const result = weighRecipeLines(
      [line({ quantity: "200", unit: "g", displayName: "Rye flour" })],
      sources
    )
    expect(result.lines[0]).toEqual({ grams: null, reason: "unlinked" })
    expect(result.total).toBeNull()
  })

  it("reports a blank or zero quantity before asking anything else", () => {
    const result = weighRecipeLines(
      [
        line({ quantity: "  ", unit: "g", ingredientId: "flour" }),
        line({ quantity: "0", unit: "g", ingredientId: "flour" }),
      ],
      sources
    )
    expect(result.lines[0]).toEqual({ grams: null, reason: "no-quantity" })
    expect(result.lines[1]).toEqual({ grams: null, reason: "no-quantity" })
    expect(result.total).toBeNull()
  })

  it("skips headers and notes without holding the total back", () => {
    const result = weighRecipeLines(
      [
        line({ kind: "header", displayName: "Dough" }),
        line({ kind: "note", displayName: "Rest overnight" }),
        line({ quantity: "500", unit: "g", ingredientId: "flour" }),
      ],
      sources
    )
    expect(result.lines[0]).toEqual({ grams: null, reason: null })
    expect(result.lines[1]).toEqual({ grams: null, reason: null })
    expect(result.total).toBe(500)
  })

  it("sums weights, counts and a sub-recipe into one batch", () => {
    const result = weighRecipeLines(
      [
        line({ kind: "header", displayName: "Batter" }),
        line({ quantity: "500", unit: "g", ingredientId: "flour" }),
        line({ quantity: "2", unit: "each", ingredientId: "egg" }),
        line({
          kind: "subrecipe",
          quantity: "1",
          unit: "kg",
          subrecipeId: "custard",
        }),
      ],
      sources
    )
    expect(result.total).toBe(500 + 100 + 1000)
  })

  it("cannot weigh pieces of a sub-recipe", () => {
    const result = weighRecipeLines(
      [
        line({
          kind: "subrecipe",
          quantity: "2",
          unit: "each",
          subrecipeId: "custard",
        }),
      ],
      sources
    )
    expect(result.lines[0]).toEqual({ grams: null, reason: "sub-recipe" })
    expect(result.total).toBeNull()
  })
})

describe("a sub-recipe line written in another unit family", () => {
  const withCurd: WeighSources = { ...sources, recipes: [curd, crust] }

  it("weighs a cup of it as that share of the batch's weight", () => {
    const result = weighRecipeLines(
      [
        line({
          kind: "subrecipe",
          quantity: "1",
          unit: "cup",
          subrecipeId: "curd",
        }),
      ],
      withCurd,
      "g"
    )
    expect(result.lines[0].reason).toBeNull()
    // 700 g a batch, 2.75 cup a batch: a cup of it weighs 700/2.75.
    expect(result.lines[0].grams).toBeCloseTo(254.5455, 3)
    expect(result.total).toBeCloseTo(254.5455, 3)
  })

  it("counts a whole batch of it as the pieces the batch cuts into", () => {
    const result = weighRecipeLines(
      [
        line({
          kind: "subrecipe",
          quantity: "2.75",
          unit: "cup",
          subrecipeId: "curd",
        }),
      ],
      withCurd,
      "each"
    )
    expect(result.family).toBe("count")
    expect(result.lines[0].reason).toBeNull()
    expect(result.lines[0].grams).toBeCloseTo(8, 6)
  })

  it("counts a piece of a counted sub-recipe without an equivalency", () => {
    const result = weighRecipeLines(
      [
        line({
          kind: "subrecipe",
          quantity: "1",
          unit: "each",
          subrecipeId: "crust",
        }),
      ],
      withCurd,
      "each"
    )
    expect(result.lines[0]).toEqual({ grams: 1, reason: null })
    expect(result.total).toBe(1)
  })

  it("counts a whole batch into a yield written in slices", () => {
    const result = weighRecipeLines(
      [
        line({
          kind: "subrecipe",
          quantity: "2.75",
          unit: "cup",
          subrecipeId: "curd",
        }),
      ],
      withCurd,
      "slice"
    )
    expect(result.family).toBe("count")
    expect(result.lines[0].reason).toBeNull()
    // The batch is 8 each, and 8 each is 8 slices.
    expect(result.lines[0].grams).toBeCloseTo(8, 6)
    expect(result.total).toBeCloseTo(8, 6)
  })

  it("counts a slice of a counted sub-recipe as one of its pieces", () => {
    const tart: WeighSources = {
      ...sources,
      recipes: [{ id: "tart", yieldAmount: 8, yieldUnit: "slice" }],
    }
    const result = weighRecipeLines(
      [
        line({
          kind: "subrecipe",
          quantity: "1",
          unit: "slice",
          subrecipeId: "tart",
        }),
      ],
      tart,
      "pcs"
    )
    expect(result.family).toBe("count")
    expect(result.lines[0]).toEqual({ grams: 1, reason: null })
    expect(result.total).toBe(1)
  })

  it("counts a piece of a sliced sub-recipe, and a slice of a pieced one", () => {
    const both: WeighSources = {
      ...sources,
      recipes: [{ id: "tart", yieldAmount: 8, yieldUnit: "slice" }, crust],
    }
    const asPieces = weighRecipeLines(
      [
        line({
          kind: "subrecipe",
          quantity: "3",
          unit: "pcs",
          subrecipeId: "tart",
        }),
      ],
      both,
      "slice"
    )
    expect(asPieces.total).toBe(3)
    const asSlices = weighRecipeLines(
      [
        line({
          kind: "subrecipe",
          quantity: "1",
          unit: "slice",
          subrecipeId: "crust",
        }),
      ],
      both,
      "pcs"
    )
    expect(asSlices.total).toBe(1)
  })

  it("says so when nothing relates the two families", () => {
    const plain: WeighSources = {
      ...sources,
      recipes: [{ id: "curd", yieldAmount: 2.75, yieldUnit: "cup" }],
    }
    const result = weighRecipeLines(
      [
        line({
          kind: "subrecipe",
          quantity: "1",
          unit: "cup",
          subrecipeId: "curd",
        }),
      ],
      plain,
      "g"
    )
    expect(result.lines[0]).toEqual({ grams: null, reason: "sub-recipe" })
    expect(result.total).toBeNull()
  })
})
