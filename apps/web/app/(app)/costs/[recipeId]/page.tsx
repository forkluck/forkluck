import { redirect } from "next/navigation"

// The labor cost page merged into the recipe page — steps live below the
// ingredients table now. The URL param was the recipe's public id, so old
// links land on the right recipe.
export default async function CostRecipePage({
  params,
}: {
  params: Promise<{ recipeId: string }>
}) {
  const { recipeId } = await params
  redirect(`/recipes/${recipeId}`)
}
