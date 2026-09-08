import type { ArchiveStatusFilter } from "@/lib/backend/pagination"

export const RECIPE_BROWSE_ORDERS = [
  "name",
  "-name",
  "category",
  "-category",
  "updatedAt",
  "-updatedAt",
] as const

export type RecipeStatusFilter = ArchiveStatusFilter
