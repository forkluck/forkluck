import type { Metadata } from "next"

import { SalesMappingTabs } from "@/components/integrations/sales-mapping-tabs"
import { MenuReview, type CatalogTab } from "@/components/menu/menu-review"
import { requireUser } from "@/lib/auth-session"
import { getMenuOverview } from "@/lib/backend/queries"
import { singleSearchParam } from "@/lib/backend/pagination"

export const metadata: Metadata = { title: "Catalog" }

export default async function SalesMappingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireUser()
  const params = await searchParams
  const query = (singleSearchParam(params.q) ?? "").trim().slice(0, 200)
  const rawTab = singleSearchParam(params.tab) ?? "review"
  const tab: CatalogTab = (
    ["all", "linked", "review", "shopify", "square"] as const
  ).includes(rawTab as CatalogTab)
    ? (rawTab as CatalogTab)
    : "review"
  // `items` feeds the Linked/All tabs and the Track dialog's product picker;
  // catalog renders no per-product sales, so it skips `stats`.
  const overview = await getMenuOverview(["review", "items"], query)

  return (
    <>
      <SalesMappingTabs />
      <MenuReview
        items={overview.review.items}
        categories={overview.review.categories}
        reviewCount={overview.review.reviewCount}
        reviewMatchCount={overview.review.reviewMatchCount}
        query={query}
        tab={tab}
        menuItems={overview.items}
        recipes={overview.recipes}
      />
    </>
  )
}
