import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  RECIPE_NUTRITION_BATCH_ISSUES,
  RECIPE_NUTRITION_SERVING_ISSUES,
} from "@/lib/backend/schemas"
import type { Nutrients } from "@/lib/backend/types"
import { formatCents } from "@/lib/money"
import {
  containsLine,
  declaredAllergens,
  formatEuRows,
  formatServingLabel,
  formatUsRows,
  NUTRIENT_LABELS,
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
  servingsPerContainer,
  statementRuns,
} from "@/lib/nutrition/label"
import { unitWord } from "@/lib/unit-registry"

/**
 * How a nutrition label and a cost figure read, pinned as data.
 *
 * `tests/fixtures/nutrition-label-cases.json` is generated from the functions
 * below and copied verbatim into the iOS app (`forkluck-iosTests/Fixtures/`),
 * whose Swift port of this module asserts every case. A change to a rounding
 * rule or a sentence here fails this test until the fixture is regenerated
 * with `UPDATE_NUTRITION_LABEL_FIXTURE=1 pnpm exec vitest run tests/nutrition-label-cases.test.ts`,
 * which is the reminder to copy it across.
 */

const FIXTURE = new URL(
  "./fixtures/nutrition-label-cases.json",
  import.meta.url
)

const ROUNDING: Record<
  string,
  { fn: (value: number) => string | number; inputs: number[] }
> = {
  calories: {
    fn: roundCalories,
    inputs: [0, 4.9, 5, 7.4, 7.5, 12, 50, 52, 55, 250, 254, 255, 1234],
  },
  fatGrams: {
    fn: roundFatGrams,
    inputs: [0, 0.49, 0.5, 0.74, 0.75, 1.3, 4.9, 5, 5.2, 5.5, 12.6],
  },
  cholesterol: {
    fn: roundCholesterol,
    inputs: [0, 1.9, 2, 3.5, 5, 5.1, 7.4, 7.5, 63, 300],
  },
  sodium: {
    fn: roundSodium,
    inputs: [0, 4.9, 5, 7.4, 7.5, 140, 141, 144, 145, 1180],
  },
  carbGrams: {
    fn: roundCarbGrams,
    inputs: [0, 0.49, 0.5, 0.99, 1, 1.4, 1.5, 22.6],
  },
  vitaminD: { fn: roundVitaminD, inputs: [0, 0.04, 0.05, 0.14, 2.06, 20] },
  iron: { fn: roundIron, inputs: [0, 0.04, 0.05, 1.25, 1.35, 18] },
  mineral10: { fn: roundMineral10, inputs: [0, 4, 5, 14, 15, 126, 1300] },
  euGrams: {
    fn: roundEuGrams,
    inputs: [0, 0.4, 0.49, 0.5, 0.55, 3.14, 9.99, 10, 10.4, 10.5, 47.3],
  },
  euSalt: {
    fn: roundEuSalt,
    inputs: [0, 0.01, 0.0124, 0.0125, 0.125, 0.99, 1, 1.05, 2.46],
  },
}

const PERCENT: {
  amount: number
  dailyValue: number
  kind: "macro" | "micro"
}[] = [
  { amount: 0, dailyValue: 78, kind: "macro" },
  { amount: 3.9, dailyValue: 78, kind: "macro" },
  { amount: 10, dailyValue: 78, kind: "macro" },
  { amount: 1.2, dailyValue: 20, kind: "macro" },
  { amount: 0.5, dailyValue: 20, kind: "micro" },
  { amount: 2, dailyValue: 20, kind: "micro" },
  { amount: 3, dailyValue: 20, kind: "micro" },
  { amount: 9, dailyValue: 20, kind: "micro" },
  { amount: 11, dailyValue: 20, kind: "micro" },
  { amount: 260, dailyValue: 1300, kind: "micro" },
  { amount: 700, dailyValue: 1300, kind: "micro" },
  { amount: 1500, dailyValue: 1300, kind: "micro" },
]

const SERVINGS = [1, 1.4, 1.5, 2, 2.26, 2.5, 2.74, 4.8, 5.4, 6.5, 12, 24.9]

const SERVING_LABELS: {
  amount: number | null
  unit: string
  grams: number | null
}[] = [
  { amount: 1, unit: "slice", grams: 45 },
  { amount: 2, unit: "pcs", grams: 30.5 },
  { amount: 100, unit: "g", grams: 100 },
  { amount: 0.5, unit: "cup", grams: 120 },
  { amount: null, unit: "", grams: 55 },
  { amount: 3, unit: "pcs", grams: null },
  { amount: null, unit: "", grams: null },
  { amount: 1234.567, unit: "g", grams: 1234.567 },
]

function nutrients(
  values: Partial<Record<keyof Nutrients, number>>,
  incomplete: (keyof Nutrients)[] = []
): Nutrients {
  const keys: (keyof Nutrients)[] = [
    "calories",
    "energyKj",
    "fat",
    "saturatedFat",
    "transFat",
    "cholesterolMg",
    "sodiumMg",
    "salt",
    "totalCarbohydrate",
    "fiber",
    "sugars",
    "addedSugars",
    "protein",
    "vitaminDMcg",
    "calciumMg",
    "ironMg",
    "potassiumMg",
  ]
  return Object.fromEntries(
    keys.map((key) => [
      key,
      { amount: values[key] ?? 0, complete: !incomplete.includes(key) },
    ])
  ) as Nutrients
}

const PANELS = {
  cookie: nutrients({
    calories: 254.4,
    energyKj: 1064.4,
    fat: 12.6,
    saturatedFat: 7.4,
    transFat: 0.2,
    cholesterolMg: 33.4,
    sodiumMg: 143,
    salt: 0.3575,
    totalCarbohydrate: 32.6,
    fiber: 0.9,
    sugars: 18.4,
    addedSugars: 17.9,
    protein: 2.6,
    vitaminDMcg: 0.14,
    calciumMg: 14,
    ironMg: 1.25,
    potassiumMg: 61,
  }),
  broth: nutrients(
    {
      calories: 4.2,
      energyKj: 17.6,
      fat: 0.3,
      saturatedFat: 0.04,
      transFat: 0,
      cholesterolMg: 1.8,
      sodiumMg: 4.6,
      salt: 0.0115,
      totalCarbohydrate: 0.6,
      fiber: 0,
      sugars: 0.4,
      addedSugars: 0,
      protein: 0.9,
      vitaminDMcg: 0,
      calciumMg: 3,
      ironMg: 0.04,
      potassiumMg: 38,
    },
    ["vitaminDMcg", "addedSugars"]
  ),
  loaf: nutrients({
    calories: 1180,
    energyKj: 4937,
    fat: 4.5,
    saturatedFat: 0.75,
    transFat: 0,
    cholesterolMg: 0,
    sodiumMg: 1180,
    salt: 2.95,
    totalCarbohydrate: 240,
    fiber: 9.6,
    sugars: 5.4,
    addedSugars: 5.4,
    protein: 38,
    vitaminDMcg: 0,
    calciumMg: 126,
    ironMg: 15.7,
    potassiumMg: 700,
  }),
}

const ALLERGEN_CASES = [
  {
    name: "us, named nuts and wheat",
    region: "us" as const,
    entries: [
      {
        name: "Bread Flour",
        grams: 500,
        allergens: ["wheat", "gluten_cereals"],
      },
      { name: "Butter", grams: 200, allergens: ["milk"] },
      { name: "Hazelnuts", grams: 80, allergens: ["tree_nuts"] },
      { name: "Onion", grams: 40, allergens: ["allium"] },
    ],
    contains: ["wheat", "gluten_cereals", "milk", "tree_nuts", "allium"],
    mayContain: ["peanut", "sesame", "nightshades"],
  },
  {
    name: "eu, same recipe",
    region: "eu" as const,
    entries: [
      {
        name: "Bread Flour",
        grams: 500,
        allergens: ["wheat", "gluten_cereals"],
      },
      { name: "Butter", grams: 200, allergens: ["milk"] },
      { name: "Hazelnuts", grams: 80, allergens: ["tree_nuts"] },
      { name: "Onion", grams: 40, allergens: ["allium"] },
    ],
    contains: ["wheat", "gluten_cereals", "milk", "tree_nuts", "allium"],
    mayContain: ["peanut", "sesame", "nightshades"],
  },
  {
    name: "us, unnamed species and an unknown tag",
    region: "us" as const,
    entries: [
      { name: "Fish stock", grams: 900, allergens: [] },
      { name: "Salt", grams: 12, allergens: [] },
    ],
    contains: ["fish", "shellfish", "mystery"],
    mayContain: ["fish"],
  },
]

const MONEY: { cents: number; currency: string }[] = [
  { cents: 0, currency: "USD" },
  { cents: 1234.5, currency: "USD" },
  { cents: 1234.4, currency: "USD" },
  { cents: 100000, currency: "USD" },
  { cents: 7, currency: "USD" },
  { cents: 99999.6, currency: "EUR" },
  { cents: 250, currency: "GBP" },
  { cents: 123456, currency: "JPY" },
  { cents: 4.4, currency: "CAD" },
]

const YIELD_UNITS = [
  "pcs",
  "slice",
  "g",
  "kg",
  "oz",
  "lb",
  "ml",
  "l",
  "fl-oz",
  "cup",
  "pt",
  "qt",
  "gal",
]

function generate() {
  return {
    rounding: Object.fromEntries(
      Object.entries(ROUNDING).map(([name, { fn, inputs }]) => [
        name,
        inputs.map((input) => ({ input, expect: String(fn(input)) })),
      ])
    ),
    percent: PERCENT.map((entry) => ({
      ...entry,
      expect: percentDailyValue(entry.amount, entry.dailyValue, entry.kind),
    })),
    servings: SERVINGS.map((count) => ({
      count,
      expect: servingsPerContainer(count),
    })),
    servingLabels: SERVING_LABELS.map((serving) => ({
      ...serving,
      expect: formatServingLabel(serving),
    })),
    panels: Object.fromEntries(
      Object.entries(PANELS).map(([name, values]) => [
        name,
        {
          nutrients: values,
          us: formatUsRows(values),
          eu: formatEuRows(values, values),
          euWithoutServing: formatEuRows(values, null),
        },
      ])
    ),
    allergens: ALLERGEN_CASES.map((entry) => ({
      ...entry,
      runs: statementRuns(entry.entries, entry.region),
      containsLine: containsLine(entry.entries, entry.contains, entry.region),
      declared: declaredAllergens(entry.contains, entry.region),
      mayContainDeclared: declaredAllergens(entry.mayContain, entry.region),
    })),
    money: MONEY.map((entry) => ({
      ...entry,
      expect: formatCents(entry.cents, entry.currency),
    })),
    // The cost view's "Cost per {word}": pieces read as "piece" there.
    unitWords: Object.fromEntries(
      YIELD_UNITS.map((slug) => [
        slug,
        slug === "pcs" ? "piece" : unitWord(slug),
      ])
    ),
    nutrientLabels: NUTRIENT_LABELS,
    issueCodes: {
      batch: [...RECIPE_NUTRITION_BATCH_ISSUES],
      serving: [...RECIPE_NUTRITION_SERVING_ISSUES],
    },
  }
}

describe("the nutrition label fixture the iOS app asserts against", () => {
  it("matches how the web label and cost figures read", () => {
    const generated = generate()
    if (process.env.UPDATE_NUTRITION_LABEL_FIXTURE || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(generated, null, 2) + "\n")
    }
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8"))
    expect(committed).toEqual(generated)
  })
})
