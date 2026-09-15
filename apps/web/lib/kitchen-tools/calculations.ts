import { z } from "zod"

const money = z.number().finite().nonnegative().max(1_000_000_000)
export const batchCalculationSchema = z.strictObject({
  portions: z.number().finite().min(0.000001).max(1_000_000),
  ingredientCostPerBatch: money.describe(
    "Total ingredient cost for the whole batch. A stated per-portion ingredient cost is the same cost on another basis, not another expense."
  ),
  packagingCostPerPortion: money
    .default(0)
    .describe(
      "Only a separately stated packaging cost per portion. Omit if packaging was not mentioned; do not put ingredient/per-portion cost here."
    ),
  otherCostPerBatch: money
    .default(0)
    .describe(
      "Only separately stated additional costs, excluding ingredients and packaging. Omit when no additional costs were supplied."
    ),
  sellingPricePerPortion: money
    .min(0.000001)
    .optional()
    .describe(
      "Only an explicitly supplied selling/menu price, never a cost per portion. Omit when no selling price was given."
    ),
  ingredientChangePercent: z.number().finite().min(-100).max(10_000).default(0),
  targetMarginPercent: z.number().finite().min(0).lt(100).optional(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
})
export type BatchCalculationInput = z.infer<typeof batchCalculationSchema>

/** User-supplied assumptions only: no saved prices and no currency conversion. */
export function calculateBatchCost(raw: BatchCalculationInput) {
  const input = batchCalculationSchema.parse(raw)
  const ingredient = input.ingredientCostPerBatch / input.portions
  const other =
    input.packagingCostPerPortion + input.otherCostPerBatch / input.portions
  const baselineVariable = ingredient + other
  const changedIngredient =
    ingredient * (1 + input.ingredientChangePercent / 100)
  const variable = changedIngredient + other
  const sellingPrice = input.sellingPricePerPortion
  const margin =
    sellingPrice === undefined
      ? null
      : (sellingPrice - baselineVariable) / sellingPrice
  const targetMargin =
    input.targetMarginPercent === undefined
      ? margin
      : input.targetMarginPercent / 100
  // A zero-cost baseline has a 100% margin: no finite positive selling price
  // can preserve it once costs become positive. Never return Infinity/NaN.
  const targetPrice =
    targetMargin === null || targetMargin >= 1
      ? null
      : variable / (1 - targetMargin)
  const clean = (value: number | null) =>
    value === null ? null : Number(value.toPrecision(12))
  const digits =
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: input.currencyCode,
    }).resolvedOptions().maximumFractionDigits ?? 2
  const factor = 10 ** digits
  return {
    ok: true as const,
    tool: "calculate_batch_cost" as const,
    hypothetical: true as const,
    assumptions: input,
    currencyCode: input.currencyCode,
    baseline: {
      ingredientCostPerPortion: clean(ingredient),
      variableCostPerPortion: clean(baselineVariable),
      contributionPerPortion:
        sellingPrice === undefined
          ? null
          : clean(sellingPrice - baselineVariable),
      marginPercent: clean(margin === null ? null : margin * 100),
      markupPercent:
        sellingPrice === undefined || baselineVariable === 0
          ? null
          : clean(((sellingPrice - baselineVariable) / baselineVariable) * 100),
    },
    scenario: {
      ingredientCostPerPortion: clean(changedIngredient),
      variableCostPerPortion: clean(variable),
      targetMarginPercent: clean(
        targetMargin === null ? null : targetMargin * 100
      ),
      exactSellingPrice: clean(targetPrice),
      minimumSellingPrice:
        targetPrice === null
          ? null
          : Math.ceil(Number((targetPrice * factor).toPrecision(12))) / factor,
    },
    exclusions:
      "Only the supplied costs are included. Labor, tax and waste are excluded unless included in the supplied costs. Nothing is saved.",
  }
}
