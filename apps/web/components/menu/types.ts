// Plain module: the server page imports these, and values exported from a
// "use client" file arrive there as client references, not arrays.
export const PRODUCT_BROWSE_ORDERS = [
  "name",
  "-name",
  "sku",
  "-sku",
  "category",
  "-category",
  "price",
  "-price",
  "updatedAt",
  "-updatedAt",
] as const

export const PRODUCT_STATUSES = ["active", "inactive"] as const

export type ProductStatusFilter = (typeof PRODUCT_STATUSES)[number]

/** Active is the list's resting state; `all` is the one way to widen it. */
export function parseProductStatusFilter(
  status?: string
): ProductStatusFilter | null {
  if (status === "inactive") return "inactive"
  if (status === "all") return null
  return "active"
}
