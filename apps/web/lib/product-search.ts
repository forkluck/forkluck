import { matchesTokens, rankedMatches, searchTokens } from "@/lib/search"
import type { SalesProductRow } from "@/lib/backend/types"

export function productSkus(product: SalesProductRow) {
  return [
    ...new Set(
      product.variants.map((variant) => variant.sku.trim()).filter(Boolean)
    ),
  ]
}

/** A product is searchable by its name and by any SKU linked to it. */
function productFields(product: SalesProductRow): string[] {
  return [product.name, ...productSkus(product)]
}

export function matchesProductSearch(
  product: SalesProductRow,
  query: string
): boolean {
  return matchesTokens(productFields(product), searchTokens(query))
}

/** The product picker's list: what matches, best match first. */
export function rankedProductMatches<T>(
  items: readonly T[],
  product: (item: T) => SalesProductRow,
  query: string
): T[] {
  return rankedMatches(items, (item) => productFields(product(item)), query)
}
