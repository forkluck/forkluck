import type { ArchiveStatusFilter } from "@/lib/backend/pagination"

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

export type IngredientStatusFilter = ArchiveStatusFilter

/** Supplies are ingredients the kitchen does not eat; they browse on their own
 *  screen, from the same table. */
export type IngredientKind = "food" | "supply"
