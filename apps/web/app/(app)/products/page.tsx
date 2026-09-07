import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { ProductsBrowser } from "@/components/menu/products-browser"
import {
  PRODUCT_BROWSE_ORDERS,
  parseProductStatusFilter,
} from "@/components/menu/types"
import { requireUser } from "@/lib/auth-session"
import { BackendRequestError } from "@/lib/backend/client"
import {
  DOCUMENT_DEFAULT_ORDER,
  allowedSearchParam,
  browsePath,
  positivePage,
  singleSearchParam,
} from "@/lib/backend/pagination"
import { browseMenuItems, getPosConnections } from "@/lib/backend/queries"

export const metadata: Metadata = { title: "Products" }

export default async function MenuPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // The session check runs beside the reads, not ahead of them; see
  // ingredients.
  const user = requireUser()
  const params = await searchParams
  const query = (singleSearchParam(params.q) ?? "").trim().slice(0, 200)
  const page = positivePage(singleSearchParam(params.page))
  const order = allowedSearchParam(
    singleSearchParam(params.order),
    PRODUCT_BROWSE_ORDERS,
    DOCUMENT_DEFAULT_ORDER
  )
  const status = parseProductStatusFilter(singleSearchParam(params.status))
  // The connection lookup only feeds the empty-state hint; a status failure
  // must not take the page down, same as the shell's own lookup. It runs
  // beside the browse rather than after it.
  const connectionsRead = getPosConnections().catch(() => null)
  let result
  try {
    const read = browseMenuItems({
      page,
      limit: 50,
      q: query,
      order,
      filters: { status },
    })
    read.catch(() => undefined)
    await user
    result = await read
  } catch (cause) {
    if (
      page > 1 &&
      cause instanceof BackendRequestError &&
      cause.status === 400 &&
      cause.message === "Invalid page"
    ) {
      redirect(
        browsePath("/products", {
          q: query,
          order: order === DOCUMENT_DEFAULT_ORDER ? undefined : order,
          filters: { status: status ?? "all" },
        })
      )
    }
    throw cause
  }
  const connections = await connectionsRead

  return (
    <ProductsBrowser
      result={result}
      query={query}
      order={order}
      status={status}
      posConnected={connections === null || connections.length > 0}
    />
  )
}
