"use client"

import { IngredientsTable } from "@/components/ingredients/ingredients-table"
import type {
  IngredientKind,
  IngredientStatusFilter,
} from "@/components/ingredients/types"
import { BrowsePagination } from "@/components/ui/browse-pagination"
import { useBrowseUrl } from "@/hooks/use-browse-url"
import type { DuplicateSuggestion } from "@/lib/ingredient-insights"
import type { BrowseResult } from "@/lib/backend/pagination"
import type { IngredientSummary } from "@/lib/backend/types"

export function IngredientsBrowser({
  result,
  duplicateSuggestions,
  kind,
  query,
  order,
  status,
}: {
  result: BrowseResult<IngredientSummary>
  duplicateSuggestions?: DuplicateSuggestion[]
  kind?: IngredientKind
  query: string
  order: string
  status: IngredientStatusFilter
}) {
  const browse = useBrowseUrl({ query })

  return (
    <IngredientsTable
      ingredients={result.items}
      duplicateSuggestions={duplicateSuggestions}
      kind={kind}
      status={status}
      onStatusChange={(value) => browse.setFilter("status", value)}
      remote={{
        searchValue: browse.searchValue,
        onSearchValueChange: browse.onSearchValueChange,
        searchPending: browse.isPending,
        order,
        sortColumns: {
          ingredient: { asc: "name", desc: "-name" },
          updated: { asc: "updatedAt", desc: "-updatedAt" },
        },
        onOrderChange: browse.setOrder,
      }}
      footer={
        <BrowsePagination
          pagination={result.meta.pagination}
          pending={browse.isPending}
          onPageChange={browse.setPage}
        />
      }
    />
  )
}
