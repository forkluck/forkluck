import type { BenchcostRecipeWithData, RecipeSummary } from "../backend/types"
import { computeCostBreakdown } from "../benchcost/math"
import type { BodyPricing } from "../pricing"
import { GRAMS_PER_UNIT, type WeightUnit } from "../units"
import { countedAsEach, unitDefinition } from "../unit-registry"
import { DEFAULT_RECIPE_KIND, type RecipeKind } from "./kinds"
import type { RecipeCategory } from "./categories"
import type { RecipeStatus } from "./status"
import { recipePortions } from "./portions"
import type { WeighEquivalency } from "./weigh"

/** Ingredient cost as a share of menu price; over this reads as a warning. */
export const FOOD_COST_TARGET = 0.3

/**
 * What one sellable unit is. Counted yields divide by that count, in the word
 * the yield used; weight yields divide by the workspace's own weight basis, so
 * a US kitchen reads /lb and a metric one reads /kg.
 */
export function recipeUnitDivisor(
  recipe: Pick<RecipeSummary, "yieldAmount" | "yieldUnit">,
  unitPriceUnit: WeightUnit = "kg"
): { divisor: number; suffix: string } | null {
  const sellable = recipe.yieldAmount
  if (!sellable || sellable <= 0) return null
  if (countedAsEach(recipe.yieldUnit ?? null) === "each") {
    return {
      divisor: sellable,
      suffix: recipe.yieldUnit === "slice" ? "/slice" : "/pc",
    }
  }
  const definition = unitDefinition(recipe.yieldUnit ?? null)
  if (definition?.family === "volume" && definition.perBase !== null) {
    return {
      divisor: (sellable * definition.perBase) / 1000,
      suffix: "/L",
    }
  }
  if (definition?.family !== "mass") return null
  return {
    divisor:
      (sellable * GRAMS_PER_UNIT[recipe.yieldUnit as WeightUnit]) /
      GRAMS_PER_UNIT[unitPriceUnit],
    suffix: `/${unitPriceUnit}`,
  }
}

/** The commercial unit is the saved costing portion, never an implied yield. */
export function recipePortionDivisor(
  recipe: RecipeSummary & { equivalency?: WeighEquivalency | null }
): { divisor: number; suffix: string } | null {
  const amount = recipe.servingAmount ?? null
  const unit = recipe.servingUnit ?? ""
  const divisor = recipePortions(
    {
      id: recipe.id,
      yieldAmount: recipe.yieldAmount,
      yieldUnit: recipe.yieldUnit,
      equivalency: recipe.equivalency,
    },
    { amount, unit }
  )
  if (divisor === null || amount === null || !unit) return null
  return { divisor, suffix: `/${amount} ${unit}` }
}

export type RecipeHealth = {
  id: string
  publicId: string
  title: string
  code: string
  kind: RecipeKind
  status: RecipeStatus
  categoryId: string | null
  category: RecipeCategory | null
  updatedAt: Date
  /** Cost of one sellable unit, or null when there is no yield to divide by. */
  ingredientCents: number | null
  menuPriceCents: number | null
  /** Ingredient cost as a share of menu price. Labor is excluded. */
  foodCost: number | null
  overTarget: boolean
  suffix: string
  /** Every gap that leaves the cost per unit understated or missing. */
  issues: string[]
  labor: { centsPerBatch: number; centsPerPiece: number | null } | null
  ownerId?: string
  ownerName?: string
  permission?: "owner" | "editor" | "viewer"
  canEdit?: boolean
  canDelete?: boolean
  canViewCost?: boolean
}

/**
 * The list's alert column: the line-level gaps behind a recipe's amber marks,
 * one sentence per kind, in the order the cook would fix them. The editor and
 * the list must agree on what is "off", so every issue the editor flags in
 * amber reads out here. Setup gaps — yield, portion, labor — stay off the
 * flag: they have their own homes and would amber every new recipe.
 */
export function describeRecipeIssues(issues: string[]): string[] {
  const sentences: string[] = []
  const has = (issue: string) => issues.includes(issue)
  if (has("unresolved item")) {
    sentences.push("Lines not linked to an ingredient or recipe")
  }
  if (has("stray words")) {
    sentences.push("Lines with extra words that aren’t a saved preparation")
  }
  // The pasted-text path counts its gaps in the string; the saved-row path
  // names the kind once.
  const counted = issues.find((issue) => /^\d+ unpriced$/.test(issue))
  if (counted) {
    const count = counted.replace(" unpriced", "")
    sentences.push(
      `${count} ingredient${count === "1" ? "" : "s"} without a price`
    )
  } else if (has("unpriced ingredient")) {
    sentences.push("Ingredients without a price")
  }
  if (has("unpriced subrecipe")) {
    sentences.push("A sub-recipe that can’t be costed")
  }
  if (has("missing quantity")) {
    sentences.push("Lines without a quantity")
  }
  if (has("invalid efficiency")) {
    sentences.push("Lines with an invalid efficiency")
  }
  if (has("references another component")) {
    sentences.push("References another component, so it can’t be costed")
  }
  if (has("subrecipe cycle")) {
    sentences.push("Sub-recipes refer to each other in a loop")
  }
  return sentences
}

/**
 * The single definition of "is this recipe fully costed, and is it healthy".
 *
 * Shared by the Recipes list and the Home dashboard. Keeping one copy is the
 * point: a recipe must never read as fine on one screen and broken on
 * another.
 */
const PREP_TIME_SECONDS: Record<string, number> = {
  minutes: 60,
  hours: 3600,
}

function prepTimeSeconds(
  recipe: Pick<RecipeSummary, "prepTimeAmount" | "prepTimeUnit">
): number | null {
  const perUnit = PREP_TIME_SECONDS[recipe.prepTimeUnit ?? ""]
  if (recipe.prepTimeAmount == null || perUnit === undefined) return null
  return recipe.prepTimeAmount * perUnit
}

export function buildRecipeHealth(
  recipe: RecipeSummary & { equivalency?: WeighEquivalency | null },
  pricing: BodyPricing,
  costEntry: BenchcostRecipeWithData | null,
  wagePerHourCents: number,
  foodCostTarget = FOOD_COST_TARGET
): RecipeHealth {
  const unit = recipePortionDivisor(recipe)

  // Prep time costs labor without any step tracking, so the breakdown is built
  // whether or not this recipe has a cost entry behind it.
  const autoPrepTime = recipe.autoPrepTimeEnabled ?? false
  const breakdown = computeCostBreakdown(
    {
      ingredientCostCents: Math.round(pricing.totalCents),
      batchYield: costEntry?.batchYield ?? 1,
      sellableYield: costEntry?.sellableYield ?? null,
      prepTimeSeconds: prepTimeSeconds(recipe),
      autoPrepTime,
      steps: (costEntry?.steps ?? []).map((step) => ({
        id: step.id,
        kind: step.kind,
        timings: step.timings.map(({ seconds, yieldCount }) => ({
          seconds,
          yieldCount,
        })),
      })),
    },
    wagePerHourCents
  )

  const issues: string[] = []
  if (!recipe.yieldAmount || !recipe.yieldUnit) issues.push("no yield")
  else if (!recipe.servingAmount || !recipe.servingUnit)
    issues.push("no portion")
  else if (!unit) issues.push("portion needs equivalency")
  if (pricing.unpricedCount > 0) {
    issues.push(`${pricing.unpricedCount} unpriced`)
  }
  if (pricing.reviewCount > 0) {
    const count = pricing.reviewCount
    issues.push(`${count} estimate${count === 1 ? "" : "s"} to review`)
  }
  if (breakdown.laborSecondsPerBatch === null) {
    issues.push(autoPrepTime ? "No timed steps" : "No prep time")
  } else if (breakdown.untimedActiveStepCount > 0) {
    const untimed = breakdown.untimedActiveStepCount
    issues.push(`${untimed} step${untimed > 1 ? "s" : ""} untimed`)
  }

  const ingredientCents = unit ? pricing.totalCents / unit.divisor : null
  // A component is never sold on its own, so a menu price — and the food cost
  // read off it — belong to the recipe that uses it, not here. Any price left
  // over from before the recipe became a component stays stored but unread.
  const kind = recipe.kind ?? DEFAULT_RECIPE_KIND
  const menuPriceCents = kind === "component" ? null : recipe.menuPriceCents
  const foodCost =
    ingredientCents !== null && menuPriceCents
      ? ingredientCents / menuPriceCents
      : null

  return {
    id: recipe.id,
    title: recipe.title,
    publicId: recipe.publicId,
    code: recipe.code,
    kind,
    status: recipe.status,
    categoryId: recipe.categoryId,
    category: recipe.category,
    updatedAt: recipe.updatedAt,
    ingredientCents,
    menuPriceCents,
    foodCost,
    overTarget: foodCost !== null && foodCost > foodCostTarget,
    suffix: unit?.suffix ?? "",
    issues,
    labor:
      breakdown.laborCentsPerBatch === null
        ? null
        : {
            centsPerBatch: Math.round(breakdown.laborCentsPerBatch),
            centsPerPiece: unit
              ? breakdown.laborCentsPerBatch / unit.divisor
              : null,
          },
  }
}
