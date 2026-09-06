import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { RecipeChrome } from "@/components/recipes/recipe-chrome"
import { Page } from "@/components/ui/page"
import { requireUser } from "@/lib/auth-session"
import { getRecipe } from "@/lib/backend/queries"

export const metadata: Metadata = { title: "Recipe" }

export default async function RecipeLayout({
  params,
  children,
}: {
  params: Promise<{ recipeId: string }>
  children: React.ReactNode
}) {
  const { recipeId } = await params
  const [, recipe] = await Promise.all([requireUser(), getRecipe(recipeId)])
  if (!recipe) notFound()
  const owner = recipe.permission === "owner"

  return (
    <Page>
      <RecipeChrome
        id={recipe.id}
        title={recipe.title}
        publicId={recipe.publicId}
        status={recipe.status}
        ownerName={recipe.ownerName ?? ""}
        shares={recipe.shares}
        guestLinks={recipe.guestLinks}
        bookLinks={recipe.bookLinks}
        canEdit={recipe.canEdit ?? owner}
        // Inviting and revoking stay the owner's, however wide edit goes.
        canShare={owner}
        canDelete={recipe.canDelete ?? owner}
        canViewCost={recipe.canViewCost ?? false}
      >
        {children}
      </RecipeChrome>
    </Page>
  )
}
