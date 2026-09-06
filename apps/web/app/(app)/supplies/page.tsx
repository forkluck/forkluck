import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"

import { Button } from "@/components/ui/button"
import { EmptyState, PageHeader, PageTitle, Page } from "@/components/ui/page"
import { IngredientsBrowser } from "@/components/ingredients/ingredients-browser"
import {
  INGREDIENT_BROWSE_ORDERS,
  parseIngredientStatusFilter,
} from "@/components/ingredients/types"
import { requireUser } from "@/lib/auth-session"
import { browseIngredients } from "@/lib/backend/queries"
import { BackendRequestError } from "@/lib/backend/client"
import {
  DOCUMENT_DEFAULT_ORDER,
  allowedSearchParam,
  browsePath,
  positivePage,
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
  try {
    result = await browseIngredients({
      page,
      limit: 50,
      q: query,
      order,
      status: statusParam,
      kind: "supply",
    })
  } catch (cause) {
    if (
      page > 1 &&
      cause instanceof BackendRequestError &&
      cause.status === 400 &&
      cause.message === "Invalid page"
    ) {
      redirect(
        browsePath("/supplies", {
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
