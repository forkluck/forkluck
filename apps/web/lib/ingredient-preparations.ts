import type { IngredientRow } from "@/lib/backend/types"

/**
 * What a preparation starts from when "average weight" is on: the pack this
 * ingredient is bought as, in the unit it was entered in.
 */
export function preparationDefaults(
  ingredient: Pick<IngredientRow, "purchaseSize" | "purchaseUnit">
): { weight: string; weightUnit: string } | null {
  if (!ingredient.purchaseSize || !ingredient.purchaseUnit) return null
  return {
    weight: String(ingredient.purchaseSize),
    weightUnit: ingredient.purchaseUnit,
  }
}
