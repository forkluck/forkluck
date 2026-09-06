export type OverviewRecipe = {
  id: string
  publicId: string
  title: string
  foodCost: number | null
  /** What stops this recipe costing cleanly; the count feeds "N to review". */
  issues: string[]
}

export function averageFoodCost(recipes: OverviewRecipe[]): number | null {
  const values = recipes.flatMap((recipe) =>
    recipe.foodCost === null ? [] : [recipe.foodCost]
  )
  if (values.length === 0) return null
  return values.reduce((total, value) => total + value, 0) / values.length
}
