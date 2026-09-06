import type { Metadata } from "next"
import Link from "next/link"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { EmptyState, PageHeader, PageTitle, Page } from "@/components/ui/page"
import { RecipesBrowser } from "@/components/recipes/recipes-browser"
import {
  RECIPE_BROWSE_ORDERS,
  parseRecipeStatusFilter,
} from "@/components/recipes/types"
import { NoticeBanner, NoticeBannerAction } from "@/components/ui/notice-banner"
import { getSession } from "@/lib/auth-session"
import { BackendRequestError } from "@/lib/backend/client"
import { browseRecipeHealth } from "@/lib/backend/queries"
import { recipeCapNotice } from "@/lib/billing"
import { KITCHEN_COOKIE, resolveActiveKitchen } from "@/lib/kitchen"
import {
  DOCUMENT_DEFAULT_ORDER,
  allowedSearchParam,
  browsePath,
  positivePage,
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
  const query = (singleSearchParam(params.q) ?? "").trim().slice(0, 200)
  const page = positivePage(singleSearchParam(params.page))
  const order = allowedSearchParam(
    singleSearchParam(params.order),
    RECIPE_BROWSE_ORDERS,
    DOCUMENT_DEFAULT_ORDER
  )
  const statusParam = singleSearchParam(params.status)
  const status = parseRecipeStatusFilter(statusParam)
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
    if (
      page > 1 &&
      cause instanceof BackendRequestError &&
      cause.status === 400 &&
      cause.message === "Invalid page"
    ) {
      redirect(
        browsePath("/recipes", {
          q: query,
          order: order === DOCUMENT_DEFAULT_ORDER ? undefined : order,
          filters: {
            status:
              statusParam === "all" || statusParam === "archived"
                ? statusParam
                : null,
          },
        })
      )
    }
    throw cause
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
