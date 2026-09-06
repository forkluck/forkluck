import { notFound } from "next/navigation"

import { ProductEditor } from "@/components/menu/product-editor"
import { requireUser } from "@/lib/auth-session"
import {
  getBusinessSettings,
  getMenuSources,
  getProductCategories,
  getProductDetail,
} from "@/lib/backend/queries"
import { localDateKey, resolveDatePreset } from "@/lib/date-presets"
import { dateSearchParam, rangeEndSearchParam } from "@/lib/date-search-param"

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>
  searchParams: Promise<{
    start?: string | string[]
    end?: string | string[]
    view?: string | string[]
  }>
}) {
  const { productId } = await params
  const requested = await searchParams
  await requireUser()
  const settings = await getBusinessSettings()
  // The rail's sales figures are a window, not a lifetime: the same
  // last-30-days preset the Sales tab used before this page absorbed it.
  const fallbackRange = resolveDatePreset(
    "last_30_days",
    localDateKey(settings.timezone)
  )!
  const requestedStart = dateSearchParam(requested.start)
  const requestedEnd = rangeEndSearchParam(requestedStart, requested.end)
  const endWasGiven = requested.end !== undefined
  const range =
    requestedStart && (!endWasGiven || requestedEnd)
      ? { startDate: requestedStart, endDate: requestedEnd ?? requestedStart }
      : fallbackRange
  const salesView = requested.view === "as_sold" ? "asSold" : "expanded"
  const [product, sources, categories] = await Promise.all([
    getProductDetail(productId, range.startDate, range.endDate),
    getMenuSources(),
    getProductCategories(),
  ])
  if (!product) notFound()

  return (
    <ProductEditor
      product={product}
      recipes={sources.recipes}
      ingredients={sources.ingredients}
      products={sources.products}
      categories={categories}
      salesPeriod={range}
      salesView={salesView}
    />
  )
}
