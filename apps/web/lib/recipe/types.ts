export type RecipeCategory = "bread" | "cake" | "sauce" | "general"

export type RecipeIngredientInput = {
  id: string
  name: string
  grams: number
  /**
   * True when the line is another recipe used as a component rather than a
   * pantry or catalog ingredient. A component's title can collide with a
   * built-in profile name — a component recipe called `Honey` is not raw
   * honey — so the analysis never matches it to a profile and counts it as
   * unmapped instead of silently borrowing another ingredient's macros.
   */
  isComponent?: boolean
  /** Verified composition attached to the resolved pantry/component identity. */
  nutritionPer100g?: NutritionComposition | null
}

export type SolidKey =
  "fat" | "protein" | "sugars" | "starch" | "fiber" | "salt" | "other"

export type CompositionValues = Record<SolidKey, number>

export type NutritionComposition = CompositionValues & {
  water: number
  /** Original total carbohydrate from the selected nutrient record. */
  totalCarbohydrate?: number
  /** Original sodium amount in milligrams per 100 g. */
  sodiumMg?: number
  /** Saturated fat per 100 g, when the source record reports it; null or
   * absent means unknown, which the analysis reads as zero. */
  saturatedFat?: number | null
}

export type NutritionTotals = NutritionComposition & {
  totalCarbohydrate: number
  sodiumMg: number
  saturatedFat: number
}

export type IngredientRole =
  "flour" | "hydration" | "fat" | "sweetener" | "salt" | "other"

export type IngredientProfile = {
  key: string
  name: string
  aliases: string[]
  role: IngredientRole
  water: number
  solids: CompositionValues
}

export type SignalStatus = "balanced" | "watch" | "outside" | "unknown"

export type RecipeSignal = {
  key: "hydration" | "fat" | "sugar" | "salt"
  label: string
  value: number | null
  unit: string
  status: SignalStatus
  position: number
  scaleMin: number
  scaleMax: number
  targetMin: number
  targetMax: number
  targetStart: number
  targetEnd: number
  summary: string
  basis: string
}

export type SolidSlice = {
  key: SolidKey
  label: string
  grams: number
  percentOfDryMatter: number
  color: string
}

export type MatchedIngredient = {
  id: string
  inputName: string
  canonicalName: string
  grams: number
  profileKey: string
}

export type UnknownIngredient = {
  id: string
  name: string
  grams: number
}

export type RecipeAnalysis = {
  totalMassG: number
  knownMassG: number
  coveragePercent: number
  waterG: number
  waterPercent: number
  dryMatterG: number
  dryMatterPercent: number
  flourMassG: number
  solids: SolidSlice[]
  /** Nutrient mass contributed by mapped ingredients in the entire batch. */
  nutritionTotals: NutritionTotals
  per100g: {
    water: number
    dryMatter: number
    fat: number
    protein: number
    sugars: number
    starch: number
    fiber: number
    salt: number
    other: number
  }
  signals: RecipeSignal[]
  matchedIngredients: MatchedIngredient[]
  unknownIngredients: UnknownIngredient[]
  caveats: string[]
}

export type RecipeDraft = {
  title: string
  servings: number
  ingredients: RecipeIngredientInput[]
  method: string
}
