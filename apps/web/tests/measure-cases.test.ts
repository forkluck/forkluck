import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { shownQuantity } from "@/lib/recipe/lines-for-tools"
import { formatMeasuredAmount } from "@/lib/recipe/scale"
import { YIELD_UNIT_LABELS } from "@/lib/units"
import type { YieldUnit } from "@/lib/units"

/**
 * The scaled quantity a cook reads off the recipe sheet, pinned as data.
 *
 * `tests/fixtures/measure-cases.json` is generated from the functions below
 * and copied verbatim into the iOS app (`forkluck-iosTests/Fixtures/`), whose
 * Swift port of shownQuantity and formatYield asserts every case. A change to
 * the rounding here fails this test until the fixture is regenerated with
 * `UPDATE_MEASURE_FIXTURE=1 pnpm exec vitest run tests/measure-cases.test.ts`,
 * which is the reminder to copy it across.
 */

const FIXTURE = new URL("./fixtures/measure-cases.json", import.meta.url)

const LINES: {
  quantity: number | null
  unit: string
  displayName: string
  scale: number
}[] = [
  // Weights: whole grams unless the ingredient is one a cook weighs finely.
  { quantity: 100, unit: "g", displayName: "Bread flour", scale: 1 },
  { quantity: 100, unit: "g", displayName: "Bread flour", scale: 2 },
  { quantity: 1200, unit: "g", displayName: "Chicken stock", scale: 2 },
  { quantity: 333, unit: "g", displayName: "Bread flour", scale: 0.5 },
  { quantity: 5, unit: "g", displayName: "Fine sea salt", scale: 2.06 },
  { quantity: 5, unit: "g", displayName: "Fine sea salt", scale: 1 },
  { quantity: 1, unit: "g", displayName: "Ground cinnamon", scale: 2.56 },
  { quantity: 2, unit: "g", displayName: "Instant yeast", scale: 0.5 },
  { quantity: 5, unit: "g", displayName: "Bread flour", scale: 0.05 },
  { quantity: 5, unit: "g", displayName: "Bread flour", scale: 0.00008 },
  { quantity: 0.4, unit: "g", displayName: "Bread flour", scale: 1 },
  { quantity: 1, unit: "kg", displayName: "Bread flour", scale: 1.5 },
  { quantity: 1, unit: "kg", displayName: "Bread flour", scale: 0.3333 },
  { quantity: 1, unit: "lb", displayName: "Butter", scale: 0.5 },
  { quantity: 1, unit: "lb", displayName: "Butter", scale: 2 },
  { quantity: 1, unit: "oz", displayName: "Butter", scale: 0.333 },
  { quantity: 8, unit: "oz", displayName: "Butter", scale: 1.25 },
  // Volumes: kitchen fractions beside small wholes, exact folds up a unit.
  { quantity: 1, unit: "tsp", displayName: "Vanilla extract", scale: 1 },
  { quantity: 1, unit: "tsp", displayName: "Vanilla extract", scale: 1.5 },
  { quantity: 1, unit: "tsp", displayName: "Vanilla extract", scale: 3 },
  { quantity: 1, unit: "tsp", displayName: "Vanilla extract", scale: 4 },
  { quantity: 7, unit: "tsp", displayName: "Vanilla extract", scale: 1 },
  { quantity: 24, unit: "tsp", displayName: "Milk", scale: 2 },
  { quantity: 2, unit: "tbsp", displayName: "Butter", scale: 8 },
  { quantity: 2, unit: "tbsp", displayName: "Butter", scale: 4 },
  { quantity: 2, unit: "tbsp", displayName: "Butter", scale: 0.25 },
  { quantity: 1, unit: "cup", displayName: "Milk", scale: 0.333 },
  { quantity: 1, unit: "cup", displayName: "Milk", scale: 0.125 },
  { quantity: 1, unit: "cup", displayName: "Milk", scale: 2.75 },
  { quantity: 0.333333, unit: "cup", displayName: "Milk", scale: 1 },
  { quantity: 0.666667, unit: "cup", displayName: "Milk", scale: 1 },
  { quantity: 12, unit: "cup", displayName: "Milk", scale: 1.5 },
  { quantity: 1, unit: "ml", displayName: "Vanilla extract", scale: 0.4 },
  { quantity: 250, unit: "ml", displayName: "Milk", scale: 1.3 },
  { quantity: 1, unit: "l", displayName: "Water", scale: 0.001 },
  // Counts.
  { quantity: 3, unit: "each", displayName: "Eggs", scale: 1.5 },
  { quantity: 3, unit: "each", displayName: "Eggs", scale: 1 },
  { quantity: 1, unit: "each", displayName: "Lemon", scale: 0.5 },
  { quantity: 12, unit: "each", displayName: "Eggs", scale: 0.1 },
  { quantity: 2, unit: "can", displayName: "Tomatoes", scale: 3 },
  { quantity: 1, unit: "pinch", displayName: "Nutmeg", scale: 2 },
  // No quantity: the sheet prints the name alone.
  { quantity: null, unit: "", displayName: "Salt to taste", scale: 2 },
  { quantity: null, unit: "g", displayName: "Flour for dusting", scale: 1 },
  // Bare units the registry does not know keep their spelling.
  { quantity: 2, unit: "sprig", displayName: "Thyme", scale: 1.5 },
  { quantity: 1, unit: "", displayName: "Bay leaf", scale: 3 },
]

const YIELDS: { amount: number; unit: YieldUnit | null }[] = [
  { amount: 12, unit: "pcs" },
  { amount: 18, unit: "pcs" },
  { amount: 4.5, unit: "pcs" },
  { amount: 8, unit: "slice" },
  { amount: 1200, unit: "g" },
  { amount: 2400, unit: "g" },
  { amount: 1.5, unit: "kg" },
  { amount: 0.75, unit: "kg" },
  { amount: 2, unit: "lb" },
  { amount: 12.5, unit: "oz" },
  { amount: 6, unit: null },
]

function formatYield(amount: number, unit: YieldUnit | null): string {
  const word = unit ? YIELD_UNIT_LABELS[unit] : ""
  return `${formatMeasuredAmount(amount, unit ?? "")} ${word}`.trim()
}

function generate() {
  return {
    lines: LINES.map((line) => ({
      ...line,
      expect: shownQuantity(line, line.scale),
    })),
    yields: YIELDS.map((entry) => ({
      ...entry,
      expect: formatYield(entry.amount, entry.unit),
    })),
  }
}

describe("the measure fixture the iOS app asserts against", () => {
  it("matches what the web sheet prints", () => {
    const generated = generate()
    if (process.env.UPDATE_MEASURE_FIXTURE || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(generated, null, 2) + "\n")
    }
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8"))
    expect(committed).toEqual(generated)
  })
})
