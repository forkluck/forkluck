import { notFound, redirect } from "next/navigation"

import { IngredientNutritionPanel } from "@/components/ingredients/ingredient-nutrition-panel"
import { getIngredient } from "@/lib/backend/queries"

export default async function IngredientNutritionPage({
  params,
}: {
  params: Promise<{ ingredientId: string }>
}) {
  const { ingredientId } = await params
  const ingredient = await getIngredient(ingredientId)
  if (!ingredient) notFound()
  // A supply is one page; everything it has is on the ingredient tab.
  if (ingredient.nonEdible)
    redirect(`/ingredients/${ingredient.publicId}/ingredient`)

  return <IngredientNutritionPanel ingredient={ingredient} />
}
