"use client"

import { RecipesTable } from "@/components/recipes/recipes-table"
import type { RecipeStatusFilter } from "@/components/recipes/types"
import { BrowsePagination } from "@/components/ui/browse-pagination"
import { useBrowseUrl } from "@/hooks/use-browse-url"
import type { Pagination } from "@/lib/backend/pagination"
import type { CurrencyCode } from "@/lib/business-settings"
import type { RecipeHealth } from "@/lib/recipe/health"

export function RecipesBrowser({
  rows,
  pagination,
  currencyCode,
  query,
  order,
  status,
  canCreate = true,
}: {
  rows: RecipeHealth[]
  pagination: Pagination
  currencyCode: CurrencyCode
  query: string
  order: string
  status: RecipeStatusFilter
  /** A viewer in someone else's kitchen adds nothing to it. */
  canCreate?: boolean
}) {
  const browse = useBrowseUrl({ query })

  return (
    <RecipesTable
      rows={rows}
      currencyCode={currencyCode}
      status={status}
      canCreate={canCreate}
      onStatusChange={(value) => browse.setFilter("status", value)}
      remote={{
        searchValue: browse.searchValue,
        onSearchValueChange: browse.onSearchValueChange,
        searchPending: browse.isPending,
        order,
        sortColumns: {
          recipe: { asc: "name", desc: "-name" },
          category: { asc: "category", desc: "-category" },
          updated: { asc: "updatedAt", desc: "-updatedAt" },
        },
        onOrderChange: browse.setOrder,
      }}
      footer={
        <BrowsePagination
          pagination={pagination}
          pending={browse.isPending}
          onPageChange={browse.setPage}
        />
      }
    />
  )
}
