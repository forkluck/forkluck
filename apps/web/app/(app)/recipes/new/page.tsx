import type { Metadata } from "next"
import Link from "next/link"
import { cookies } from "next/headers"
import { notFound, redirect } from "next/navigation"

import { RecipeEditor } from "@/components/recipe-editor"
import { RecipeChrome } from "@/components/recipes/recipe-chrome"
import { NoticeBanner, NoticeBannerAction } from "@/components/ui/notice-banner"
import { Page } from "@/components/ui/page"
import { getSession } from "@/lib/auth-session"
import {
  browseRecipes,
  getPricingEntries,
  getRecipeCategories,
} from "@/lib/backend/queries"
import { recipeCapNotice } from "@/lib/billing"
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
  // In a kitchen the cap being spent is the owner's, and the backend is the
  // one that says so.
  const capNotice = kitchen ? null : recipeCapNotice(session.billing)

  return (
    <Page>
      <RecipeChrome title="New recipe">
        {capNotice ? (
          <NoticeBanner
            action={
              <NoticeBannerAction
                nativeButton={false}
                render={<Link href="/subscribe" />}
              >
                Upgrade
              </NoticeBannerAction>
            }
          >
            {capNotice}
          </NoticeBanner>
        ) : null}
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
