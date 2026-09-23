import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  computeCostBreakdown,
  observedSecondsForBatch,
  scaleBatchCost,
  sellableCount,
  type RecipeCostInput,
  type StepCostInput,
} from "../lib/benchcost/math"

/**
 * The Cost tab's batch arithmetic, pinned as data.
 *
 * `tests/fixtures/benchcost-cases.json` is copied verbatim into the Mac app
 * (`forkluck-macosTests/Fixtures/`), whose Swift port of lib/benchcost/math.ts
 * asserts every case. Regenerate with
 * `UPDATE_BENCHCOST_FIXTURE=1 pnpm exec vitest run tests/benchcost-cases.test.ts`
 * and copy it across.
 */

const FIXTURE = new URL("./fixtures/benchcost-cases.json", import.meta.url)
const GENERATOR =
  "cd apps/web && UPDATE_BENCHCOST_FIXTURE=1 pnpm exec vitest run tests/benchcost-cases.test.ts"

// The builders of benchcost-math.test.ts.
const baseRecipe = (
  overrides: Partial<RecipeCostInput> = {}
): RecipeCostInput => ({
  ingredientCostCents: 2450,
  batchYield: 72,
  sellableYield: null,
  prepTimeSeconds: null,
  autoPrepTime: false,
  steps: [],
  ...overrides,
})

const step = (
  id: string,
  kind: "active" | "passive",
  seconds: number[]
): StepCostInput => ({
  id,
  kind,
  timings: seconds.map((value) => ({ seconds: value, yieldCount: 1 })),
})

type ScaleInput = Parameters<typeof scaleBatchCost>[0]

const SCALE_BASE: Omit<ScaleInput, "scale"> = {
  lineCostCents: [120, null, 80],
  basePortions: 10,
  prepTimeSeconds: 600,
  autoPrepTime: false,
  steps: [step("mix", "active", [300])],
  wagePerHourCents: 3600,
}

const SCALES: ScaleInput[] = [
  { ...SCALE_BASE, scale: 1 },
  { ...SCALE_BASE, scale: 2 },
  {
    lineCostCents: [200],
    basePortions: null,
    prepTimeSeconds: null,
    autoPrepTime: false,
    steps: [],
    wagePerHourCents: 3600,
    scale: 2,
  },
  { ...SCALE_BASE, autoPrepTime: true, scale: 0.5 },
  {
    lineCostCents: [33.3333, 12.5, null, null],
    basePortions: 7,
    prepTimeSeconds: 1234,
    autoPrepTime: true,
    steps: [
      step("mix", "active", [600, 300]),
      step("pack", "active", []),
      step("bake", "passive", [1800]),
    ],
    wagePerHourCents: 2000,
    scale: 1.75,
  },
  {
    lineCostCents: [],
    basePortions: 0,
    prepTimeSeconds: 0,
    autoPrepTime: false,
    steps: [],
    wagePerHourCents: 2000,
    scale: 3,
  },
]

const STEPS: StepCostInput[] = [
  step("mix", "active", [600, 300]),
  { id: "mix", kind: "active", timings: [{ seconds: 600, yieldCount: 70 }] },
  step("mix", "active", []),
  step("mix", "active", [0]),
  step("mix", "active", [0, 400, 0, 200]),
  step("rest", "passive", [100]),
]

const SELLABLE: { batchYield: number; sellableYield: number | null }[] = [
  { batchYield: 72, sellableYield: 68 },
  { batchYield: 72, sellableYield: null },
  { batchYield: 72, sellableYield: 0 },
  { batchYield: 72, sellableYield: -5 },
  { batchYield: 0, sellableYield: null },
  { batchYield: -3, sellableYield: null },
  { batchYield: 0.5, sellableYield: null },
]

const BREAKDOWNS: { recipe: RecipeCostInput; wagePerHourCents: number }[] = [
  { recipe: baseRecipe(), wagePerHourCents: 2000 },
  { recipe: baseRecipe({ prepTimeSeconds: 1800 }), wagePerHourCents: 3600 },
  { recipe: baseRecipe(), wagePerHourCents: 3600 },
  {
    recipe: baseRecipe({
      autoPrepTime: true,
      prepTimeSeconds: 9999,
      steps: [step("mix", "active", [600]), step("shape", "active", [300])],
    }),
    wagePerHourCents: 3600,
  },
  {
    recipe: baseRecipe({
      autoPrepTime: true,
      steps: [step("mix", "active", [600]), step("bake", "passive", [720])],
    }),
    wagePerHourCents: 3600,
  },
  {
    recipe: baseRecipe({
      autoPrepTime: true,
      steps: [
        step("mix", "active", [600]),
        step("pack", "active", []),
        step("bake", "passive", []),
      ],
    }),
    wagePerHourCents: 3600,
  },
  {
    recipe: baseRecipe({
      autoPrepTime: true,
      steps: [step("pack", "active", []), step("bake", "passive", [720])],
    }),
    wagePerHourCents: 3600,
  },
  { recipe: baseRecipe({ sellableYield: 60 }), wagePerHourCents: 2000 },
  {
    recipe: baseRecipe({ batchYield: 0, prepTimeSeconds: 900 }),
    wagePerHourCents: 1725,
  },
  {
    recipe: baseRecipe({ ingredientCostCents: 0, prepTimeSeconds: 0 }),
    wagePerHourCents: 2000,
  },
]

function generate() {
  return {
    generator: GENERATOR,
    scaleBatchCost: SCALES.map((input) => ({
      input,
      expect: scaleBatchCost(input),
    })),
    observedSecondsForBatch: STEPS.map((input) => ({
      step: input,
      expect: observedSecondsForBatch(input),
    })),
    sellableCount: SELLABLE.map((input) => ({
      ...input,
      expect: sellableCount(input.batchYield, input.sellableYield),
    })),
    computeCostBreakdown: BREAKDOWNS.map((input) => ({
      ...input,
      expect: computeCostBreakdown(input.recipe, input.wagePerHourCents),
    })),
  }
}

describe("the benchcost fixture the Mac app asserts against", () => {
  it("matches what the Cost tab computes", () => {
    const generated = JSON.parse(JSON.stringify(generate()))
    if (process.env.UPDATE_BENCHCOST_FIXTURE || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(generated, null, 2) + "\n")
    }
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8"))
    expect(committed).toEqual(generated)
  })
})
