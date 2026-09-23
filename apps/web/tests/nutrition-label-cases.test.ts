import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { NUTRIENT_KEYS } from "@/lib/backend/schemas"
import type { Nutrients } from "@/lib/backend/types"
import {
  ALLERGENS,
  EU_DECLARED,
  KITCHEN_ONLY,
  US_DECLARED,
} from "@/lib/nutrition/allergens"
import {
  containsLine,
  DAILY_VALUES,
  declaredAllergens,
  EU_MANDATORY,
  formatAmount,
  formatEuRows,
  formatServingLabel,
  formatServings,
  formatUsRows,
  missingNutrients,
  NUTRIENT_LABELS,
  nutrientsFromComposition,
  percentDailyValue,
  roundCalories,
  roundCarbGrams,
  roundCholesterol,
  roundEuGrams,
  roundEuSalt,
  roundFatGrams,
  roundIron,
  roundMineral10,
  roundSodium,
  roundVitaminD,
  scaleNutrients,
  servingsPerContainer,
  statementRuns,
  US_MANDATORY,
} from "@/lib/nutrition/label"

/**
 * How a nutrition figure reads on a US or EU label, pinned as data.
 *
 * `tests/fixtures/nutrition-label-cases.json` is copied verbatim into the Mac
 * app (`forkluck-macosTests/Fixtures/`), whose Swift port of
 * lib/nutrition/label.ts asserts every case. Regenerate with
 * `UPDATE_NUTRITION_LABEL_FIXTURE=1 pnpm exec vitest run tests/nutrition-label-cases.test.ts`
 * and copy it across.
 */

const FIXTURE = new URL(
  "./fixtures/nutrition-label-cases.json",
  import.meta.url
)
const GENERATOR =
  "cd apps/web && UPDATE_NUTRITION_LABEL_FIXTURE=1 pnpm exec vitest run tests/nutrition-label-cases.test.ts"

// The builder of nutrition-label.test.ts.
function nutrients(
  amounts: Partial<Record<keyof Nutrients, number>>,
  incomplete: (keyof Nutrients)[] = []
): Nutrients {
  return Object.fromEntries(
    NUTRIENT_KEYS.map((key) => [
      key,
      { amount: amounts[key] ?? 0, complete: !incomplete.includes(key) },
    ])
  ) as Nutrients
}

/** Values from nutrition-label.test.ts, then every boundary and its sides. */
const GRID = {
  roundCalories: [
    4.9, 5, 12.4, 12.5, 50, 51, 55, 254, 0, 4.99, 5.01, 7.5, 49.9, 50.1, 52.5,
    54.9, 55.1, 94.99, 95, 1234.5, 2.5,
  ],
  roundFatGrams: [
    0.49, 0.5, 2.74, 2.75, 4.99, 5, 12.6, 0, 0.25, 0.51, 0.74, 0.75, 1.25, 4.74,
    4.75, 5.1, 5.49, 5.5, 12.5, 13.5,
  ],
  roundCholesterol: [
    1.9, 2, 5, 5.1, 12, 13, 0, 1.99, 2.01, 4.99, 7.4, 7.5, 12.5, 17.5, 300,
  ],
  roundSodium: [
    4.9, 5, 138, 140, 141, 146, 0, 4.99, 7.5, 12.49, 137.5, 140.01, 144.9, 145,
    155, 2300,
  ],
  roundCarbGrams: [
    0.49, 0.5, 0.99, 1, 12.5, 0, 1.49, 1.5, 2.5, 4.9, 5, 5.1, 37.4,
  ],
  roundVitaminD: [2.04, 2.06, 0, 0.05, 0.15, 0.25, 2.05, 19.95, 0.049],
  roundIron: [0.96, 1.25, 0, 0.05, 0.35, 1.15, 17.99],
  roundMineral10: [264, 265, 0, 4.9, 5, 15, 25, 1299, 4705],
  roundEuGrams: [
    12.46, 10, 9.96, 2.34, 0.5, 0.49, 0, 0.45, 0.55, 0.95, 9.94, 9.95, 10.5,
    11.5, 4.9, 5, 5.1, 5.05, 5.15,
  ],
  roundEuSalt: [
    1.26, 1, 0.456, 0.0125, 0.012, 0, 0.005, 0.015, 0.025, 0.995, 0.9951, 1.05,
    1.15, 2.25,
  ],
}

const PERCENTS: {
  amount: number
  dailyValue: number
  kind: "macro" | "micro"
}[] = [
  { amount: 8.4, dailyValue: 78, kind: "macro" },
  { amount: 0.3, dailyValue: 78, kind: "macro" },
  { amount: 1, dailyValue: 20, kind: "micro" },
  { amount: 2, dailyValue: 20, kind: "micro" },
  { amount: 2.2, dailyValue: 20, kind: "micro" },
  { amount: 4.6, dailyValue: 20, kind: "micro" },
  { amount: 10, dailyValue: 20, kind: "micro" },
  { amount: 10.4, dailyValue: 20, kind: "micro" },
  { amount: 13, dailyValue: 20, kind: "micro" },
  ...Object.entries(DAILY_VALUES).flatMap(([, dailyValue]) =>
    [
      0, 0.005, 0.01, 0.03, 0.05, 0.1, 0.105, 0.11, 0.5, 0.505, 0.55, 1.26,
    ].flatMap((share) =>
      (["macro", "micro"] as const).map((kind) => ({
        amount: share * dailyValue,
        dailyValue,
        kind,
      }))
    )
  ),
]

const PER_SERVING = nutrients({
  calories: 254,
  fat: 8.4,
  saturatedFat: 2.74,
  transFat: 0.2,
  cholesterolMg: 3,
  sodiumMg: 146,
  totalCarbohydrate: 37.4,
  fiber: 0.7,
  sugars: 12.5,
  addedSugars: 10,
  protein: 5.2,
  vitaminDMcg: 2.06,
  calciumMg: 264,
  ironMg: 1.25,
  potassiumMg: 235,
})

const US_ROWS: Nutrients[] = [
  PER_SERVING,
  nutrients({ calories: 100, fat: 3 }, ["fat", "calories"]),
  nutrients({}),
  nutrients({
    calories: 4.9,
    fat: 0.49,
    saturatedFat: 0.5,
    transFat: 4.9,
    cholesterolMg: 1.9,
    sodiumMg: 4.9,
    totalCarbohydrate: 0.49,
    fiber: 0.5,
    sugars: 4.9,
    addedSugars: 5,
    protein: 5.1,
    vitaminDMcg: 0.04,
    calciumMg: 4,
    ironMg: 0.04,
    potassiumMg: 4,
  }),
  nutrients({
    calories: 51,
    fat: 5,
    saturatedFat: 5.1,
    cholesterolMg: 5.1,
    sodiumMg: 141,
    totalCarbohydrate: 50,
    fiber: 5,
    sugars: 51,
    addedSugars: 50,
    protein: 50,
    vitaminDMcg: 20,
    calciumMg: 1300,
    ironMg: 18,
    potassiumMg: 4700,
  }),
  nutrients({ calories: 50, cholesterolMg: 2, sodiumMg: 140, fat: 0.5 }),
]

const PER_100G = nutrients({
  energyKj: 1046.2,
  calories: 250.3,
  fat: 8.4,
  saturatedFat: 2.34,
  totalCarbohydrate: 37.4,
  sugars: 12.46,
  protein: 5.24,
  salt: 0.456,
})

const EU_ROWS: { per100g: Nutrients; perServing: Nutrients | null }[] = [
  { per100g: PER_100G, perServing: scaleNutrients(PER_100G, 0.5) },
  {
    per100g: nutrients({ calories: 100, energyKj: 418 }, ["saturatedFat"]),
    perServing: null,
  },
  {
    per100g: nutrients({
      energyKj: 20.9,
      calories: 4.9,
      fat: 0.49,
      saturatedFat: 0.5,
      totalCarbohydrate: 9.96,
      sugars: 10,
      protein: 0.05,
      salt: 0.0125,
    }),
    perServing: nutrients({
      energyKj: 2092,
      calories: 500,
      fat: 51,
      saturatedFat: 9.94,
      totalCarbohydrate: 0,
      sugars: 0,
      protein: 100,
      salt: 0.012,
    }),
  },
]

const SERVING_COUNTS = [
  12, 3.33, 2.5, 7.6, 1.4, 1, 0.6, 2, 0.4, 0.5, 1.5, 1.9994, 2.24, 2.25, 4.74,
  4.75, 5, 5.2, 5.5, 5.49, 100.2, 0.0004,
]

const ALLERGEN_SETS = [
  ["allium", "milk", "sulphites", "celery", "nightshades", "egg"],
  ["wheat", "gluten_cereals"],
  ["gluten_cereals"],
  ["wheat"],
  [],
  ["stone_fruit", "legumes", "lupin", "mustard", "mollusks", "sesame"],
  ["tree_nuts", "peanut", "fish", "shellfish", "soy"],
  ["unknown_key", "milk"],
]

const STATEMENTS = [
  [
    { name: "Flour", grams: 200, allergens: ["wheat"] },
    { name: "Sugar", grams: 100, allergens: [] },
    { name: "Onion", grams: 50, allergens: ["allium"] },
    { name: "Celery", grams: 20, allergens: ["celery"] },
  ],
  [
    { name: "Almonds", grams: 50, allergens: ["tree_nuts"] },
    { name: "Walnuts", grams: 20, allergens: ["tree_nuts"] },
    { name: "Milk", grams: 100, allergens: ["milk"] },
  ],
  [
    { name: "Anchovy fillets", grams: 10, allergens: ["fish"] },
    { name: "Prawns", grams: 40, allergens: ["shellfish"] },
    { name: "Wheat flour", grams: 40, allergens: ["wheat", "gluten_cereals"] },
    { name: "Butter (unsalted)", grams: 5, allergens: ["milk"] },
  ],
]

const CONTAINS: { entries: number; keys: string[] }[] = [
  { entries: 1, keys: ["milk", "tree_nuts"] },
  { entries: 1, keys: ["fish"] },
  { entries: 1, keys: ["milk", "allium"] },
  { entries: 2, keys: ["fish", "shellfish", "wheat", "milk", "sesame"] },
  { entries: 0, keys: ["wheat", "gluten_cereals", "celery"] },
]

const COMPOSITION = {
  water: 16,
  fat: 81,
  protein: 0.9,
  sugars: 0.1,
  starch: 0,
  fiber: 0,
  salt: 1.6,
  other: 0.4,
  totalCarbohydrate: 0.1,
  sodiumMg: 640,
  saturatedFat: 51,
  calories: 717,
  transFat: null,
  cholesterolMg: 215,
  addedSugars: null,
  vitaminDMcg: null,
  calciumMg: 24,
  ironMg: 0.02,
  potassiumMg: 24,
}

type CompositionInput = Parameters<typeof nutrientsFromComposition>[0]

const COMPOSITIONS: {
  per100g: CompositionInput
  sugarsAreAdded?: boolean
}[] = [
  { per100g: COMPOSITION },
  { per100g: { ...COMPOSITION, calories: null } },
  { per100g: { ...COMPOSITION, sugars: 99.8 }, sugarsAreAdded: true },
  {
    per100g: {
      ...COMPOSITION,
      totalCarbohydrate: undefined,
      sodiumMg: undefined,
      sugars: 2,
      starch: 3,
      fiber: 1,
      salt: 2.5,
    },
  },
  {
    per100g: {
      ...COMPOSITION,
      calories: null,
      totalCarbohydrate: undefined,
      sodiumMg: undefined,
      fiber: 3,
      starch: 10,
      sugars: 5,
      addedSugars: 4,
    },
    sugarsAreAdded: false,
  },
]

const SERVINGS: {
  amount: number | null
  unit: string
  grams: number | null
}[] = [
  { amount: 1, unit: "slice", grams: 85.333 },
  { amount: 100, unit: "g", grams: 100 },
  { amount: 2, unit: "cup", grams: null },
  { amount: null, unit: "", grams: 40 },
  { amount: null, unit: "", grams: null },
  { amount: 0.5, unit: "", grams: 12 },
  { amount: 1234.5678, unit: "ml", grams: 1234.5678 },
]

function generate() {
  const rounders = {
    roundCalories,
    roundFatGrams,
    roundCholesterol,
    roundSodium,
    roundCarbGrams,
    roundVitaminD,
    roundIron,
    roundMineral10,
    roundEuGrams,
    roundEuSalt,
  }
  return {
    generator: GENERATOR,
    constants: {
      nutrientKeys: NUTRIENT_KEYS,
      nutrientLabels: NUTRIENT_LABELS,
      usMandatory: US_MANDATORY,
      euMandatory: EU_MANDATORY,
      dailyValues: DAILY_VALUES,
      allergens: ALLERGENS,
      usDeclared: [...US_DECLARED],
      euDeclared: [...EU_DECLARED],
      kitchenOnly: [...KITCHEN_ONLY],
    },
    rounding: Object.fromEntries(
      Object.entries(GRID).map(([name, values]) => [
        name,
        values.map((value) => ({
          value,
          expect: rounders[name as keyof typeof rounders](value),
        })),
      ])
    ),
    percentDailyValue: PERCENTS.map((input) => ({
      ...input,
      expect: percentDailyValue(input.amount, input.dailyValue, input.kind),
    })),
    formatUsRows: US_ROWS.map((perServing) => ({
      perServing,
      expect: formatUsRows(perServing),
    })),
    formatEuRows: EU_ROWS.map((input) => ({
      ...input,
      expect: formatEuRows(input.per100g, input.perServing),
    })),
    servings: SERVING_COUNTS.map((count) => ({
      count,
      formatServings: formatServings(count),
      servingsPerContainer: servingsPerContainer(count),
    })),
    formatAmount: [0, 1, 1.005, 1.234, 12.5, 1234.5678, 0.004, 0.005].map(
      (value) => ({ value, expect: formatAmount(value) })
    ),
    formatServingLabel: SERVINGS.map((serving) => ({
      serving,
      expect: formatServingLabel(serving),
    })),
    declaredAllergens: ALLERGEN_SETS.flatMap((keys) =>
      (["us", "eu"] as const).map((region) => ({
        keys,
        region,
        expect: declaredAllergens(keys, region),
      }))
    ),
    statementRuns: STATEMENTS.flatMap((entries) =>
      (["us", "eu"] as const).map((region) => ({
        entries,
        region,
        expect: statementRuns(entries, region),
      }))
    ),
    containsLine: CONTAINS.flatMap(({ entries, keys }) =>
      (["us", "eu"] as const).map((region) => ({
        entries: STATEMENTS[entries],
        keys,
        region,
        expect: containsLine(STATEMENTS[entries], keys, region),
      }))
    ),
    nutrientsFromComposition: COMPOSITIONS.map(
      ({ per100g, sugarsAreAdded }) => {
        const values = nutrientsFromComposition(per100g, { sugarsAreAdded })
        return {
          per100g,
          sugarsAreAdded: sugarsAreAdded ?? false,
          expect: values,
          missingUs: missingNutrients(values, "us"),
          missingEu: missingNutrients(values, "eu"),
        }
      }
    ),
    scaleNutrients: [0.25, 0.5, 3].map((factor) => ({
      values: nutrients({ fat: 10, protein: 4 }, ["fat"]),
      factor,
      expect: scaleNutrients(
        nutrients({ fat: 10, protein: 4 }, ["fat"]),
        factor
      ),
    })),
  }
}

describe("the nutrition label fixture the Mac app asserts against", () => {
  it("matches what the label prints", () => {
    const generated = JSON.parse(JSON.stringify(generate()))
    if (process.env.UPDATE_NUTRITION_LABEL_FIXTURE || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(generated, null, 2) + "\n")
    }
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8"))
    expect(committed).toEqual(generated)
  })
})
