import { notFound } from "next/navigation"

import { RecipeNutritionView } from "@/components/recipes/recipe-nutrition-view"
import { getRecipe, getRecipeNutrition } from "@/lib/backend/queries"

export default async function RecipeNutritionPage({
  params,
}: {
  params: Promise<{ recipeId: string }>
}) {
  const { recipeId } = await params
  const [recipe, nutrition] = await Promise.all([
    getRecipe(recipeId),
    getRecipeNutrition(recipeId),
  ])
  if (!recipe || !nutrition) notFound()

  return (
    <RecipeNutritionView
      recipeId={recipe.id}
      owner={recipe.permission === "owner"}
      canEdit={recipe.canEdit === true}
      recipeTitle={recipe.title}
      nutrition={nutrition}
    />
  )
}
