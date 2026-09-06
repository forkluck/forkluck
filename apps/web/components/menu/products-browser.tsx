"use client"

import { ProductsTable } from "@/components/menu/products-table"
import type { ProductStatusFilter } from "@/components/menu/types"
import { BrowsePagination } from "@/components/ui/browse-pagination"
import { useBrowseUrl } from "@/hooks/use-browse-url"
import type { BrowseResult } from "@/lib/backend/pagination"
import type { SalesProductRow } from "@/lib/backend/types"

export function ProductsBrowser({
  result,
  query,
  order,
  status,
  posConnected,
}: {
  result: BrowseResult<SalesProductRow> & { hasAnyProduct: boolean }
  /** The committed search this page was rendered for. */
  query: string
  order: string
  status: ProductStatusFilter | null
  posConnected?: boolean
}) {
  const browse = useBrowseUrl({ query })

  return (
    <ProductsTable
      rows={result.items}
      hasAnyProduct={result.hasAnyProduct}
      status={status}
      onStatusChange={(value) => browse.setFilter("status", value ?? "all")}
      posConnected={posConnected}
      remote={{
        searchValue: browse.searchValue,
        onSearchValueChange: browse.onSearchValueChange,
        searchPending: browse.isPending,
        order,
        sortColumns: {
          product: { asc: "name", desc: "-name" },
          sku: { asc: "sku", desc: "-sku" },
          category: { asc: "category", desc: "-category" },
          price: { asc: "price", desc: "-price" },
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
