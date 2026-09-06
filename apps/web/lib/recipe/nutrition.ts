import type { RecipeAnalysis } from "./types"

/**
 * A rough macronutrient panel derived from {@link analyzeRecipe}. Energy uses
 * general 4/4/9/2 kcal and 17/17/37/8 kJ conversion factors, so every figure is
 * a kitchen-planning estimate, never a regulated nutrition label.
 */
export type RecipeNutritionMacros = {
  energyKcal: number
  energyKj: number
  protein: number
  /** Total carbohydrate from the source record, including fibre. */
  totalCarbohydrate: number
  /** Available carbohydrate: total carbohydrate less fibre. */
  availableCarbohydrate: number
  sugars: number
  fat: number
  /** Saturated fat, counted only from source records that report it. */
  saturatedFat: number
  fiber: number
  sodiumMg: number
  salt: number
}

export type RecipeNutritionBasis = {
  /** Finished pieces in the batch, when yield is declared in pieces. */
  portions?: number | null
  /** Finished batch mass, when yield is declared as a weight. */
  finishedWeightG?: number | null
  /** Ingredient-shaped lines that could not be converted to a weight. */
  unweighedIngredientCount?: number
}

export type RecipeNutritionFacts = {
  /** Estimated composition per 100 g of the mapped ingredients. */
  per100g: RecipeNutritionMacros
  /** Estimated composition per portion, or null without a piece yield. */
  perPortion: RecipeNutritionMacros | null
  /**
   * Share of the weighed batch that mapped to a known ingredient. Held below
   * 100 while any ingredient is unmapped, so a rounding artifact — 99.96% from
   * a 0.4 g unknown in a 1 kg batch — never reads as complete coverage.
   */
  coveragePercent: number
  /**
   * Ingredients not reflected in the estimate: weighed lines with no nutrition
   * mapping, plus ingredient lines that resolved to no weight at all.
   */
  unknownCount: number
  /**
   * Ingredient-shaped lines that resolved to no gram weight (for example, a
   * volume of an ingredient with no density mapping). They never reach the
   * analyzed batch, so the estimate cannot span them.
   */
  unweighedIngredientCount: number
  /**
   * True only when the estimate spans the whole batch — every ingredient line
   * is both weighed and mapped. Derived from the absence of unmapped and
   * unweighed lines rather than the rounded coverage figure, so a line too
   * light to move the percentage still withholds the whole-batch claim.
   */
  coversWholeBatch: boolean
  /** Portion count the per-portion column divides by, when known. */
  portions: number | null
  /** Weight represented by one portion; raw/as-formulated without weight yield. */
  portionWeightG: number | null
  /** Weight used for the per-100 g denominator. */
  basisWeightG: number
  /** Whether a declared finished weight replaced the raw formula weight. */
  usesFinishedYield: boolean
  /** False when nothing mapped, so there is no honest estimate to show. */
  hasData: boolean
}

// General conversion factors. Carbohydrate is the available carbohydrate;
// fibre contributes separately so it is not double counted.
const KCAL_PER_G_PROTEIN = 4
const KCAL_PER_G_CARBOHYDRATE = 4
const KCAL_PER_G_FAT = 9
const KCAL_PER_G_FIBER = 2
const KJ_PER_G_PROTEIN = 17
const KJ_PER_G_CARBOHYDRATE = 17
const KJ_PER_G_FAT = 37
const KJ_PER_G_FIBER = 8

function round(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

/** Estimated food energy for a set of macro grams, in kcal. */
export function generalEnergyKcal(macros: {
  protein: number
  carbohydrate: number
  fat: number
  fiber: number
}): number {
  return (
    KCAL_PER_G_PROTEIN * macros.protein +
    KCAL_PER_G_CARBOHYDRATE * macros.carbohydrate +
    KCAL_PER_G_FAT * macros.fat +
    KCAL_PER_G_FIBER * macros.fiber
  )
}

/** Estimated food energy for a set of macro grams, in kJ. */
export function generalEnergyKj(macros: {
  protein: number
  carbohydrate: number
  fat: number
  fiber: number
}): number {
  return (
    KJ_PER_G_PROTEIN * macros.protein +
    KJ_PER_G_CARBOHYDRATE * macros.carbohydrate +
    KJ_PER_G_FAT * macros.fat +
    KJ_PER_G_FIBER * macros.fiber
  )
}

function macrosFromComposition(
  composition: Pick<
    RecipeAnalysis["nutritionTotals"],
    | "protein"
    | "sugars"
    | "fat"
    | "fiber"
    | "salt"
    | "totalCarbohydrate"
    | "sodiumMg"
    | "saturatedFat"
  >,
  factor: number
): RecipeNutritionMacros {
  const protein = composition.protein * factor
  const totalCarbohydrate = composition.totalCarbohydrate * factor
  const availableCarbohydrate = Math.max(
    0,
    totalCarbohydrate - composition.fiber * factor
  )
  const fat = composition.fat * factor
  const fiber = composition.fiber * factor
  const energyInputs = {
    protein,
    carbohydrate: availableCarbohydrate,
    fat,
    fiber,
  }
  return {
    energyKcal: Math.round(generalEnergyKcal(energyInputs)),
    energyKj: Math.round(generalEnergyKj(energyInputs)),
    protein: round(protein),
    totalCarbohydrate: round(totalCarbohydrate),
    availableCarbohydrate: round(availableCarbohydrate),
    sugars: round(composition.sugars * factor),
    fat: round(fat),
    saturatedFat: round(composition.saturatedFat * factor),
    fiber: round(fiber),
    sodiumMg: round(composition.sodiumMg * factor, 1),
    salt: round(composition.salt * factor, 2),
  }
}

/**
 * Fold a recipe analysis into a per-100 g and (when a piece yield is known)
 * per-portion macro panel. Per-portion divides the mapped batch evenly across
 * portions, so both columns are scale-invariant and describe only the mapped
 * ingredients; the caller surfaces `coveragePercent`/`unknownCount` alongside.
 *
 * `unweighedIngredientCount` reports ingredient-shaped lines the parser could
 * not resolve to grams (its `unresolvedLines`, plus any unconvertible skipped
 * lines). They are absent from `analysis`, so folding their count in here keeps
 * the panel from claiming whole-batch coverage while silently dropping them.
 */
export function recipeNutritionFacts(
  analysis: RecipeAnalysis,
  basis: RecipeNutritionBasis = {}
): RecipeNutritionFacts {
  const portions = basis.portions && basis.portions > 0 ? basis.portions : null
  const finishedWeightG =
    basis.finishedWeightG && basis.finishedWeightG > 0
      ? basis.finishedWeightG
      : null
  const basisWeightG = finishedWeightG ?? analysis.totalMassG
  const portionFactor =
    portions && portions > 0 && analysis.knownMassG > 0 ? 1 / portions : null
  const unweighed = Math.max(0, Math.trunc(basis.unweighedIngredientCount ?? 0))
  const unmapped = analysis.unknownIngredients.length
  // Completeness follows the unmapped and unweighed lines, not the rounded
  // percentage: 1000 g of sugar beside 0.4 g of an unknown powder rounds to
  // 100% coverage, and reading that as whole-batch would hide the unknown.
  const coversWholeBatch = unmapped === 0 && unweighed === 0
  return {
    // Unknown ingredients contribute zero known nutrients but remain in the
    // denominator. This makes partial data a lower bound for the whole recipe,
    // never a claim that the mapped sliver is the complete food.
    per100g: macrosFromComposition(
      analysis.nutritionTotals,
      basisWeightG > 0 ? 100 / basisWeightG : 0
    ),
    perPortion:
      portionFactor !== null
        ? macrosFromComposition(analysis.nutritionTotals, portionFactor)
        : null,
    // An unmapped line that rounds away still leaves the batch uncovered, so
    // the readout is held at 99% rather than claiming a whole 100%.
    coveragePercent:
      unmapped > 0
        ? Math.min(analysis.coveragePercent, 99)
        : analysis.coveragePercent,
    unknownCount: unmapped + unweighed,
    unweighedIngredientCount: unweighed,
    coversWholeBatch,
    portions,
    portionWeightG:
      portions !== null && basisWeightG > 0 ? basisWeightG / portions : null,
    basisWeightG,
    usesFinishedYield: finishedWeightG !== null,
    hasData: analysis.knownMassG > 0,
  }
}
