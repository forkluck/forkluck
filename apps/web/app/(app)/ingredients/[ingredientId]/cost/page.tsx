import { notFound, redirect } from "next/navigation"

import { IngredientCostPanel } from "@/components/ingredients/ingredient-panels"
import { getIngredient } from "@/lib/backend/queries"

export default async function IngredientCostPage({
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

  return <IngredientCostPanel ingredient={ingredient} />
}
