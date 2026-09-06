import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"

import { LazyImportIngredientsButton } from "@/components/ingredients/lazy-import-ingredients-button"
import { Button } from "@/components/ui/button"
import { EmptyState, PageHeader, PageTitle, Page } from "@/components/ui/page"
import { IngredientsBrowser } from "@/components/ingredients/ingredients-browser"
import {
  INGREDIENT_BROWSE_ORDERS,
  parseIngredientStatusFilter,
} from "@/components/ingredients/types"
import { requireUser } from "@/lib/auth-session"
import {
  browseIngredients,
  getIngredientDuplicates,
} from "@/lib/backend/queries"
import { BackendRequestError } from "@/lib/backend/client"
import {
  DOCUMENT_DEFAULT_ORDER,
  allowedSearchParam,
  browsePath,
  positivePage,
  singleSearchParam,
} from "@/lib/backend/pagination"

export const metadata: Metadata = {
  title: "Ingredients",
}

export default async function IngredientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireUser()
  const params = await searchParams
  const query = (singleSearchParam(params.q) ?? "").trim().slice(0, 200)
  const page = positivePage(singleSearchParam(params.page))
  const order = allowedSearchParam(
    singleSearchParam(params.order),
    INGREDIENT_BROWSE_ORDERS,
    DOCUMENT_DEFAULT_ORDER
  )
  const status = parseIngredientStatusFilter(singleSearchParam(params.status))
  // The backend shows active rows when `status` is absent, so only the two
  // widening choices travel.
  const statusParam =
    status === "archived" ? "archived" : status === null ? "all" : undefined
  let result
  let duplicateSuggestions
  try {
    // Both reads go out together; the duplicate scan never waits on the page.
    ;[result, duplicateSuggestions] = await Promise.all([
      browseIngredients({
        page,
        limit: 50,
        q: query,
        order,
        status: statusParam,
      }),
      getIngredientDuplicates(),
    ])
  } catch (cause) {
    if (
      page > 1 &&
      cause instanceof BackendRequestError &&
      cause.status === 400 &&
      cause.message === "Invalid page"
    ) {
      redirect(
        browsePath("/ingredients", {
          q: query,
          order: order === DOCUMENT_DEFAULT_ORDER ? undefined : order,
          filters: { status: statusParam },
        })
      )
    }
    throw cause
  }
  return (
    <Page>
      <PageHeader>
        <PageTitle>Ingredients</PageTitle>
      </PageHeader>

      {!result.hasAnyIngredient ? (
        /* Empty state: one bordered card, no toolbar above it — there is
           nothing yet to search or act on. */
        <EmptyState
          title="Price your pantry"
          description="Add each ingredient the way you buy it, with its pack size and pack price. Import a purchase report to bring in supplier packs and keep their prices current."
        >
          <Button
            nativeButton={false}
            render={<Link href="/ingredients/new" />}
          >
            Add ingredient
          </Button>
          <LazyImportIngredientsButton />
        </EmptyState>
      ) : (
        <IngredientsBrowser
          result={result}
          duplicateSuggestions={duplicateSuggestions}
          query={query}
          order={order}
          status={status}
        />
      )}
    </Page>
  )
}
