export type IngredientOption = {
  id: string
  name: string
  /** A supply, not food: the picker groups on it and the invoice review
   *  files the line under a supply category because of it. */
  nonEdible: boolean
}

export const INGREDIENT_BROWSE_ORDERS = [
  "name",
  "-name",
  "updatedAt",
  "-updatedAt",
] as const

export type IngredientStatusFilter = "active" | "archived" | null

/** Absent means active only; "all" drops the filter, the way Recipes does. */
export function parseIngredientStatusFilter(
  status?: string
): IngredientStatusFilter {
  if (status === "archived") return "archived"
  if (status === "all") return null
  return "active"
}

/** Supplies are ingredients the kitchen does not eat; they browse on their own
 *  screen, from the same table. */
export type IngredientKind = "food" | "supply"
