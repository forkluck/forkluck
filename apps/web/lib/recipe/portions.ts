import {
  batchAmountIn,
  yieldFamily,
  type WeighRecipe,
} from "@/lib/recipe/weigh"

export function recipePrepTimeSeconds(recipe: {
  prepTimeAmount?: number | null
  prepTimeUnit?: string
}): number | null {
  return recipe.prepTimeAmount
    ? Math.round(
        recipe.prepTimeAmount * (recipe.prepTimeUnit === "hours" ? 3600 : 60)
      )
    : null
}

/**
 * How many portions a batch makes: the total yield divided by one serving.
 * Null when no serving is stated or when the two cannot be related. Total
 * Yield counts batches and pieces; it does not silently declare a Portion.
 */
export function recipePortions(
  recipe: WeighRecipe | null,
  serving: { amount: number | null; unit: string }
): number | null {
  if (!recipe) return null
  if (!serving.amount || serving.amount <= 0 || !serving.unit) return null
  const family = yieldFamily(serving.unit)
  if (!family) return null
  const batch = batchAmountIn(recipe, family)
  const oneServing = batchAmountIn(
    {
      id: "serving",
      yieldAmount: serving.amount,
      yieldUnit: serving.unit,
    },
    family
  )
  return batch === null || oneServing === null ? null : batch / oneServing
}
