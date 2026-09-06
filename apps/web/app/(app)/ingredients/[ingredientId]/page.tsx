import { redirect } from "next/navigation"

export default async function IngredientPage({
  params,
}: {
  params: Promise<{ ingredientId: string }>
}) {
  const { ingredientId } = await params
  redirect(`/ingredients/${ingredientId}/ingredient`)
}
