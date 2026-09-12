import type { Metadata } from "next"
import { cookies } from "next/headers"
import { notFound, redirect } from "next/navigation"

import { RecipeEditor } from "@/components/recipe-editor"
import { RecipeChrome } from "@/components/recipes/recipe-chrome"
import { Page } from "@/components/ui/page"
import { getSession } from "@/lib/auth-session"
import {
  browseRecipes,
  getPricingEntries,
  getRecipeCategories,
} from "@/lib/backend/queries"
import { KITCHEN_COOKIE, resolveActiveKitchen } from "@/lib/kitchen"

export const metadata: Metadata = {
  title: "Add recipe",
}

export default async function NewRecipePage() {
  const [session, sources, browse, categories] = await Promise.all([
    getSession(),
    getPricingEntries(),
    browseRecipes(),
    getRecipeCategories(),
  ])
  if (!session) redirect("/login")
  const kitchen = resolveActiveKitchen(
    session,
    (await cookies()).get(KITCHEN_COOKIE)?.value
  )
  // A viewer has no create screen at all, not a disabled one.
  if (kitchen?.role === "viewer") notFound()
  const tagOptions = browse.facets.tags

  return (
    <Page>
      <RecipeChrome title="New recipe">
        <RecipeEditor
          initial={null}
          sources={sources}
          tagOptions={tagOptions}
          currentUserId={session.user.id}
          ownerId={kitchen?.ownerId}
          categoryOptions={categories.map((category) => category.name)}
        />
      </RecipeChrome>
    </Page>
  )
}
