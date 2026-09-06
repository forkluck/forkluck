import { redirect } from "next/navigation"

export default async function RecipePage({
  params,
}: {
  params: Promise<{ recipeId: string }>
}) {
  const { recipeId } = await params
  redirect(`/recipes/${recipeId}/recipe`)
}
