export const RECIPE_STATUSES = ["active", "archived"] as const

export type RecipeStatus = (typeof RECIPE_STATUSES)[number]

export const DEFAULT_RECIPE_STATUS: RecipeStatus = "active"
