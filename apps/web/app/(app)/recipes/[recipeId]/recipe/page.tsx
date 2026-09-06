import { notFound } from "next/navigation"

import { RecipeEditor } from "@/components/recipe-editor"
import {
  browseRecipes,
  getPricingEntries,
  getRecipe,
  getRecipeCategories,
} from "@/lib/backend/queries"
import { requireUser } from "@/lib/auth-session"

export default async function RecipeTabPage({
  params,
}: {
  params: Promise<{ recipeId: string }>
}) {
  const { recipeId } = await params
  // Four independent reads go out together; only pricing waits, because the
  // recipe says whether this reader may see it.
  const [recipe, browse, categories, user] = await Promise.all([
    getRecipe(recipeId),
    browseRecipes(),
    getRecipeCategories(),
    requireUser(),
  ])
  if (!recipe) notFound()
  const sources = recipe.canViewCost
    ? await getPricingEntries()
    : { items: [], recipes: [] }
  const tagOptions = browse.facets.tags

  return (
    <RecipeEditor
      key={recipe.id}
      initial={recipe}
      sources={sources}
      tagOptions={tagOptions}
      currentUserId={user.id}
      categoryOptions={categories.map((category) => category.name)}
    />
  )
}
