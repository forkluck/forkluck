export const RECIPE_BROWSE_ORDERS = [
  "name",
  "-name",
  "category",
  "-category",
  "updatedAt",
  "-updatedAt",
] as const

export type RecipeStatusFilter = "active" | "archived" | null

export function parseRecipeStatusFilter(status?: string): RecipeStatusFilter {
  if (status === "archived") return "archived"
  if (status === "all") return null
  return "active"
}
