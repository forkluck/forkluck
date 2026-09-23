import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  clampRecipeQuantity,
  clampScaleFactor,
  formatAppliedScaleFactor,
  formatKitchenAmount,
  formatMeasuredAmount,
  formatScaledAmount,
  formatScaledWeight,
  formatScaleFactor,
  formatYieldAmount,
  MAX_SCALE_FACTOR,
  MIN_SCALE_FACTOR,
  parseRecipeText,
  quantizeScaleFactor,
  scaleFactorFromYield,
  scaleFromRequestedYield,
  scaleIngredientLines,
  scaledTotalGrams,
  tidyVolume,
} from "../lib/recipe"
import type { ParsedRecipeLine, ParseRecipeOptions } from "../lib/recipe"
import type { WeightSystem } from "../lib/units"

/**
 * The scaled sheet, pinned as data.
 *
 * `tests/fixtures/scale-cases.json` is copied verbatim into the Mac app
 * (`forkluck-macosTests/Fixtures/`), whose Swift port of lib/recipe/scale.ts
 * asserts every case. A number that is not finite is written as the string
 * "NaN", "Infinity" or "-Infinity". Regenerate with
 * `UPDATE_SCALE_FIXTURE=1 pnpm exec vitest run tests/scale-cases.test.ts` and
 * copy it across.
 */

const FIXTURE = new URL("./fixtures/scale-cases.json", import.meta.url)
const GENERATOR =
  "cd apps/web && UPDATE_SCALE_FIXTURE=1 pnpm exec vitest run tests/scale-cases.test.ts"

// The hand-built lines of recipe-scale.test.ts, copied as they are there.
function line(
  fields: Pick<
    ParsedRecipeLine,
    | "lineNumber"
    | "rawLine"
    | "enteredAmount"
    | "enteredUnit"
    | "normalizedUnit"
    | "note"
    | "ingredient"
  > &
    Partial<Pick<ParsedRecipeLine, "resolutionSource" | "measureRange">>
): ParsedRecipeLine {
  return {
    kind: "ingredient",
    ingredientName: fields.ingredient?.name ?? "",
    baseName: fields.ingredient?.name ?? "",
    sizeWord: null,
    identityCandidates: [],
    qualifier: null,
    noteText: null,
    amountRange: null,
    equivalent: null,
    alert: null,
    componentQuantity: null,
    identityMatched: fields.ingredient !== null,
    resolutionSource: null,
    measureRange: null,
    ...fields,
  }
}

const LINES: Record<string, ParsedRecipeLine> = {
  gram: line({
    lineNumber: 1,
    rawLine: "500 gr. Bread Flour",
    enteredAmount: 500,
    enteredUnit: "gr",
    normalizedUnit: "g",
    note: null,
    ingredient: { id: "paste-1", name: "Bread Flour", grams: 500 },
  }),
  kilogram: line({
    lineNumber: 2,
    rawLine: "2 kg Water",
    enteredAmount: 2,
    enteredUnit: "kg",
    normalizedUnit: "kg",
    note: "Converted 2 kg to 2000 g.",
    ingredient: { id: "paste-2", name: "Water", grams: 2000 },
  }),
  ounce: line({
    lineNumber: 3,
    rawLine: "4 oz Butter",
    enteredAmount: 4,
    enteredUnit: "oz",
    normalizedUnit: "oz",
    note: "Converted 4 oz to 113.4 g.",
    ingredient: { id: "paste-3", name: "Butter", grams: 113.3980925 },
  }),
  assumedGram: line({
    lineNumber: 4,
    rawLine: "620 Bread Flour",
    enteredAmount: 620,
    enteredUnit: null,
    normalizedUnit: "assumed-g",
    note: "No unit supplied; assumed grams.",
    ingredient: { id: "paste-4", name: "Bread Flour", grams: 620 },
  }),
  each: line({
    lineNumber: 5,
    rawLine: "3 each Eggs",
    enteredAmount: 3,
    enteredUnit: "each",
    normalizedUnit: "each",
    note: "Converted using 50 g per Egg.",
    ingredient: { id: "paste-5", name: "Eggs", grams: 150 },
  }),
  explicitWeight: line({
    lineNumber: 6,
    rawLine: "2 kg (1500 g total) Flour",
    enteredAmount: 2,
    enteredUnit: "kg",
    normalizedUnit: "kg",
    note: "Used the explicit weight written in the recipe.",
    ingredient: { id: "paste-6", name: "Flour", grams: 1500 },
    resolutionSource: "explicit-weight",
  }),
  reviewedMeasure: line({
    lineNumber: 7,
    rawLine: "2 cups Flour",
    enteredAmount: 2,
    enteredUnit: "cups",
    normalizedUnit: "cup",
    note: "Converted using a catalog estimate. Source range: 200–300 g; review this estimate.",
    ingredient: { id: "paste-7", name: "Flour", grams: 250 },
    resolutionSource: "catalog-measure",
    measureRange: { lowGrams: 200, highGrams: 300, requiresReview: true },
  }),
  estimatedMeasure: line({
    lineNumber: 9,
    rawLine: "1 cup Milk",
    enteredAmount: 1,
    enteredUnit: "cup",
    normalizedUnit: "cup",
    note: "Converted using a catalog estimate.",
    ingredient: { id: "paste-9", name: "Milk", grams: 240 },
    resolutionSource: "catalog-measure",
    measureRange: { lowGrams: 235, highGrams: 245, requiresReview: false },
  }),
  yeast: line({
    lineNumber: 8,
    rawLine: "1 g Yeast",
    enteredAmount: 1,
    enteredUnit: "g",
    normalizedUnit: "g",
    note: null,
    ingredient: { id: "paste-8", name: "Yeast", grams: 1 },
  }),
  salt: line({
    lineNumber: 9,
    rawLine: "10 g kosher salt",
    enteredAmount: 10,
    enteredUnit: "g",
    normalizedUnit: "g",
    note: null,
    ingredient: { id: "paste-9", name: "Kosher salt", grams: 10 },
  }),
}

const JAM: ParseRecipeOptions = {
  identities: [
    {
      id: "jam",
      name: "Cookie jam",
      normalizedName: "cookie jam",
      source: "component",
      componentYieldAmount: 60,
      componentYieldUnit: "pcs",
    },
  ],
}

type Run =
  | { lines: string[]; factor: number }
  | { text: string; options?: ParseRecipeOptions; factor: number }

/** Every scaleIngredientLines call of recipe-scale.test.ts, then a few more. */
const RUNS: Run[] = [
  { lines: ["gram", "kilogram", "each"], factor: 1 },
  { lines: ["gram", "kilogram", "each"], factor: 2 },
  { lines: ["explicitWeight"], factor: 1 },
  { lines: ["explicitWeight"], factor: 3 },
  { text: "2 kg (1500 g total) Flour", factor: 2 },
  { lines: ["estimatedMeasure"], factor: 0.001 },
  { lines: ["reviewedMeasure"], factor: 2 },
  { lines: ["estimatedMeasure"], factor: 2 },
  { lines: ["gram"], factor: 2 },
  { text: "500 gr. Bread Flour\n2 kg Water", factor: 2 },
  { lines: ["assumedGram"], factor: 0.5 },
  { lines: ["each"], factor: 4.333 },
  { lines: ["each"], factor: 1.5 },
  { text: "1 ea Cookie jam", options: JAM, factor: 3 },
  { text: "2 400 g cans Diced tomatoes", factor: 2 },
  { text: "2 400 g cans Diced tomatoes", factor: 0.5 },
  { text: "3 400 g cans Diced tomatoes", factor: 0.333 },
  { text: "3 400 g cans Diced tomatoes", factor: 0.4 },
  { text: "3 400 g cans Diced tomatoes", factor: 1 / 6 },
  { text: "2 250 g boxes Pasta", factor: 1 },
  { text: "3 100 g jars Honey", factor: 1 },
  { text: "2 20 g cloves Garlic", factor: 1 },
  { text: "4 15 g bunches Basil", factor: 1 },
  { lines: ["kilogram"], factor: 2 },
  { lines: ["ounce"], factor: 2 },
  { lines: ["yeast"], factor: 0.01 },
  { lines: ["yeast"], factor: MIN_SCALE_FACTOR },
  { lines: ["each"], factor: MIN_SCALE_FACTOR },
  { lines: ["gram"], factor: 1 },
  { lines: ["yeast"], factor: 0.05 },
  { lines: ["yeast"], factor: 0.049 },
  { lines: ["each"], factor: 4.111 },
  { lines: ["salt"], factor: 1.0333 },
  { lines: [], factor: 3 },
  { lines: ["ounce", "salt", "estimatedMeasure"], factor: 0.75 },
  { text: "1 1/2 cups Milk\n6 tsp Vanilla extract\n2 tbsp Butter", factor: 8 },
  { text: "3 each Eggs\n1 pinch Salt\n2 sprigs Thyme", factor: 2.5 },
  { text: "1 lb Butter\n8 oz Sugar", factor: 1.5 },
]

/** Written as the string JSON cannot otherwise carry. */
const num = (value: number) => (Number.isFinite(value) ? value : String(value))

const SYSTEMS: WeightSystem[] = ["metric", "us"]

const FACTORS = [
  0,
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  1e9,
  1e-9,
  1,
  0.0014,
  4.3333333,
  1 / 3,
  1000,
  0.001,
  2,
  0.0015,
  104 / 24,
  0.5,
  2.5,
  4.333,
  0.333,
  1.23456,
  999.9999,
  0.00149,
  0.0005,
]

const KITCHEN: { amount: number; decimals?: number }[] = [
  { amount: 10.333, decimals: 1 },
  { amount: 0.35 },
  { amount: 2030.333 },
  { amount: 10.5 },
  { amount: 1 / 3 },
  { amount: 2.5 },
  { amount: 3.226 },
  ...[
    0,
    0.001,
    0.01,
    0.049,
    0.125,
    0.25,
    0.5,
    0.66,
    2 / 3,
    0.75,
    0.8,
    1,
    1.25,
    1.5,
    1.75,
    2.2,
    3.5,
    7.25,
    9.99,
    10,
    12.5,
    99.5,
    1000,
    12345.678,
  ].flatMap((amount) => [{ amount }, { amount, decimals: 1 }]),
]

const MEASURED: { amount: number; unit: string; decimals?: number }[] = [
  { amount: 2030.333, unit: "g" },
  { amount: 2.55, unit: "g" },
  { amount: 2030.333, unit: "g", decimals: 1 },
  { amount: 4.256, unit: "oz" },
  { amount: 0.4, unit: "g" },
  ...[
    "g",
    "kg",
    "oz",
    "lb",
    "ml",
    "l",
    "cup",
    "tsp",
    "tbsp",
    "each",
    "",
  ].flatMap((unit) =>
    [0.004, 0.25, 1.5, 2.333, 12.75, 1500.5].map((amount) => ({
      amount,
      unit,
    }))
  ),
]

const WEIGHTS: {
  grams: number
  system: WeightSystem
  original?: Parameters<typeof formatScaledWeight>[2]
  decimals?: number
}[] = [
  { grams: 0.24, system: "metric" },
  { grams: 0.01, system: "metric" },
  { grams: 0.01, system: "us" },
  { grams: 2500, system: "metric" },
  { grams: 0, system: "metric" },
  {
    grams: 2030.333,
    system: "metric",
    original: { amount: 2030.333, unit: "g" },
  },
  {
    grams: 10.333,
    system: "metric",
    original: { amount: 10.333, unit: "g" },
    decimals: 1,
  },
  { grams: 1234, system: "metric" },
  { grams: 12345, system: "metric" },
  ...[0.0001, 0.001, 0.4, 28.35, 453.6, 999.5, 1000, 4535.9].flatMap((grams) =>
    SYSTEMS.map((system) => ({ grams, system }))
  ),
  { grams: 453.59237, system: "us", original: { amount: 1, unit: "lb" } },
  { grams: 453.59237, system: "metric", original: { amount: 1, unit: "lb" } },
  { grams: 1500, system: "metric", original: { amount: 1.5, unit: "kg" } },
]

const YIELDS = [
  24 * (104 / 24),
  2 * 4.333,
  0.125,
  0.000001 * MIN_SCALE_FACTOR,
  2000,
  1000,
  1.5,
  1,
  24,
  48,
  12,
  1234567.891,
  0.1 + 0.2,
]

const REQUESTS: { saved: number; requested: number }[] = [
  { saved: 1000, requested: 1.5 },
  { saved: 24, requested: 104 },
  { saved: 24, requested: 12 },
  { saved: 1000, requested: Number.NaN },
  { saved: 1000, requested: 0.0000001 },
  { saved: 24, requested: 0 },
  { saved: 0, requested: 12 },
  { saved: 1, requested: 5000 },
  { saved: 3, requested: 1 },
]

const FROM_YIELD: { saved: number; target: number }[] = [
  { saved: 24, target: 104 },
  { saved: 0, target: 100 },
  { saved: -24, target: 100 },
  { saved: Number.NaN, target: 100 },
  { saved: 24, target: 0 },
  { saved: 24, target: -100 },
  { saved: 24, target: Number.NaN },
  { saved: 3, target: 1 },
]

const VOLUMES: { amount: number; unit: string }[] = [
  { amount: 6, unit: "tsp" },
  { amount: 48, unit: "tsp" },
  { amount: 32, unit: "tbsp" },
  { amount: 4.5, unit: "tsp" },
  { amount: 2, unit: "tsp" },
  { amount: 7, unit: "cup" },
  { amount: 3.0001, unit: "tsp" },
  { amount: 15, unit: "tbsp" },
  { amount: 16, unit: "tbsp" },
  { amount: 96, unit: "tsp" },
  { amount: 9, unit: "tsp" },
]

function generate() {
  return {
    generator: GENERATOR,
    minScaleFactor: MIN_SCALE_FACTOR,
    maxScaleFactor: MAX_SCALE_FACTOR,
    runs: RUNS.map((run) => {
      const lines =
        "lines" in run
          ? run.lines.map((name) => LINES[name])
          : parseRecipeText(run.text, run.options).parsedLines
      const scaled = scaleIngredientLines(lines, run.factor)
      return {
        lines,
        factor: run.factor,
        expect: {
          scaled,
          metric: scaled.map((row) => formatScaledAmount(row, "metric")),
          us: scaled.map((row) => formatScaledAmount(row, "us")),
          totalGrams: scaledTotalGrams(lines, run.factor),
        },
      }
    }),
    factors: FACTORS.map((factor) => {
      const clamped = clampScaleFactor(factor)
      return {
        factor: num(factor),
        clamp: clamped,
        quantize: clamped === null ? null : quantizeScaleFactor(clamped),
        format: clamped === null ? null : formatScaleFactor(clamped),
        formatApplied:
          clamped === null ? null : formatAppliedScaleFactor(clamped),
      }
    }),
    formatKitchenAmount: KITCHEN.map(({ amount, decimals }) => ({
      amount,
      decimals: decimals ?? 0,
      expect: formatKitchenAmount(amount, decimals),
    })),
    formatMeasuredAmount: MEASURED.map(({ amount, unit, decimals }) => ({
      amount,
      unit,
      decimals: decimals ?? 0,
      expect: formatMeasuredAmount(amount, unit, decimals),
    })),
    formatScaledWeight: WEIGHTS.map(
      ({ grams, system, original, decimals }) => ({
        grams,
        system,
        original: original ?? null,
        decimals: decimals ?? 0,
        expect: formatScaledWeight(grams, system, original, decimals),
      })
    ),
    formatYieldAmount: YIELDS.map((amount) => ({
      amount,
      expect: formatYieldAmount(amount),
    })),
    scaleFactorFromYield: FROM_YIELD.map(({ saved, target }) => ({
      saved: num(saved),
      target: num(target),
      expect: scaleFactorFromYield(saved, target),
    })),
    scaleFromRequestedYield: REQUESTS.map(({ saved, requested }) => ({
      saved: num(saved),
      requested: num(requested),
      expect: scaleFromRequestedYield(saved, requested),
    })),
    tidyVolume: VOLUMES.map(({ amount, unit }) => ({
      amount,
      unit,
      expect: tidyVolume(amount, unit),
    })),
    clampRecipeQuantity: [
      1.333333,
      "2.50000",
      0,
      1234.56789,
      "abc",
      "",
      1e-7,
    ].map((amount) => ({ amount, expect: clampRecipeQuantity(amount) })),
  }
}

describe("the scale fixture the Mac app asserts against", () => {
  it("matches what the scaled sheet prints", () => {
    const generated = JSON.parse(JSON.stringify(generate()))
    if (process.env.UPDATE_SCALE_FIXTURE || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(generated, null, 2) + "\n")
    }
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8"))
    expect(committed).toEqual(generated)
  })
})
