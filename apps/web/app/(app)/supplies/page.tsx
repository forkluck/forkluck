import type { Metadata } from "next"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { EmptyState, PageHeader, PageTitle, Page } from "@/components/ui/page"
import { IngredientsBrowser } from "@/components/ingredients/ingredients-browser"
import { INGREDIENT_BROWSE_ORDERS } from "@/components/ingredients/types"
import { requireUser } from "@/lib/auth-session"
import { browseIngredients } from "@/lib/backend/queries"
import { redirectOnInvalidPage } from "@/lib/backend/client"
import {
  archiveStatusParam,
  parseArchiveStatusFilter,
  parseBrowseParams,
  singleSearchParam,
} from "@/lib/backend/pagination"

export const metadata: Metadata = {
  title: "Supplies",
}

export default async function SuppliesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // The session check runs beside the read, not ahead of it; see ingredients.
  const user = requireUser()
  const params = await searchParams
  const { query, page, order } = parseBrowseParams(
    params,
    INGREDIENT_BROWSE_ORDERS
  )
  const status = parseArchiveStatusFilter(singleSearchParam(params.status))
  const statusParam = archiveStatusParam(status)
  let result
  try {
    const read = browseIngredients({
      page,
      limit: 50,
      q: query,
      order,
      status: statusParam,
      kind: "supply",
    })
    read.catch(() => undefined)
    await user
    result = await read
  } catch (cause) {
    redirectOnInvalidPage(cause, "/supplies", {
      page,
      q: query,
      order,
      filters: { status: statusParam },
    })
  }
  return (
    <Page>
      <PageHeader>
        <PageTitle>Supplies</PageTitle>
      </PageHeader>

      {!result.hasAnyIngredient ? (
        /* Empty state: one bordered card, no toolbar above it — there is
           nothing yet to search or act on. */
        <EmptyState
          title="Track your packaging"
          description="Cartons, bags, ribbon — anything you buy but never eat. Price it the way you buy it and a product can carry its cost."
        >
          <Button nativeButton={false} render={<Link href="/supplies/new" />}>
            Add supply
          </Button>
        </EmptyState>
      ) : (
        <IngredientsBrowser
          result={result}
          kind="supply"
          query={query}
          order={order}
          status={status}
        />
      )}
    </Page>
  )
}
