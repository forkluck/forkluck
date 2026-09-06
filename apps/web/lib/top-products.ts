import type { SalesOverview } from "./backend/types"

export type TopProduct = {
  id: string
  name: string
  quantity: number
  netSalesCents: number
  /** A bundle in the including-bundles view: the money is on its members. */
  sharedToMembers: boolean
}

/**
 * Apply the live provider filter to the period aggregate and combine channels
 * by product only when "All" is selected.
 */
export function topProducts(
  productSales: SalesOverview["topProducts"],
  channel: "all" | "square" | "shopify",
  limit = 5
): TopProduct[] {
  const totals = new Map<string, TopProduct>()

  for (const row of productSales) {
    if (channel !== "all" && row.channel !== channel) continue
    const name = row.productName.trim()
    if (!name) continue
    const current = totals.get(row.productId) ?? {
      id: row.productId,
      name,
      quantity: 0,
      netSalesCents: 0,
      sharedToMembers: false,
    }
    current.quantity += row.quantity
    // One channel row is enough to mark the fold: a box shares its money in
    // every channel it sells through.
    current.sharedToMembers ||= row.sharedToMembers
    // Count-only manual rows carry no comparable revenue; keep their quantity
    // in the product view while leaving the money aggregate neutral.
    if (row.netSalesCents !== null) {
      current.netSalesCents += row.netSalesCents
    }
    totals.set(row.productId, current)
  }

  return Array.from(totals.values())
    .sort(
      (left, right) =>
        right.netSalesCents - left.netSalesCents ||
        left.name.localeCompare(right.name)
    )
    .slice(0, limit)
}
