import type { Metadata } from "next"
import Link from "next/link"

import { LazyImportIngredientsButton } from "@/components/ingredients/lazy-import-ingredients-button"
import { Button } from "@/components/ui/button"
import { EmptyState, PageHeader, PageTitle, Page } from "@/components/ui/page"
import { IngredientsBrowser } from "@/components/ingredients/ingredients-browser"
import { INGREDIENT_BROWSE_ORDERS } from "@/components/ingredients/types"
import { requireUser } from "@/lib/auth-session"
import {
  browseIngredients,
  getIngredientDuplicates,
} from "@/lib/backend/queries"
import { redirectOnInvalidPage } from "@/lib/backend/client"
import {
  archiveStatusParam,
  parseArchiveStatusFilter,
  parseBrowseParams,
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
  // The session check runs beside the reads, not ahead of them: a signed-out
  // reader is redirected before any result is awaited.
  const user = requireUser()
  const params = await searchParams
  const { query, page, order } = parseBrowseParams(
    params,
    INGREDIENT_BROWSE_ORDERS
  )
  const status = parseArchiveStatusFilter(singleSearchParam(params.status))
  const statusParam = archiveStatusParam(status)
  let result
  let duplicateSuggestions
  try {
    // Both reads go out together; the duplicate scan never waits on the page.
    const reads = Promise.all([
      browseIngredients({
        page,
        limit: 50,
        q: query,
        order,
        status: statusParam,
      }),
      getIngredientDuplicates(),
    ])
    reads.catch(() => undefined)
    await user
    ;[result, duplicateSuggestions] = await reads
  } catch (cause) {
    redirectOnInvalidPage(cause, "/ingredients", {
      page,
      q: query,
      order,
      filters: { status: statusParam },
    })
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
