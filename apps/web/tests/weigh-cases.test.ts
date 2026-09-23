import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { recipePortions, recipePrepTimeSeconds } from "@/lib/recipe/portions"
import {
  batchAmountIn,
  conversionPairs,
  measureIngredientAmount,
  weighRecipeLines,
  yieldFamily,
  type WeighableLine,
  type WeighEquivalency,
  type WeighIngredient,
  type WeighRecipe,
} from "@/lib/recipe/weigh"

/**
 * Auto-sum yield and portions, pinned as data.
 *
 * `tests/fixtures/weigh-cases.json` is copied verbatim into the Mac app
 * (`forkluck-macosTests/Fixtures/`), whose Swift port of lib/recipe/weigh.ts
 * and lib/recipe/portions.ts asserts every case. Each case carries the whole
 * of its sources. Regenerate with
 * `UPDATE_WEIGH_FIXTURE=1 pnpm exec vitest run tests/weigh-cases.test.ts` and
 * copy it across.
 */

const FIXTURE = new URL("./fixtures/weigh-cases.json", import.meta.url)
const GENERATOR =
  "cd apps/web && UPDATE_WEIGH_FIXTURE=1 pnpm exec vitest run tests/weigh-cases.test.ts"

// The sources of recipe-weigh.test.ts, copied as they are there.
const flour: WeighIngredient = {
  id: "flour",
  name: "Bread Flour",
  measureName: "Bread Flour",
  purchaseSize: 25,
  purchaseUnit: "kg",
  conversion: null,
}

const saffron: WeighIngredient = {
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

const egg: WeighIngredient = {
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

const yolk: WeighIngredient = {
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

const milk: WeighIngredient = {
  id: "milk",
  name: "Milk",
  conversion: {
    usesStandardConversion: false,
    weight: { amount: 1030, unit: "g" },
    volume: { amount: 1, unit: "l" },
    each: null,
  },
}

const partialEgg: WeighIngredient = {
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

const standardEgg: WeighIngredient = {
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

const butter: WeighIngredient = {
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

const pimenton: WeighIngredient = {
  ...saffron,
  id: "pimenton",
  name: "Pimentón de la Vera",
  conversion: null,
}

const curd: WeighRecipe = {
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

const crust: WeighRecipe = {
  id: "crust",
  yieldAmount: 1,
  yieldUnit: "pcs",
  equivalency: null,
}

const standardGlaze: WeighRecipe = {
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

const tart: WeighRecipe = { id: "tart", yieldAmount: 8, yieldUnit: "slice" }
const plainCurd: WeighRecipe = {
  id: "curd",
  yieldAmount: 2.75,
  yieldUnit: "cup",
}

const ALL_ITEMS = [flour, saffron, egg, yolk]
const ALL_RECIPES = [curd, crust, standardGlaze]

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

type Case = {
  lines: WeighableLine[]
  items?: WeighIngredient[]
  recipes?: WeighRecipe[]
  yieldUnit?: string | null
}

const sub = (quantity: string, unit: string, subrecipeId: string) =>
  line({ kind: "subrecipe", quantity, unit, subrecipeId })

/** Every weighRecipeLines call of recipe-weigh.test.ts, then a few more. */
const CASES: Case[] = [
  { lines: [sub("800", "ml", "standard-glaze")] },
  { lines: [line({ quantity: "1.5", unit: "kg", ingredientId: "flour" })] },
  { lines: [line({ quantity: "2", unit: "cup", ingredientId: "flour" })] },
  {
    lines: [line({ quantity: "515", unit: "g", ingredientId: "milk" })],
    items: [milk],
    recipes: [],
    yieldUnit: "cup",
  },
  {
    lines: [line({ quantity: "300", unit: "g", ingredientId: "egg" })],
    yieldUnit: "pcs",
  },
  {
    lines: [line({ quantity: "300", unit: "g", ingredientId: "flour" })],
    yieldUnit: "pcs",
  },
  { lines: [line({ quantity: "3", unit: "each", ingredientId: "egg" })] },
  {
    lines: [
      line({
        quantity: "4",
        unit: "each",
        ingredientId: "yolk",
        preparationNote: "large, 2 ounces; 56 g",
      }),
    ],
  },
  {
    lines: [
      line({
        quantity: "4",
        unit: "each",
        ingredientId: "yolk",
        preparationNote: "room temperature",
      }),
    ],
  },
  {
    lines: [
      line({
        quantity: "3",
        unit: "each",
        ingredientId: "egg",
        preparationNote: "large, room temperature",
      }),
    ],
  },
  {
    lines: [
      line({
        quantity: "1",
        unit: "cup",
        ingredientId: "egg",
        preparationNote: "beaten",
      }),
    ],
  },
  {
    lines: [
      line({
        quantity: "3",
        unit: "each",
        ingredientId: "egg",
        preparationNote: "separated, room temperature",
      }),
    ],
    items: [partialEgg],
    recipes: [],
  },
  {
    lines: [
      line({
        quantity: "3",
        unit: "each",
        ingredientId: "egg",
        preparationNote: "room temperature",
      }),
    ],
    items: [standardEgg],
    recipes: [],
  },
  {
    lines: [line({ quantity: "1", unit: "cup", ingredientId: "butter" })],
    items: [butter],
    recipes: [],
  },
  {
    lines: [
      line({ quantity: "500", unit: "g", ingredientId: "flour" }),
      line({ quantity: "1", unit: "tsp", ingredientId: "saffron" }),
    ],
  },
  {
    lines: [line({ quantity: "1", unit: "cup", ingredientId: "pimenton" })],
    items: [pimenton],
    recipes: [],
  },
  {
    lines: [line({ quantity: "200", unit: "g", displayName: "Rye flour" })],
  },
  {
    lines: [
      line({ quantity: "  ", unit: "g", ingredientId: "flour" }),
      line({ quantity: "0", unit: "g", ingredientId: "flour" }),
    ],
  },
  {
    lines: [
      line({ kind: "header", displayName: "Dough" }),
      line({ kind: "note", displayName: "Rest overnight" }),
      line({ quantity: "500", unit: "g", ingredientId: "flour" }),
    ],
  },
  {
    lines: [
      line({ kind: "header", displayName: "Batter" }),
      line({ quantity: "500", unit: "g", ingredientId: "flour" }),
      line({ quantity: "2", unit: "each", ingredientId: "egg" }),
      sub("1", "kg", "custard"),
    ],
  },
  { lines: [sub("2", "each", "custard")] },
  { lines: [sub("1", "cup", "curd")], recipes: [curd, crust], yieldUnit: "g" },
  {
    lines: [sub("2.75", "cup", "curd")],
    recipes: [curd, crust],
    yieldUnit: "each",
  },
  {
    lines: [sub("1", "each", "crust")],
    recipes: [curd, crust],
    yieldUnit: "each",
  },
  {
    lines: [sub("2.75", "cup", "curd")],
    recipes: [curd, crust],
    yieldUnit: "slice",
  },
  { lines: [sub("1", "slice", "tart")], recipes: [tart], yieldUnit: "pcs" },
  {
    lines: [sub("3", "pcs", "tart")],
    recipes: [tart, crust],
    yieldUnit: "slice",
  },
  {
    lines: [sub("1", "slice", "crust")],
    recipes: [tart, crust],
    yieldUnit: "pcs",
  },
  { lines: [sub("1", "cup", "curd")], recipes: [plainCurd], yieldUnit: "g" },
  // Beyond the suite: other yield families and a yield that is not one.
  {
    lines: [
      line({ quantity: "1", unit: "cup", ingredientId: "flour" }),
      line({ quantity: "250", unit: "ml", ingredientId: "milk" }),
    ],
    items: [flour, milk],
    recipes: [],
    yieldUnit: "l",
  },
  {
    lines: [line({ quantity: "1", unit: "kg", ingredientId: "flour" })],
    yieldUnit: "portion",
  },
  {
    lines: [line({ quantity: "1", unit: "kg", ingredientId: "flour" })],
    yieldUnit: null,
  },
  {
    lines: [line({ quantity: "2", unit: "lb", ingredientId: "butter" })],
    items: [butter],
    recipes: [],
    yieldUnit: "cup",
  },
  {
    lines: [sub("400", "ml", "standard-glaze"), sub("0.5", "cup", "curd")],
    yieldUnit: "oz",
  },
]

const EQUIVALENCY = (fields: Partial<WeighEquivalency>): WeighEquivalency => ({
  massAmount: null,
  massUnit: "",
  volumeAmount: null,
  volumeUnit: "",
  countAmount: null,
  countUnit: "",
  ...fields,
})

const recipe = (
  amount: number,
  unit: string,
  equivalency: WeighEquivalency | null = null
): WeighRecipe => ({
  id: "recipe",
  yieldAmount: amount,
  yieldUnit: unit,
  equivalency,
})
const noServing = { amount: null, unit: "" }

/** recipe-portions.test.ts, then a few more. */
const PORTIONS: {
  recipe: WeighRecipe | null
  serving: { amount: number | null; unit: string }
}[] = [
  { recipe: recipe(8, "slice"), serving: noServing },
  { recipe: recipe(12, "pcs"), serving: noServing },
  { recipe: recipe(8, "slice"), serving: { amount: 1, unit: "slice" } },
  { recipe: recipe(8, "slice"), serving: { amount: 2, unit: "each" } },
  { recipe: recipe(8, "slice"), serving: { amount: 1, unit: "pcs" } },
  { recipe: recipe(8, "slice"), serving: { amount: 100, unit: "g" } },
  { recipe: recipe(31, "pcs"), serving: { amount: 12, unit: "g" } },
  { recipe: recipe(24, "pcs"), serving: { amount: 2, unit: "fl-oz" } },
  { recipe: recipe(1, "kg"), serving: noServing },
  {
    recipe: recipe(31, "pcs", EQUIVALENCY({ massAmount: 400, massUnit: "g" })),
    serving: { amount: 10, unit: "g" },
  },
  { recipe: recipe(1, "kg"), serving: { amount: 250, unit: "g" } },
  {
    recipe: recipe(
      600,
      "g",
      EQUIVALENCY({ countAmount: 100, countUnit: "each" })
    ),
    serving: { amount: 1, unit: "each" },
  },
  { recipe: recipe(600, "g"), serving: { amount: 1, unit: "each" } },
  { recipe: null, serving: { amount: 1, unit: "each" } },
  { recipe: recipe(2, "l"), serving: { amount: 1, unit: "cup" } },
  { recipe: recipe(2, "kg"), serving: { amount: -1, unit: "g" } },
  { recipe: recipe(2, "kg"), serving: { amount: 3, unit: "portion" } },
  {
    recipe: recipe(
      1600,
      "ml",
      EQUIVALENCY({
        massAmount: 8,
        massUnit: "oz",
        volumeAmount: 1,
        volumeUnit: "cup",
        standard: true,
      })
    ),
    serving: { amount: 100, unit: "g" },
  },
]

const PREP_TIMES: { prepTimeAmount?: number | null; prepTimeUnit?: string }[] =
  [
    { prepTimeAmount: 30, prepTimeUnit: "minutes" },
    { prepTimeAmount: 1.5, prepTimeUnit: "hours" },
    { prepTimeAmount: 0.0101, prepTimeUnit: "minutes" },
    { prepTimeAmount: 2 },
    { prepTimeAmount: null, prepTimeUnit: "hours" },
    { prepTimeAmount: 0, prepTimeUnit: "minutes" },
    {},
  ]

const YIELD_UNITS = [
  "g",
  "kg",
  "oz",
  "lb",
  "ml",
  "l",
  "cup",
  "pcs",
  "slice",
  "each",
  "dozen",
  "case",
  "portion",
  "pinch",
  "bushel",
  "",
  null,
]

const FAMILIES = ["mass", "volume", "count"] as const

const BATCH_RECIPES: WeighRecipe[] = [
  curd,
  crust,
  standardGlaze,
  tart,
  plainCurd,
  recipe(0, "g", EQUIVALENCY({ countAmount: 4, countUnit: "each" })),
  recipe(
    2,
    "lb",
    EQUIVALENCY({ volumeAmount: 1, volumeUnit: "qt", standard: true })
  ),
  recipe(
    12,
    "pcs",
    EQUIVALENCY({
      massAmount: 50,
      massUnit: "g",
      countAmount: 1,
      countUnit: "each",
      standard: true,
    })
  ),
  { id: "none" },
]

/** measureIngredientAmount over each source and family, beyond the suite. */
const MEASURES: { quantity: number; unit: string; note?: string }[] = [
  { quantity: 2, unit: "cup" },
  { quantity: 300, unit: "g" },
  { quantity: 3, unit: "each" },
  { quantity: 1, unit: "cup", note: "beaten" },
  { quantity: 4, unit: "each", note: "large" },
  { quantity: 1, unit: "tsp" },
  { quantity: 1, unit: "case" },
]

function generate() {
  const items = [flour, saffron, egg, yolk, milk, butter, pimenton]
  return {
    generator: GENERATOR,
    weighRecipeLines: CASES.map((entry) => {
      const sources = {
        items: entry.items ?? ALL_ITEMS,
        recipes: entry.recipes ?? ALL_RECIPES,
      }
      const yieldUnit = entry.yieldUnit === undefined ? "g" : entry.yieldUnit
      return {
        lines: entry.lines,
        sources,
        yieldUnit,
        expect: weighRecipeLines(entry.lines, sources, yieldUnit),
      }
    }),
    measureIngredientAmount: items.flatMap((entry) =>
      MEASURES.flatMap(({ quantity, unit, note }) =>
        FAMILIES.map((family) => ({
          quantity,
          unit,
          ingredient: entry,
          family,
          preparationNote: note ?? null,
          expect: measureIngredientAmount(quantity, unit, entry, family, note),
        }))
      )
    ),
    conversionPairs: items.map((entry) => ({
      conversion: entry.conversion ?? null,
      expect: conversionPairs(entry.conversion),
    })),
    yieldFamily: YIELD_UNITS.map((unit) => ({
      unit,
      expect: yieldFamily(unit),
    })),
    batchAmountIn: BATCH_RECIPES.flatMap((entry) =>
      FAMILIES.map((family) => ({
        recipe: entry,
        family,
        expect: batchAmountIn(entry, family),
      }))
    ),
    recipePortions: PORTIONS.map((entry) => ({
      ...entry,
      expect: recipePortions(entry.recipe, entry.serving),
    })),
    recipePrepTimeSeconds: PREP_TIMES.map((entry) => ({
      prepTimeAmount: entry.prepTimeAmount ?? null,
      prepTimeUnit: entry.prepTimeUnit ?? "",
      expect: recipePrepTimeSeconds(entry),
    })),
  }
}

describe("the weigh fixture the Mac app asserts against", () => {
  it("matches what auto-sum yield and portions read", () => {
    const generated = JSON.parse(JSON.stringify(generate()))
    if (process.env.UPDATE_WEIGH_FIXTURE || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(generated, null, 2) + "\n")
    }
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8"))
    expect(committed).toEqual(generated)
  })
})
