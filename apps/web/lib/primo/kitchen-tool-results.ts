import type { RecipeCostDiff } from "@/lib/backend/types"
import type { KitchenToolName } from "@/lib/primo/kitchen-tools"

export type KitchenToolFailure = {
  ok: false
  tool: KitchenToolName
  reason:
    | "bad_input"
    | "bad_period"
    | "unknown_ref"
    | "not_found"
    | "needs_scale"
    | "owner_only"
  message: string
}

export type FindRecipesResult = {
  ok: true
  tool: "find_recipes"
  query: string
  more: boolean
  recipes: Array<{
    recipeRef: string
    title: string
    yieldAmount: number | null
    yieldUnit: string | null
    servingAmount: number | null
    servingUnit: string
  }>
  ambiguous: string[]
}

export type FindProductsResult = {
  ok: true
  tool: "find_products"
  query: string
  more: boolean
  products: Array<{
    productRef: string
    name: string
    sku: string
    baseUnit: string
    recipes: Array<{ recipeRef: string; title: string }>
  }>
  ambiguous: string[]
}

export type ProductSalesResult = {
  ok: true
  tool: "get_product_sales"
  product: { productRef: string; name: string; baseUnit: string }
  period: { startDate: string; endDate: string; label: string }
  units: number
  netSalesCents: number
  currencyCode: string
  salesView: "as_sold"
  incompleteRevenue: boolean
  view: string
}

export type RecipeBatchResult = {
  ok: true
  tool: "show_recipe_batch"
  saved: false
  recipe: { recipeRef: string; title: string }
  basis: "portions" | "multiplier"
  factor: number
  label: string
  portions: number | null
  yieldAmount: number | null
  yieldUnit: string | null
  cost: {
    currencyCode: string
    ingredientTotalCents: number
    unpricedLineCount: number
    portionCostCents: number | null
    laborCentsPerBatch: number | null
    laborCentsPerPortion: number | null
  } | null
  view: string
}

export type RecipeCostChangeResult = {
  ok: true
  tool: "get_recipe_cost_change"
  view: string
  omittedLines: number
} & RecipeCostDiff

export type KitchenToolResult =
  | KitchenToolFailure
  | FindRecipesResult
  | FindProductsResult
  | ProductSalesResult
  | RecipeBatchResult
  | RecipeCostChangeResult
