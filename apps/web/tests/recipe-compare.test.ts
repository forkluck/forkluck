import { describe, expect, it } from "vitest"

import type { RecipeDetail, RecipeNutrition } from "@/lib/backend/types"
import type { PriceListEntry } from "@/lib/pricing"
import { analyzeRecipe } from "@/lib/recipe/analyze"
import {
  buildFormula,
  canonicalFormulaName,
  classifyFormulaRole,
  compareFormulas,
  compareHref,
  gramOverrideKey,
  MAX_COMPARE_RECIPES,
  parseCompareIds,
  pastedFormulaInput,
  savedFormulaInput,
  type FormulaInput,
  type FormulaLineInput,
} from "@/lib/recipe/compare"
import { SAMPLE_RECIPE } from "@/lib/recipe/data"

/**
 * Two recipes side by side, read the way a baker reads them: every flour
 * line together is 100%, and nothing a recipe wrote disappears from the
 * page because it could not be weighed.
 */

function line(
  id: string,
  name: string,
  grams: number | null,
  extra: Partial<FormulaLineInput> = {}
): FormulaLineInput {
  return { id, name, grams, written: grams === null ? "1 cup" : "", ...extra }
}

function formula(
  key: string,
  lines: FormulaLineInput[],
  source: "saved" | "pasted" = "saved"
): FormulaInput {
  return { key, title: key, source, lines }
}

function entry(
  partial: Partial<PriceListEntry> & { name: string }
): PriceListEntry {
  return {
    id: partial.name.toLowerCase(),
    normalizedName: partial.name.toLowerCase(),
    purchaseCostCents: 100,
    ...partial,
  }
}

const COUNTRY_LOAF = formula("loaf", [
  line("1", "Bread flour", 500),
  line("2", "Whole wheat flour", 100),
  line("3", "Water", 400),
  line("4", "Fine sea salt", 12),
  line("5", "Instant yeast", 6),
])

describe("classifyFormulaRole", () => {
  it.each([
    ["Bread flour", "flour"],
    ["Whole milk", "liquid"],
    ["Warm water", "liquid"],
    ["Unsalted butter", "fat"],
    ["Honey", "sweetener"],
    ["Fine sea salt", "salt"],
    ["Egg yolks", "egg"],
    ["3 large eggs", "egg"],
    ["Instant yeast", "leavening"],
    ["Baking powder", "leavening"],
    ["Tomatoes", "other"],
  ] as const)("reads the profile first: %s → %s", (name, role) => {
    expect(classifyFormulaRole(name)).toBe(role)
  })

  it.each([
    ["Almond flour", "flour"],
    ["Rye flour", "flour"],
    ["Cornstarch", "flour"],
    ["Buttermilk", "liquid"],
    ["Heavy cream", "liquid"],
    ["Milk powder", "other"],
    ["Cream cheese", "fat"],
    ["Salted butter", "fat"],
    ["Coconut oil", "fat"],
    ["Brown sugar", "sweetener"],
    ["Maple syrup", "sweetener"],
    ["Baking soda", "leavening"],
    ["Sourdough starter", "leavening"],
    ["Egg whites", "egg"],
    ["Kosher salt", "salt"],
    ["Chocolate chips", "other"],
    ["Vanilla extract", "other"],
  ] as const)("falls back to the name: %s → %s", (name, role) => {
    expect(classifyFormulaRole(name)).toBe(role)
  })

  it("never reads a sub-recipe as an ingredient", () => {
    expect(classifyFormulaRole("Honey", true)).toBe("other")
    expect(classifyFormulaRole("Bread flour", true)).toBe("other")
  })
})

describe("canonicalFormulaName", () => {
  it("meets spellings of one profile on one row", () => {
    expect(canonicalFormulaName("warm water").key).toBe(
      canonicalFormulaName("Water").key
    )
    expect(canonicalFormulaName("eggs").key).toBe(
      canonicalFormulaName("Whole egg").key
    )
    expect(canonicalFormulaName("Bread flour").label).toBe("Bread flour")
    // A plural the profile does not list still reaches it once folded.
    expect(canonicalFormulaName("Whole Eggs").key).toBe(
      canonicalFormulaName("large eggs").key
    )
  })

  it("folds plurals and annotations for names no profile knows", () => {
    expect(canonicalFormulaName("Almond flours").key).toBe(
      canonicalFormulaName("almond flour, sifted").key
    )
    expect(canonicalFormulaName("Rye flour").key).not.toBe(
      canonicalFormulaName("Bread flour").key
    )
  })
})

describe("buildFormula", () => {
  it("states every line against the flour lines together", () => {
    const built = buildFormula(COUNTRY_LOAF, "bakers")
    expect(built.basis).toBe("flour")
    expect(built.basisGrams).toBe(600)
    expect(built.basisLabel).toBe("Bread flour + Whole wheat flour")
    const percent = Object.fromEntries(
      built.lines.map((row) => [row.label, row.percent])
    )
    expect(percent).toEqual({
      "Bread flour": 83.3,
      "Whole wheat flour": 16.7,
      Water: 66.7,
      "Fine sea salt": 2,
      "Instant yeast": 1,
    })
    expect(built.roleTotals.flour).toEqual({ grams: 600, percent: 100 })
    expect(built.roleTotals.liquid).toEqual({ grams: 400, percent: 66.7 })
    expect(built.totalGrams).toBe(1018)
    expect(built.totalPercent).toBe(169.7)
  })

  it("reads weight mode as a share of the whole", () => {
    const built = buildFormula(COUNTRY_LOAF, "weight")
    expect(built.basis).toBe("total")
    expect(built.basisGrams).toBe(1018)
    expect(built.lines.find((row) => row.label === "Water")?.percent).toBe(39.3)
    expect(built.totalPercent).toBe(100)
    // The summary is a baker's reading whatever the column shows.
    expect(built.summary.hydration).toBe(66.7)
  })

  it("falls back to the marked base line, then the heaviest, then nothing", () => {
    const ganache = [
      line("1", "Dark chocolate", 200),
      line("2", "Heavy cream", 250, { isBase: true }),
    ]
    const marked = buildFormula(formula("g", ganache), "bakers")
    expect(marked.basis).toBe("base")
    expect(marked.basisLabel).toBe("Heavy cream")
    expect(marked.lines[0]?.percent).toBe(80)

    const heaviest = buildFormula(
      formula("g", [
        line("1", "Dark chocolate", 200),
        line("2", "Heavy cream", 250),
      ]),
      "bakers"
    )
    expect(heaviest.basis).toBe("heaviest")
    expect(heaviest.basisLabel).toBe("Heavy cream")

    const none = buildFormula(
      formula("g", [line("1", "Dark chocolate", null)]),
      "bakers"
    )
    expect(none.basis).toBe("none")
    expect(none.lines[0]?.percent).toBeNull()
    expect(none.totalPercent).toBeNull()
    expect(none.summary.hydration).toBeNull()
  })

  it("keeps an unweighed line on the page and out of the totals", () => {
    const built = buildFormula(
      formula("p", [
        line("1", "Bread flour", 500),
        line("2", "Water", null, { written: "2 cups" }),
      ]),
      "bakers"
    )
    const water = built.lines.find((row) => row.label === "Water")
    expect(water?.grams).toBeNull()
    expect(water?.percent).toBeNull()
    expect(water?.written).toBe("2 cups")
    expect(water?.unweighedLineId).toBe("2")
    expect(built.totalGrams).toBe(500)
    expect(built.summary.unweighedCount).toBe(1)
    expect(built.summary.hydration).toBe(0)
  })

  it("weighs a line with the grams typed on the page", () => {
    const input = formula("p", [
      line("1", "Bread flour", 500),
      line("2", "Water", null, { written: "2 cups" }),
    ])
    const built = buildFormula(input, "bakers", {
      grams: { [gramOverrideKey("p", "2")]: 350 },
      roles: {},
    })
    const water = built.lines.find((row) => row.label === "Water")
    expect(water?.grams).toBe(350)
    expect(water?.gramsOverridden).toBe(true)
    expect(water?.percent).toBe(70)
    expect(water?.unweighedLineId).toBeNull()
    expect(built.summary.unweighedCount).toBe(0)
  })

  it("moves a row to the group chosen on the page and re-bases on it", () => {
    const input = formula("c", [
      line("1", "Bread flour", 400),
      line("2", "Almond flour", 100),
      line("3", "Water", 300),
    ])
    const asFlour = buildFormula(input, "bakers")
    expect(asFlour.basisGrams).toBe(500)
    const almond = canonicalFormulaName("Almond flour").key
    const asFat = buildFormula(input, "bakers", {
      grams: {},
      roles: { [almond]: "fat" },
    })
    expect(asFat.basisGrams).toBe(400)
    const row = asFat.lines.find((one) => one.key === almond)
    expect(row?.role).toBe("fat")
    expect(row?.roleOverridden).toBe(true)
    expect(row?.percent).toBe(25)
    expect(asFat.roleTotals.fat.grams).toBe(100)
  })

  it("adds up a name a recipe writes twice", () => {
    const built = buildFormula(
      formula("d", [
        line("1", "Bread flour", 300),
        line("2", "bread flour", 200),
        line("3", "Water", 350),
      ]),
      "bakers"
    )
    expect(built.lines).toHaveLength(2)
    const flour = built.lines[0]
    expect(flour?.grams).toBe(500)
    expect(flour?.lineIds).toEqual(["1", "2"])
    expect(built.basisGrams).toBe(500)
  })

  it("leaves a repeated name unweighed when one of its lines is", () => {
    const built = buildFormula(
      formula("d", [
        line("1", "Bread flour", 300),
        line("2", "bread flour", null, { written: "2 cups" }),
      ]),
      "bakers"
    )
    expect(built.lines[0]?.grams).toBeNull()
    expect(built.lines[0]?.unweighedLineId).toBe("2")
    expect(built.basis).toBe("none")
  })

  it("counts packaging as nothing and a discarded brine as what went in", () => {
    const built = buildFormula(
      formula("b", [
        line("1", "Bread flour", 500),
        line("2", "Parchment", 20, { note: "nonEdible" }),
        line("3", "Water", 300, { note: "discarded" }),
      ]),
      "bakers"
    )
    const parchment = built.lines.find((row) => row.label === "Parchment")
    expect(parchment?.grams).toBeNull()
    expect(parchment?.note).toBe("nonEdible")
    expect(parchment?.unweighedLineId).toBeNull()
    expect(built.summary.unweighedCount).toBe(0)
    expect(built.totalGrams).toBe(800)
    expect(built.lines.find((row) => row.label === "Water")?.percent).toBe(60)
  })

  it("summarises the dough from what is in each ingredient", () => {
    const built = buildFormula(
      formula(
        "f",
        SAMPLE_RECIPE.ingredients.map((one) =>
          line(one.id, one.name, one.grams)
        )
      ),
      "bakers"
    )
    const analysis = analyzeRecipe(SAMPLE_RECIPE.ingredients)
    expect(built.summary.hydration).toBe(76)
    expect(built.summary.salt).toBe(2)
    expect(built.summary.water).toBe(
      Math.round((analysis.waterG / 500) * 1000) / 10
    )
    expect(built.summary.water).toBeGreaterThan(built.summary.hydration ?? 0)
    expect(built.summary.fat).toBeGreaterThan(8)
    expect(built.summary.protein).toBeGreaterThan(12)
    expect(built.summary.unmappedCount).toBe(0)
    expect(built.summary.coveragePercent).toBe(100)
  })

  it("names what it cannot map and leaves it out of the composition", () => {
    const built = buildFormula(
      formula("m", [
        line("1", "Bread flour", 500),
        line("2", "Whole milk", 200),
        line("3", "Mystery powder", 50),
        line("4", "Filling", 100, { isComponent: true }),
      ]),
      "bakers"
    )
    expect(built.summary.unmappedCount).toBe(2)
    expect(
      built.lines.find((row) => row.label === "Mystery powder")?.mapped
    ).toBe(false)
    expect(built.lines.find((row) => row.label === "Filling")?.mapped).toBe(
      false
    )
    expect(built.lines.find((row) => row.label === "Whole milk")?.mapped).toBe(
      true
    )
    // The milk's water counts toward water, not hydration as written.
    expect(built.summary.hydration).toBe(40)
    expect(built.summary.water).toBe(47.9)
  })
})

describe("compareFormulas", () => {
  const RICH = formula("rich", [
    line("1", "Bread flour", 500),
    line("2", "Whole milk", 300),
    line("3", "Unsalted butter", 100),
    line("4", "Sugar", 60),
    line("5", "Egg", 100),
    line("6", "Fine sea salt", 10),
    line("7", "Instant yeast", 7),
  ])

  it("aligns rows by ingredient and groups them by what they do", () => {
    const comparison = compareFormulas([COUNTRY_LOAF, RICH], "bakers")
    expect(comparison.groups.map((group) => group.role)).toEqual([
      "flour",
      "liquid",
      "fat",
      "sweetener",
      "egg",
      "salt",
      "leavening",
    ])
    const flour = comparison.groups[0]
    expect(flour?.rows.map((row) => row.label)).toEqual([
      "Bread flour",
      "Whole wheat flour",
    ])
    expect(flour?.rows[1]?.cells[1]).toBeNull()
    expect(flour?.subtotal.cells.map((cell) => cell.percent)).toEqual([
      100, 100,
    ])
    const liquids = comparison.groups[1]
    expect(liquids?.rows.map((row) => row.label)).toEqual([
      "Water",
      "Whole milk",
    ])
    expect(liquids?.rows[0]?.cells[0]?.percent).toBe(66.7)
    expect(liquids?.rows[0]?.cells[1]).toBeNull()
    expect(comparison.total.cells.map((cell) => cell.grams)).toEqual([
      1018, 1077,
    ])
  })

  it("shows the difference in points when exactly two are compared", () => {
    const comparison = compareFormulas([COUNTRY_LOAF, RICH], "bakers")
    const salt = comparison.groups.find((group) => group.role === "salt")
    expect(salt?.rows[0]?.delta).toBe(0)
    const whole = comparison.groups[0]?.rows[1]
    // A line the second recipe does not have is at 0% there.
    expect(whole?.delta).toBe(-16.7)
    const liquids = comparison.groups.find((group) => group.role === "liquid")
    expect(liquids?.subtotal.delta).toBe(-6.7)
    expect(comparison.total.delta).toBe(45.7)

    const three = compareFormulas([COUNTRY_LOAF, RICH, COUNTRY_LOAF], "bakers")
    expect(three.groups[0]?.rows[0]?.delta).toBeNull()
    expect(three.total.delta).toBeNull()
    const one = compareFormulas([COUNTRY_LOAF], "bakers")
    expect(one.total.delta).toBeNull()
  })

  it("leaves the difference unknown while a line has no weight", () => {
    const comparison = compareFormulas(
      [
        COUNTRY_LOAF,
        formula("p", [
          line("1", "Bread flour", 500),
          line("2", "Water", null, { written: "2 cups" }),
        ]),
      ],
      "bakers"
    )
    const water = comparison.groups
      .find((group) => group.role === "liquid")
      ?.rows.find((row) => row.label === "Water")
    expect(water?.delta).toBeNull()
  })

  it("applies a chosen group to every column", () => {
    const almond = canonicalFormulaName("Almond flour").key
    const comparison = compareFormulas(
      [
        formula("a", [
          line("1", "Bread flour", 400),
          line("2", "Almond flour", 100),
        ]),
        formula("b", [
          line("1", "Bread flour", 400),
          line("2", "Almond flour", 50),
        ]),
      ],
      "bakers",
      { grams: {}, roles: { [almond]: "fat" } }
    )
    const fats = comparison.groups.find((group) => group.role === "fat")
    expect(fats?.rows[0]?.label).toBe("Almond flour")
    expect(fats?.rows[0]?.roleOverridden).toBe(true)
    expect(fats?.rows[0]?.cells.map((cell) => cell?.percent)).toEqual([
      25, 12.5,
    ])
    expect(comparison.groups[0]?.rows).toHaveLength(1)
  })

  it("compares nothing gracefully", () => {
    const comparison = compareFormulas([], "bakers")
    expect(comparison.groups).toEqual([])
    expect(comparison.total).toEqual({ cells: [], delta: null })
  })
})

describe("savedFormulaInput", () => {
  const item = (
    partial: Partial<RecipeDetail["items"][number]> & { id: string }
  ): RecipeDetail["items"][number] => ({
    kind: "ingredient",
    position: 0,
    displayName: "",
    quantity: null,
    unit: "",
    preparationNote: "",
    efficiency: 100,
    efficiencyAfterCooking: 100,
    isBase: false,
    excludedFromCost: false,
    ingredientId: null,
    subrecipeId: null,
    ingredientName: null,
    subrecipeName: null,
    costCents: null,
    resolved: true,
    ...partial,
  })
  const nutritionLine = (
    partial: Partial<RecipeNutrition["lines"][number]> & { itemId: string }
  ): RecipeNutrition["lines"][number] => ({
    kind: "ingredient",
    name: "",
    hasAllergenHints: false,
    ingredientPublicId: null,
    subrecipePublicId: null,
    linkedDescription: null,
    linkedSource: null,
    nonEdible: false,
    efficiencyAfterCooking: 100,
    grams: null,
    netGrams: null,
    status: "linked",
    ...partial,
  })
  const recipe = {
    publicId: "rcp_loaf",
    title: "Country loaf",
    items: [
      item({ id: "h", kind: "header", displayName: "Dough" }),
      item({
        id: "1",
        displayName: "bread flour",
        quantity: 4,
        unit: "cup",
        ingredientId: "flour",
        ingredientName: "Bread flour",
        isBase: true,
      }),
      item({ id: "2", displayName: "water", quantity: 250, unit: "g" }),
      item({
        id: "3",
        kind: "subrecipe",
        displayName: "Levain",
        quantity: 100,
        unit: "g",
        subrecipeId: "levain",
        subrecipeName: "Levain",
      }),
      item({
        id: "4",
        displayName: "parchment",
        quantity: 1,
        unit: "each",
        ingredientId: "parchment",
        ingredientName: "Parchment",
      }),
      item({ id: "n", kind: "note", displayName: "Rest overnight" }),
    ],
  } as unknown as RecipeDetail
  const nutrition = {
    lines: [
      nutritionLine({ itemId: "1", grams: 500, netGrams: 500 }),
      nutritionLine({ itemId: "2", status: "unresolved" }),
      nutritionLine({
        itemId: "3",
        kind: "subrecipe",
        grams: 100,
        netGrams: 100,
      }),
      nutritionLine({ itemId: "4", nonEdible: true, status: "nonEdible" }),
    ],
  } as unknown as RecipeNutrition

  it("joins the rows to the server's weights and keeps the rest honest", () => {
    const input = savedFormulaInput(recipe, nutrition, [
      entry({ id: "flour", name: "Bread flour", measureName: "Bread flour" }),
    ])
    expect(input.key).toBe("rcp_loaf")
    expect(input.href).toBe("/recipes/rcp_loaf/recipe")
    expect(input.lines.map((one) => one.id)).toEqual(["1", "2", "3", "4"])
    const [flour, water, levain, parchment] = input.lines
    expect(flour).toMatchObject({
      grams: 500,
      identityName: "Bread flour",
      isBase: true,
      written: "4 cup",
    })
    // An unlinked line written in grams still states its mass.
    expect(water).toMatchObject({ grams: 250, identityName: undefined })
    expect(levain).toMatchObject({ grams: 100, isComponent: true })
    expect(parchment).toMatchObject({ grams: null, note: "nonEdible" })
  })

  it("reads a recipe from before normalized rows off its text, as costing does", () => {
    const legacy = {
      publicId: "rcp_old",
      title: "Old cookies",
      body: "650 g Bread Flour\n200 g Whole Eggs\n12 g Kosher Salt",
      items: [],
    } as unknown as RecipeDetail
    const input = savedFormulaInput(legacy, null, [])
    expect(input.source).toBe("saved")
    expect(input.lines.map((one) => [one.name, one.grams])).toEqual([
      ["Bread Flour", 650],
      ["Whole Eggs", 200],
      ["Kosher Salt", 12],
    ])
    const built = buildFormula(input, "bakers")
    expect(built.basisGrams).toBe(650)
    expect(built.roleTotals.egg.grams).toBe(200)
    // A recipe with rows never falls back to its text.
    const withRows = savedFormulaInput(
      { ...legacy, items: recipe.items } as unknown as RecipeDetail,
      null,
      []
    )
    expect(withRows.lines.map((one) => one.id)).toEqual(["1", "2", "3", "4"])
  })

  it("weighs a mass line even without the nutrition read", () => {
    const input = savedFormulaInput(recipe, null, [])
    expect(input.lines[0]?.grams).toBeNull()
    expect(input.lines[0]?.written).toBe("4 cup")
    expect(input.lines[1]?.grams).toBe(250)
  })
})

describe("pastedFormulaInput", () => {
  const PANTRY = [
    entry({ id: "egg", name: "Egg", measureName: "Egg" }),
    entry({ id: "water", name: "Water", measureName: "Water" }),
    entry({
      id: "butter",
      name: "Unsalted butter",
      measureName: "Unsalted butter",
      conversion: {
        usesStandardConversion: false,
        weight: { amount: 227, unit: "g" },
        volume: { amount: 1, unit: "cup" },
        each: null,
      },
    }),
  ]
  const TEXT = [
    "# Serious brioche",
    "500 g bread flour",
    "3 large eggs",
    "2 cups water",
    "1 cup unsalted butter",
    "1/2 cup buttermilk",
    "10 g salt",
    "Mix everything and rest.",
  ].join("\n")

  it("weighs what the text states and what the pantry can convert", () => {
    const input = pastedFormulaInput("paste:1", "", TEXT, PANTRY)
    expect(input.title).toBe("Serious brioche")
    expect(input.source).toBe("pasted")
    const byName = Object.fromEntries(input.lines.map((one) => [one.name, one]))
    expect(byName["bread flour"]?.grams).toBe(500)
    // "eggs" reaches the pantry's Egg through the plural fold, then its each-weight.
    expect(byName["large eggs"]?.grams).toBeGreaterThan(120)
    expect(byName["large eggs"]?.identityName).toBe("Egg")
    // Cups of water weigh what the density chart says.
    expect(byName["water"]?.grams).toBeCloseTo(473.2, 0)
    // A stated kitchen conversion weighs a cup of butter.
    expect(byName["unsalted butter"]?.grams).toBe(227)
    // Nothing in the pantry says what a cup of buttermilk weighs.
    expect(byName["buttermilk"]).toMatchObject({
      grams: null,
      written: "1/2 cup",
    })
    expect(byName["salt"]?.grams).toBe(10)
    expect(input.lines.map((one) => one.name)).not.toContain(
      "Mix everything and rest."
    )
  })

  it("keeps every line and counts what it could not read", () => {
    const input = pastedFormulaInput(
      "paste:2",
      "From the book",
      "500 g flour\n3 to 4 cups of who knows\n1,5 kg sugar",
      []
    )
    expect(input.title).toBe("From the book")
    // A range is read at its low end; only the decimal comma is refused.
    expect(input.lines.map((one) => one.grams)).toEqual([500, null])
    expect(input.lines[1]?.written).toBe("3 cups")
    expect(input.skippedCount).toBe(1)
    const noTitle = pastedFormulaInput("paste:3", "  ", "500 g flour", [])
    expect(noTitle.title).toBe("Pasted recipe")
  })
})

describe("the compare URL", () => {
  it("reads ids once each, up to the cap", () => {
    expect(parseCompareIds(undefined)).toEqual([])
    expect(parseCompareIds(" a , b,a,,c ")).toEqual(["a", "b", "c"])
    expect(
      parseCompareIds(["1", "2", "3", "4", "5", "6", "7", "8"].join(","))
    ).toHaveLength(MAX_COMPARE_RECIPES)
  })

  it("writes the page's href with or without a selection", () => {
    expect(compareHref([])).toBe("/recipes/compare")
    expect(compareHref(["rcp_a", "rcp_b"])).toBe(
      "/recipes/compare?r=rcp_a,rcp_b"
    )
  })
})
