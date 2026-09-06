import { describe, expect, it } from "vitest"

import {
  computeCostBreakdown,
  observedSecondsForBatch,
  scaleBatchCost,
  sellableCount,
  type RecipeCostInput,
} from "../lib/benchcost/math"

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

describe("scaleBatchCost", () => {
  it("uses one factor for lines, portions, prep labor and step labor", () => {
    const input = {
      lineCostCents: [120, null, 80],
      basePortions: 10,
      prepTimeSeconds: 600,
      autoPrepTime: false,
      steps: [step("mix", "active", [300])],
      wagePerHourCents: 3600,
    }
    const original = scaleBatchCost({ ...input, scale: 1 })
    const doubled = scaleBatchCost({ ...input, scale: 2 })

    expect(doubled.lineCostCents).toEqual([240, null, 160])
    expect(doubled.ingredientTotalCents).toBe(400)
    expect(doubled.unpricedLineCount).toBe(1)
    expect(doubled.portions).toBe(20)
    expect(doubled.portionCostCents).toBe(original.portionCostCents)
    expect(doubled.labor.laborCentsPerBatch).toBe(
      (original.labor.laborCentsPerBatch ?? 0) * 2
    )
    expect(doubled.labor.laborCentsPerPiece).toBe(
      original.labor.laborCentsPerPiece
    )
  })

  it("has no per-portion figure without a resolvable portion", () => {
    const result = scaleBatchCost({
      lineCostCents: [200],
      basePortions: null,
      prepTimeSeconds: null,
      autoPrepTime: false,
      steps: [],
      wagePerHourCents: 3600,
      scale: 2,
    })
    expect(result.portions).toBeNull()
    expect(result.portionCostCents).toBeNull()
  })
})

const step = (id: string, kind: "active" | "passive", seconds: number[]) => ({
  id,
  kind,
  timings: seconds.map((value) => ({ seconds: value, yieldCount: 1 })),
})

describe("observedSecondsForBatch", () => {
  it("averages the timings, one batch each", () => {
    expect(observedSecondsForBatch(step("mix", "active", [600, 300]))).toBe(450)
  })

  it("ignores the yield a timing was recorded against", () => {
    expect(
      observedSecondsForBatch({
        id: "mix",
        kind: "active",
        timings: [{ seconds: 600, yieldCount: 70 }],
      })
    ).toBe(600)
  })

  it("returns null without a timing that ran", () => {
    expect(observedSecondsForBatch(step("mix", "active", []))).toBeNull()
    expect(observedSecondsForBatch(step("mix", "active", [0]))).toBeNull()
  })
})

describe("sellableCount", () => {
  it("uses sellableYield when set and positive", () => {
    expect(sellableCount(72, 68)).toBe(68)
  })

  it("falls back to batchYield when sellableYield is null", () => {
    expect(sellableCount(72, null)).toBe(72)
  })

  it("falls back to batchYield when sellableYield is zero or negative", () => {
    expect(sellableCount(72, 0)).toBe(72)
    expect(sellableCount(72, -5)).toBe(72)
  })
})

describe("computeCostBreakdown", () => {
  it("computes ingredient cost per sellable piece", () => {
    const breakdown = computeCostBreakdown(baseRecipe(), 2000)
    expect(breakdown.ingredientCentsPerPiece).toBeCloseTo(2450 / 72, 6)
    expect(breakdown.totalCentsPerPiece).toBeCloseTo(2450 / 72, 6)
  })

  it("costs the prep time the cook typed", () => {
    // $36/hr = 1 cent per second keeps the arithmetic legible.
    const breakdown = computeCostBreakdown(
      baseRecipe({ prepTimeSeconds: 1800 }),
      3600
    )
    expect(breakdown.laborSource).toBe("prep")
    expect(breakdown.laborSecondsPerBatch).toBe(1800)
    expect(breakdown.laborCentsPerBatch).toBeCloseTo(1800, 6)
    expect(breakdown.laborCentsPerPiece).toBeCloseTo(1800 / 72, 6)
    expect(breakdown.totalCentsPerPiece).toBeCloseTo(2450 / 72 + 1800 / 72, 6)
  })

  it("reports no labor when the prep time is blank", () => {
    const breakdown = computeCostBreakdown(baseRecipe(), 3600)
    expect(breakdown.laborSource).toBe("prep")
    expect(breakdown.laborSecondsPerBatch).toBeNull()
    expect(breakdown.laborCentsPerBatch).toBeNull()
    expect(breakdown.laborCentsPerPiece).toBeNull()
  })

  it("adds up the active steps when the steps say the time", () => {
    const breakdown = computeCostBreakdown(
      baseRecipe({
        autoPrepTime: true,
        prepTimeSeconds: 9999,
        steps: [step("mix", "active", [600]), step("shape", "active", [300])],
      }),
      3600
    )
    expect(breakdown.laborSource).toBe("steps")
    expect(breakdown.laborSecondsPerBatch).toBe(900)
    expect(breakdown.timedActiveStepCount).toBe(2)
    expect(breakdown.laborCentsPerBatch).toBeCloseTo(900, 6)
  })

  it("excludes passive steps from labor entirely", () => {
    const breakdown = computeCostBreakdown(
      baseRecipe({
        autoPrepTime: true,
        steps: [step("mix", "active", [600]), step("bake", "passive", [720])],
      }),
      3600
    )
    expect(breakdown.laborSecondsPerBatch).toBe(600)
    expect(breakdown.timedActiveStepCount).toBe(1)
    expect(breakdown.untimedActiveStepCount).toBe(0)
  })

  it("flags untimed active steps while still computing a partial total", () => {
    const breakdown = computeCostBreakdown(
      baseRecipe({
        autoPrepTime: true,
        steps: [
          step("mix", "active", [600]),
          step("pack", "active", []),
          step("bake", "passive", []),
        ],
      }),
      3600
    )
    expect(breakdown.untimedActiveStepCount).toBe(1)
    expect(breakdown.laborSecondsPerBatch).toBe(600)
    expect(breakdown.totalCentsPerPiece).toBeGreaterThan(2450 / 72)
  })

  it("reports no labor when no active step is timed", () => {
    const breakdown = computeCostBreakdown(
      baseRecipe({
        autoPrepTime: true,
        steps: [step("pack", "active", []), step("bake", "passive", [720])],
      }),
      3600
    )
    expect(breakdown.laborSource).toBe("steps")
    expect(breakdown.laborCentsPerBatch).toBeNull()
    expect(breakdown.untimedActiveStepCount).toBe(1)
    expect(breakdown.totalCentsPerPiece).toBeCloseTo(2450 / 72, 6)
  })

  it("divides by sellable yield when set, not batch yield", () => {
    const breakdown = computeCostBreakdown(
      baseRecipe({ sellableYield: 60 }),
      2000
    )
    expect(breakdown.sellable).toBe(60)
    expect(breakdown.ingredientCentsPerPiece).toBeCloseTo(2450 / 60, 6)
  })
})
