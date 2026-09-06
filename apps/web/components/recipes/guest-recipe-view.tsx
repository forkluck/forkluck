"use client"

import { GuestPage } from "@/components/recipes/guest-page"
import { RecipeSheet } from "@/components/recipes/recipe-sheet"
import type { GuestRecipe } from "@/lib/backend/types"

/**
 * A shared recipe as a guest reads it: who sent it, then the sheet itself on
 * the guest page's chrome.
 */
export function GuestRecipeView({ recipe }: { recipe: GuestRecipe }) {
  return (
    <GuestPage>
      <div className="grid gap-2">
        <h1 className="text-3xl leading-tight font-semibold tracking-[-0.01em]">
          {recipe.title}
        </h1>
        <p className="text-base text-muted-foreground">
          Shared by {recipe.ownerName}
        </p>
        {recipe.description ? (
          <p className="mt-2 text-md">{recipe.description}</p>
        ) : null}
        {recipe.role === "editor" ? (
          <p className="mt-2 text-md">
            You&apos;re invited to edit this recipe. Create an account with the
            address this link was sent to and it will be waiting in your
            kitchen.
          </p>
        ) : null}
      </div>
      <RecipeSheet recipe={recipe} />
    </GuestPage>
  )
}
