import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { GuestRecipeView } from "@/components/recipes/guest-recipe-view"
import { getGuestRecipe } from "@/lib/backend/queries"

// Outside the (app) group on purpose: a guest has no session to gate on.
// A share link is the whole credential: keep it out of search indexes and out
// of the Referer header any link the reader follows next would carry.
export const metadata: Metadata = {
  title: "Shared recipe",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
}

export default async function SharedRecipePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const recipe = await getGuestRecipe(token)
  if (!recipe) notFound()

  return <GuestRecipeView recipe={recipe} />
}
