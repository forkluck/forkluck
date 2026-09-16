import type { RecipeCostDiff } from "@/lib/backend/types"
import type { calculateBatchCost } from "./calculations"
import type { z } from "zod"
import type { ingredientPriceChangesSchema } from "@/lib/backend/schemas"
import type { KitchenToolName } from "@/lib/kitchen-tools/catalog"
import type { RecipeToolLine } from "@/lib/recipe/lines-for-tools"

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

/** What one recipe costs at the batch being read, when the reader may see it. */
export type RecipeToolCost = {
  currencyCode: string
  ingredientTotalCents: number
  unpricedLineCount: number
  portionCostCents: number | null
  laborCentsPerBatch: number | null
  laborCentsPerPortion: number | null
}

/** Every line of one recipe at one batch, already formatted, plus how many
 * there were and whether the list was cut. */
export type RecipeToolLineList = {
  lines: RecipeToolLine[]
  lineCount: number
  truncated: boolean
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
  /** Portions one 1x batch makes, so prose can say what was scaled from. */
  basePortions: number | null
  baseYieldAmount: number | null
  baseYieldUnit: string | null
  /** The same number as `factor`, named the way a sentence says it. */
  batches: number
  /** Only when a portion request does not land on a whole batch: the batches
   * a cook would actually run, and what they make. */
  wholeBatches: { factor: number; portions: number | null } | null
  cost: RecipeToolCost | null
  view: string
} & RecipeToolLineList

export type GetRecipeResult = {
  ok: true
  tool: "get_recipe"
  recipe: { recipeRef: string; title: string; description: string | null }
  portions: number | null
  yieldAmount: number | null
  yieldUnit: string | null
  cost: RecipeToolCost | null
  /** The label rollup the Nutrition tab shows, per serving. A nutrient the
   * linked records do not all report is null rather than a claimed sum. */
  nutrition: {
    perServing: Record<string, number | null>
    servingLabel: string | null
    allergens: string[]
  } | null
  view: string
} & RecipeToolLineList

export type RecipeCostChangeResult = {
  ok: true
  tool: "get_recipe_cost_change"
  view: string
  omittedLines: number
} & RecipeCostDiff

export type TopProductsResult = {
  ok: true
  tool: "get_top_products"
  period: { startDate: string; endDate: string; label: string }
  currencyCode: string
  salesView: "including_bundles"
  products: Array<{ name: string; netSalesCents: number }>
  hasRecordedProducts: boolean
  unrankedProducts: number
  more: boolean
  coverage: string
  view: string
}

export type KitchenToolResult =
  | ReturnType<typeof calculateBatchCost>
  | TopProductsResult
  | IngredientPriceChangesResult
  | KitchenToolFailure
  | FindRecipesResult
  | FindProductsResult
  | ProductSalesResult
  | RecipeBatchResult
  | GetRecipeResult
  | RecipeCostChangeResult

export type IngredientPriceChangesResult = z.infer<
  typeof ingredientPriceChangesSchema
> & {
  ok: true
  tool: "get_ingredient_price_changes"
  period: { startDate: string; endDate: string; label: string }
  view: string
}
