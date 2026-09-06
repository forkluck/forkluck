import { notFound } from "next/navigation"

import { IngredientPanel } from "@/components/ingredients/ingredient-panels"
import {
  getIngredient,
  getIngredientTags,
  getIngredientCategories,
} from "@/lib/backend/queries"

export default async function IngredientTabPage({
  params,
}: {
  params: Promise<{ ingredientId: string }>
}) {
  const { ingredientId } = await params
  const [ingredient, availableTags, categories] = await Promise.all([
    getIngredient(ingredientId),
    getIngredientTags(),
    getIngredientCategories(),
  ])
  if (!ingredient) notFound()

  return (
    <IngredientPanel
      ingredient={ingredient}
      availableTags={availableTags}
      categoryOptions={categories.map((category) => category.name)}
    />
  )
}
