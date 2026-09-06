export type StepKind = "active" | "passive"

export type TimingObservation = {
  seconds: number
  yieldCount: number
}

export type StepCostInput = {
  id: string
  kind: StepKind
  timings: TimingObservation[]
}

export type RecipeCostInput = {
  ingredientCostCents: number
  batchYield: number
  sellableYield: number | null
  /** Hands-on time for one batch, as the cook stated it. */
  prepTimeSeconds: number | null
  /** Whether the steps say the time instead of the prep time field. */
  autoPrepTime: boolean
  steps: StepCostInput[]
}

export type CostBreakdown = {
  sellable: number
  laborSecondsPerBatch: number | null
  laborCentsPerBatch: number | null
  laborCentsPerPiece: number | null
  /** Where the labor figure came from, so a screen can say so. */
  laborSource: "prep" | "steps"
  ingredientCentsPerPiece: number
  totalCentsPerPiece: number
  untimedActiveStepCount: number
  timedActiveStepCount: number
}

export function sellableCount(
  batchYield: number,
  sellableYield: number | null
): number {
  if (sellableYield !== null && sellableYield > 0) return sellableYield
  return batchYield > 0 ? batchYield : 1
}

/** What one batch of this step takes: one timing is one batch of it. */
export function observedSecondsForBatch(step: StepCostInput): number | null {
  const timed = step.timings.filter((timing) => timing.seconds > 0)
  if (timed.length === 0) return null
  return timed.reduce((sum, timing) => sum + timing.seconds, 0) / timed.length
}

export function computeCostBreakdown(
  recipe: RecipeCostInput,
  wagePerHourCents: number
): CostBreakdown {
  const sellable = sellableCount(recipe.batchYield, recipe.sellableYield)

  let stepSecondsPerBatch = 0
  let untimedActiveStepCount = 0
  let timedActiveStepCount = 0

  for (const step of recipe.steps) {
    if (step.kind !== "active") continue
    const observed = observedSecondsForBatch(step)
    if (observed === null) {
      untimedActiveStepCount++
      continue
    }
    timedActiveStepCount++
    stepSecondsPerBatch += observed
  }

  const laborSource = recipe.autoPrepTime ? "steps" : "prep"
  const laborSecondsPerBatch =
    laborSource === "steps"
      ? timedActiveStepCount > 0
        ? stepSecondsPerBatch
        : null
      : recipe.prepTimeSeconds
  const laborCentsPerBatch =
    laborSecondsPerBatch === null
      ? null
      : (laborSecondsPerBatch / 3600) * wagePerHourCents
  const laborCentsPerPiece =
    laborCentsPerBatch === null ? null : laborCentsPerBatch / sellable
  const ingredientCentsPerPiece = recipe.ingredientCostCents / sellable

  return {
    sellable,
    laborSecondsPerBatch,
    laborCentsPerBatch,
    laborCentsPerPiece,
    laborSource,
    ingredientCentsPerPiece,
    totalCentsPerPiece: ingredientCentsPerPiece + (laborCentsPerPiece ?? 0),
    untimedActiveStepCount,
    timedActiveStepCount,
  }
}

export type ScaledBatchCost = {
  lineCostCents: Array<number | null>
  ingredientTotalCents: number
  unpricedLineCount: number
  portions: number | null
  portionCostCents: number | null
  labor: CostBreakdown
}

/** One batch-cost calculation shared by the Cost tab and kitchen tools. */
export function scaleBatchCost({
  lineCostCents,
  basePortions,
  prepTimeSeconds,
  autoPrepTime,
  steps,
  wagePerHourCents,
  scale,
}: {
  lineCostCents: Array<number | null>
  basePortions: number | null
  prepTimeSeconds: number | null
  autoPrepTime: boolean
  steps: StepCostInput[]
  wagePerHourCents: number
  scale: number
}): ScaledBatchCost {
  const scaledLines = lineCostCents.map((cost) =>
    cost === null ? null : cost * scale
  )
  const ingredientTotalCents = scaledLines.reduce<number>(
    (total, cost) => total + (cost ?? 0),
    0
  )
  const portions = basePortions === null ? null : basePortions * scale
  const labor = computeCostBreakdown(
    {
      ingredientCostCents: ingredientTotalCents,
      batchYield: portions ?? 1,
      sellableYield: null,
      prepTimeSeconds:
        prepTimeSeconds === null ? null : prepTimeSeconds * scale,
      autoPrepTime,
      steps: steps.map((step) => ({
        ...step,
        timings: step.timings.map((timing) => ({
          seconds: timing.seconds * scale,
          yieldCount: 1,
        })),
      })),
    },
    wagePerHourCents
  )
  return {
    lineCostCents: scaledLines,
    ingredientTotalCents,
    unpricedLineCount: scaledLines.filter((cost) => cost === null).length,
    portions,
    portionCostCents:
      portions === null ? null : ingredientTotalCents / portions,
    labor,
  }
}
