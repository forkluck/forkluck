/**
 * A tenant-owned editable document — anything the kitchen authors and saves —
 * leads with the most recently changed row. Reference data (the catalog) keeps
 * alphabetical order. Mirrors `DOCUMENT_DEFAULT_ORDER` in the backend's
 * `domains/shared/pagination.py`.
 */
export const DOCUMENT_DEFAULT_ORDER = "-updatedAt"

export type Pagination = {
  page: number
  limit: number
  pages: number
  total: number
  next: number | null
  prev: number | null
}

/** Ghost-style metadata envelope shared by every paginated browse response. */
export type PageMeta = {
  pagination: Pagination
}

export type BrowseResult<T> = {
  items: T[]
  meta: PageMeta
}

export type BrowseQuery = {
  page?: number
  limit?: number
  q?: string
  order?: string
  filters?: Readonly<Record<string, string | null | undefined>>
}

/**
 * One query builder for all server-side browse reads. Empty/default values are
 * omitted so copied URLs stay short and stable.
 */
export function browseSearchParams(query: BrowseQuery = {}): URLSearchParams {
  const params = new URLSearchParams()
  if (query.page && query.page > 1) params.set("page", String(query.page))
  if (query.limit) params.set("limit", String(query.limit))
  if (query.q?.trim()) params.set("q", query.q.trim())
  if (query.order) params.set("order", query.order)
  for (const [key, value] of Object.entries(query.filters ?? {})) {
    if (value) params.set(key, value)
  }
  return params
}

export function browsePath(path: string, query: BrowseQuery = {}): string {
  const params = browseSearchParams(query)
  return params.size ? `${path}?${params}` : path
}

export function singleSearchParam(
  value: string | string[] | undefined
): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function positivePage(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 1
  const page = Number(value)
  return Number.isSafeInteger(page) && page > 0 ? page : 1
}

export function allowedSearchParam<const Value extends string>(
  value: string | undefined,
  allowed: readonly Value[],
  fallback: Value
): Value {
  return allowed.includes(value as Value) ? (value as Value) : fallback
}

/**
 * What every list page reads off its URL: the search text, the page number
 * and the sort, each normalized. Every browse order list carries the
 * document default, which is why it can stand in as the fallback.
 */
export function parseBrowseParams<const Order extends string>(
  params: Record<string, string | string[] | undefined>,
  orders: readonly Order[]
): { query: string; page: number; order: Order } {
  return {
    query: (singleSearchParam(params.q) ?? "").trim().slice(0, 200),
    page: positivePage(singleSearchParam(params.page)),
    order: allowedSearchParam(
      singleSearchParam(params.order),
      orders,
      DOCUMENT_DEFAULT_ORDER as Order
    ),
  }
}

/** Recipes, ingredients and supplies share one status vocabulary. */
export type ArchiveStatusFilter = "active" | "archived" | null

/** Absent means active only; "all" drops the filter. */
export function parseArchiveStatusFilter(status?: string): ArchiveStatusFilter {
  if (status === "archived") return "archived"
  if (status === "all") return null
  return "active"
}

/**
 * The filter as it travels: active is the list's resting state, so only the
 * two widening choices go in a URL or to the backend.
 */
export function archiveStatusParam(
  status: ArchiveStatusFilter
): "archived" | "all" | undefined {
  return status === "archived"
    ? "archived"
    : status === null
      ? "all"
      : undefined
}
