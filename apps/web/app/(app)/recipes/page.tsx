import type { Metadata } from "next"
import Link from "next/link"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { EmptyState, PageHeader, PageTitle, Page } from "@/components/ui/page"
import { RecipesBrowser } from "@/components/recipes/recipes-browser"
import { RECIPE_BROWSE_ORDERS } from "@/components/recipes/types"
import { NoticeBanner, NoticeBannerAction } from "@/components/ui/notice-banner"
import { getSession } from "@/lib/auth-session"
import { redirectOnInvalidPage } from "@/lib/backend/client"
import { browseRecipeHealth } from "@/lib/backend/queries"
import { recipeCapNotice } from "@/lib/billing"
import { KITCHEN_COOKIE, resolveActiveKitchen } from "@/lib/kitchen"
import {
  archiveStatusParam,
  parseArchiveStatusFilter,
  parseBrowseParams,
  singleSearchParam,
} from "@/lib/backend/pagination"

export const metadata: Metadata = {
  title: "Recipes",
}

export default async function RecipesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await getSession()
  if (!session) redirect("/login")
  const kitchen = resolveActiveKitchen(
    session,
    (await cookies()).get(KITCHEN_COOKIE)?.value
  )
  // The cap is the owner's business; a member never sees it, and the recipes
  // they create count against the owner's plan, not their own.
  const capNotice = kitchen ? null : recipeCapNotice(session.billing)
  const canCreate = !kitchen || kitchen.role === "editor"
  const params = await searchParams
  const { query, page, order } = parseBrowseParams(params, RECIPE_BROWSE_ORDERS)
  const status = parseArchiveStatusFilter(singleSearchParam(params.status))
  let result
  try {
    result = await browseRecipeHealth({
      page,
      limit: 50,
      q: query,
      order,
      // The kitchen is a session fact, not a view: it stays out of the URL so
      // a copied link keeps working for whoever opens it.
      filters: { status, kitchen: kitchen?.ownerId ?? null },
    })
  } catch (cause) {
    redirectOnInvalidPage(cause, "/recipes", {
      page,
      q: query,
      order,
      filters: { status: archiveStatusParam(status) },
    })
  }
  return (
    <Page>
      <PageHeader>
        <PageTitle>Recipes</PageTitle>
      </PageHeader>

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

      {!result.hasAnyRecipe ? (
        <EmptyState
          title={
            kitchen
              ? `No recipes in ${kitchen.ownerName}’s kitchen`
              : "No recipes yet"
          }
          description={
            kitchen
              ? "Recipes the owner adds show up here."
              : "Build an ordered recipe from pantry ingredients, other recipes, preparation steps, yields, and kitchen notes."
          }
        >
          {canCreate ? (
            <Link href="/recipes/new" className={cn(buttonVariants())}>
              Add recipe
            </Link>
          ) : null}
        </EmptyState>
      ) : (
        <RecipesBrowser
          rows={result.items}
          pagination={result.meta.pagination}
          currencyCode={result.currencyCode}
          query={query}
          order={order}
          status={status}
          canCreate={canCreate}
        />
      )}
    </Page>
  )
}
